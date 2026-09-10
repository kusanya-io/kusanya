import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

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
  bash = join(
    dirname(dirname(git.stdout.trim().split(/\r?\n/)[0])),
    'bin',
    'bash.exe',
  );
}
const sha = 'a'.repeat(40);
const fixtures = {
  PR_NUMBER: '3',
  REVIEWED_SHA: sha,
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
test('Salesforce result guard rejects a head changed during tests', () => {
  const step = 'Reject a stale successful run';
  assert.equal(runStep(step).status, 0);
  assert.equal(runStep(step, { FAKE_HEAD: 'b'.repeat(40) }).status, 1);
});
test('Salesforce required gate rejects skipped, cancelled, failed and absent Apex', () => {
  const step = 'Require actual Apex success, never a skipped job';
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
  assert.match(workflow, /ref: 7974e25e8fa5855ca015bf01123282b744367f2e/);
  assert.match(workflow, /run: node trusted\/scripts\/verify-salesforce\.mjs/);
  assert.match(workflow, /needs: apex\n    if: always\(\)/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.ok(
    workflow.indexOf('Recheck exact head immediately before authentication') <
      workflow.indexOf('      - name: Authenticate dedicated Dev Hub'),
  );
});
