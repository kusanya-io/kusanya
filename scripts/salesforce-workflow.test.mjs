import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolveGitBash } from './git-bash.mjs';

const workflow = readFileSync(
  new URL('../.github/workflows/salesforce-verify.yml', import.meta.url),
  'utf8',
).replaceAll('\r\n', '\n');
// Exercise the actual inline shell guards, not a second copy of their policy.
function shellStep(name) {
  const lines = workflow.split('\n');
  const start = lines.indexOf(`      - name: ${name}`);
  assert.ok(start >= 0, `Missing workflow step: ${name}`);
  let cursor = start + 1;
  while (cursor < lines.length && lines[cursor] !== '        run: |') {
    assert.ok(
      !lines[cursor].startsWith('      - '),
      `Missing shell body: ${name}`,
    );
    cursor += 1;
  }
  assert.ok(cursor < lines.length, `Missing shell body: ${name}`);
  const body = [];
  while (lines[++cursor]?.startsWith('          ')) {
    body.push(lines[cursor].slice(10));
  }
  assert.ok(body.length > 0);
  return body.join('\n');
}

let bash = 'bash';
if (process.platform === 'win32') {
  // Git for Windows supplies Bash; avoid accidentally selecting the WSL launcher.
  const git = spawnSync('where.exe', ['git'], { encoding: 'utf8' });
  assert.equal(
    git.status,
    0,
    'Git for Windows is required for shell-guard tests.',
  );
  bash = resolveGitBash(git.stdout, (path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  });
}
const sha = 'a'.repeat(40);
const fixtures = {
  PR_NUMBER: '3',
  REVIEWED_SHA: sha,
  POLICY_RESULT: 'success',
  POLICY_SHA: sha,
  POLICY_DECISION: 'full-apex',
  BUDGET_ALLOWED: 'true',
  DEFAULT_BRANCH: 'main',
  GITHUB_REPOSITORY: 'kusanya-io/kusanya',
  GITHUB_EVENT_NAME: 'pull_request',
  GITHUB_BASE_REF: 'main',
  GITHUB_REF: 'refs/pull/3/merge',
  FAKE_HEAD: sha,
  FAKE_CHECKOUT: sha,
  FAKE_SOURCE: 'kusanya-io/kusanya',
  FAKE_BASE: 'main',
  FAKE_STATE: 'open',
  SF_DEV_HUB_AUTH_URL: 'synthetic-auth-input-not-a-credential',
  FAKE_AUTH_RESULT: '0',
};
const doubles = `
gh() {
  case "$4" in
    .head.sha) printf '%s\\n' "$FAKE_HEAD" ;;
    .head.repo.full_name) printf '%s\\n' "$FAKE_SOURCE" ;;
    .base.ref) printf '%s\\n' "$FAKE_BASE" ;;
    .state) printf '%s\\n' "$FAKE_STATE" ;;
    *) return 1 ;;
  esac
}
git() { printf '%s\\n' "$FAKE_CHECKOUT"; }
sf() {
  [[ "$#" -eq 9 && "$1" == org && "$2" == login && "$3" == sfdx-url &&
     "$4" == --sfdx-url-stdin && "$5" == - && "$6" == --alias &&
     "$7" == Kusanya-CI-DevHub && "$8" == --set-default-dev-hub && "$9" == --json ]] || return 2
  local payload
  payload="$(cat)"
  [[ "$payload" == synthetic-auth-input-not-a-credential ]] || return 3
  # Simulate a CLI that includes its input in diagnostics; neither stream may leak.
  printf '%s\\n' "$payload"
  printf '%s\\n' "$payload" >&2
  return "$FAKE_AUTH_RESULT"
}
`;
function runStep(name, overrides = {}) {
  const env = { ...process.env, ...fixtures, ...overrides };
  delete env.BASH_ENV;
  delete env.ENV;
  const result = spawnSync(
    bash,
    ['--noprofile', '--norc', '-c', doubles + shellStep(name)],
    { encoding: 'utf8', env, timeout: 10000 },
  );
  assert.ifError(result.error);
  return result;
}

test('Salesforce workflow accepts exact same-repository PR and default-branch dispatch', () => {
  const step = 'Confirm reviewed commit and trusted workflow';
  assert.equal(runStep(step).status, 0);
  assert.equal(
    runStep(step, {
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/main',
    }).status,
    0,
  );
});
test('Salesforce workflow rejects forks, stale heads, closed PRs and invalid event inputs', () => {
  for (const invalid of [
    { PR_NUMBER: '3; echo unsafe' },
    { PR_NUMBER: '0' },
    { REVIEWED_SHA: 'not-a-full-sha' },
    { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_BASE_REF: 'other' },
    { GITHUB_REF: 'refs/pull/4/merge' },
    {
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/feature',
    },
    { FAKE_HEAD: 'b'.repeat(40) },
    { FAKE_SOURCE: 'contributor/fork' },
    { FAKE_BASE: 'other' },
    { FAKE_STATE: 'closed' },
  ]) {
    assert.equal(
      runStep('Confirm reviewed commit and trusted workflow', invalid).status,
      1,
      JSON.stringify(invalid),
    );
  }
});
test('Salesforce authentication guard rejects mismatched checkout and changed head', () => {
  const step = 'Recheck exact head immediately before authentication';
  assert.equal(runStep(step).status, 0);
  assert.equal(runStep(step, { FAKE_CHECKOUT: 'b'.repeat(40) }).status, 1);
  assert.equal(runStep(step, { FAKE_HEAD: 'b'.repeat(40) }).status, 1);
});
test('Salesforce authentication passes the explicit stdin marker and suppresses CLI output', () => {
  const result = runStep(
    'Authenticate dedicated Dev Hub without printing its auth URL',
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});
test('Salesforce authentication fails closed without a secret or after a CLI failure', () => {
  const step = 'Authenticate dedicated Dev Hub without printing its auth URL';
  const missing = runStep(step, { SF_DEV_HUB_AUTH_URL: '' });
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /Missing environment secret/);
  const failed = runStep(step, { FAKE_AUTH_RESULT: '1' });
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /Dev Hub authentication failed/);
  for (const result of [missing, failed]) {
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /synthetic-auth-input-not-a-credential/,
    );
    assert.equal(result.stderr, '');
  }
});
test('Salesforce result guard rejects a head changed during tests', () => {
  const step = 'Reject a stale successful run';
  assert.equal(runStep(step).status, 0);
  assert.equal(runStep(step, { FAKE_HEAD: 'b'.repeat(40) }).status, 1);
});
test('Salesforce required gate rejects skipped, cancelled, failed and absent Apex', () => {
  const step = 'Require exact-head Apex or explicit documentation exemption';
  assert.equal(runStep(step, { APEX_RESULT: 'success' }).status, 0);
  for (const result of ['skipped', 'cancelled', 'failure', '']) {
    assert.equal(runStep(step, { APEX_RESULT: result }).status, 1);
  }
});
test('Salesforce workflow keeps the pinned harness, source guard and unconditional gate', () => {
  assert.match(
    workflow,
    /types: \[opened, synchronize, reopened, ready_for_review\]/,
  );
  assert.match(
    workflow,
    /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
  );
  assert.equal(
    (workflow.match(/ref: 825030ea69bd4c833b6dd2b0f7b3009b82658576/g) ?? [])
      .length,
    2,
  );
  assert.match(workflow, /run: node trusted\/scripts\/verify-salesforce\.mjs/);
  assert.match(workflow, /needs: \[policy, apex\]\n    if: always\(\)/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.ok(
    workflow.indexOf('Recheck exact head immediately before authentication') <
      workflow.indexOf('      - name: Authenticate dedicated Dev Hub'),
  );
});

test('documentation exemption is explicit, exact-head and cannot imply Apex ran', () => {
  const step = 'Require exact-head Apex or explicit documentation exemption';
  const result = runStep(step, {
    POLICY_DECISION: 'documentation-exemption',
    APEX_RESULT: 'skipped',
    BUDGET_ALLOWED: '',
  });
  assert.equal(result.status, 0);
  assert.match(
    result.stdout,
    /Apex not run—approved documentation-only exemption/,
  );
  assert.match(result.stdout, /Not phase-gate Apex evidence/);
  assert.ok(result.stdout.includes(sha));
  for (const APEX_RESULT of ['success', 'failure', 'cancelled', '']) {
    assert.equal(
      runStep(step, { POLICY_DECISION: 'documentation-exemption', APEX_RESULT })
        .status,
      1,
    );
  }
});

test('gate rejects policy failure, unknown exemption, stale head and missing retry eligibility', () => {
  const step = 'Require exact-head Apex or explicit documentation exemption';
  for (const invalid of [
    { POLICY_RESULT: 'skipped' },
    { POLICY_RESULT: 'failure' },
    { POLICY_RESULT: '' },
    { POLICY_SHA: 'b'.repeat(40) },
    { POLICY_SHA: '' },
    { POLICY_DECISION: 'unknown' },
    { FAKE_HEAD: 'b'.repeat(40) },
    { BUDGET_ALLOWED: '' },
    { BUDGET_ALLOWED: 'false' },
  ]) {
    assert.equal(
      runStep(step, { APEX_RESULT: 'success', ...invalid }).status,
      1,
    );
  }
});

test('Apex serializes across every PR and no existing target-org input exists', () => {
  const apexJob = workflow.slice(
    workflow.indexOf('\n  apex:'),
    workflow.indexOf('\n  gate:'),
  );
  assert.match(
    apexJob,
    /concurrency:\n      group: \$\{\{ github\.repository \}\}-salesforce-ci\n      cancel-in-progress: false/,
  );
  assert.doesNotMatch(workflow, /^concurrency:/m);
  assert.match(apexJob, /environment: salesforce-ci/);
  const inputs = workflow.slice(
    workflow.indexOf('    inputs:'),
    workflow.indexOf('\npermissions:'),
  );
  assert.deepEqual(
    [...inputs.matchAll(/^      ([a-z_]+):$/gm)].map((match) => match[1]),
    ['pull_request', 'reviewed_sha'],
  );
  assert.doesNotMatch(inputs, /target.org|existing.org/i);
  assert.match(apexJob, /KUSANYA_VERIFY_ROLE: ci/);
  assert.match(
    workflow,
    /run: node trusted\/scripts\/verify-salesforce\.mjs\n/,
  );
  assert.match(workflow, /node trusted\/scripts\/apex-run-budget\.mjs/);
  assert.match(workflow, /node trusted\/scripts\/apex-pr-policy\.mjs classify/);
});
