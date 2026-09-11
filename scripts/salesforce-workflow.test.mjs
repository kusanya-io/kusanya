import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolveGitBash } from './git-bash.mjs';
import {
  collectAttempts,
  readVerificationSubject,
} from './apex-run-budget.mjs';

const workflow = readFileSync(
  new URL('../.github/workflows/salesforce-verify.yml', import.meta.url),
  'utf8',
).replaceAll('\r\n', '\n');
const apexJob = workflow.slice(
  workflow.indexOf('\n  apex:'),
  workflow.indexOf('\n  gate:'),
);
function stepConfig(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.ok(start >= 0, `Missing workflow step: ${name}`);
  const rest = workflow.slice(start);
  const next = rest.slice(1).search(/^      - /m);
  return next < 0 ? rest : rest.slice(0, next + 1);
}
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
  FAKE_GH_RESULT: '0',
  SF_DEV_HUB_AUTH_URL: 'synthetic-auth-input-not-a-credential',
  FAKE_AUTH_RESULT: '0',
  FAKE_AUTH_STDOUT: 'synthetic-auth-input-not-a-credential',
  FAKE_AUTH_STDERR: 'synthetic-auth-input-not-a-credential',
  FAKE_GIT_RESULT: '0',
  FAKE_BUDGET_RESULT: '0',
  GITHUB_RUN_ID: '123',
  GITHUB_RUN_ATTEMPT: '1',
  KUSANYA_POLICY_REPOSITORY: 'kusanya-io/kusanya',
  KUSANYA_POLICY_HEAD_SHA: sha,
};
const doubles = `
gh() {
  [[ "$FAKE_GH_RESULT" == 0 ]] || return "$FAKE_GH_RESULT"
  case "$4" in
    .head.sha) printf '%s\\n' "$FAKE_HEAD" ;;
    .head.repo.full_name) printf '%s\\n' "$FAKE_SOURCE" ;;
    .base.ref) printf '%s\\n' "$FAKE_BASE" ;;
    .state) printf '%s\\n' "$FAKE_STATE" ;;
    *) return 1 ;;
  esac
}
git() { printf '%s\\n' "$FAKE_CHECKOUT"; return "$FAKE_GIT_RESULT"; }
node() {
  [[ "$#" -eq 1 && "$1" == trusted/scripts/apex-run-budget.mjs ]] || {
    printf 'Unexpected node invocation\\n' >&2
    return 2
  }
  [[ "$KUSANYA_POLICY_REPOSITORY" == "$GITHUB_REPOSITORY" &&
     "$KUSANYA_POLICY_HEAD_SHA" == "$REVIEWED_SHA" ]] || return 3
  printf 'Budget checked for attempt %s\\n' "$GITHUB_RUN_ATTEMPT"
  return "$FAKE_BUDGET_RESULT"
}
sf() {
  [[ "$#" -eq 9 && "$1" == org && "$2" == login && "$3" == sfdx-url &&
     "$4" == --sfdx-url-stdin && "$5" == - && "$6" == --alias &&
     "$7" == Kusanya-CI-DevHub && "$8" == --set-default-dev-hub && "$9" == --json ]] || return 2
  local payload
  payload="$(cat)"
  [[ "$payload" == synthetic-auth-input-not-a-credential ]] || return 3
  # Simulate a CLI that includes its input in diagnostics; neither stream may leak.
  printf '%s\\n' "$FAKE_AUTH_STDOUT"
  printf '%s\\n' "$payload" "$FAKE_AUTH_STDERR" >&2
  return "$FAKE_AUTH_RESULT"
}
`;
function runStep(name, overrides = {}) {
  return runShell(shellStep(name), overrides);
}
function runShell(body, overrides = {}) {
  const env = { ...process.env, ...fixtures, ...overrides };
  delete env.BASH_ENV;
  delete env.ENV;
  const result = spawnSync(
    bash,
    ['--noprofile', '--norc', '-c', doubles + body],
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

test('valid failed guards emit one early subject that attributes dispatched attempts without poisoning other heads', () => {
  const step = 'Confirm reviewed commit and trusted workflow';
  const body = shellStep(step);
  assert.equal((body.match(/printf 'Verifying PR/g) ?? []).length, 1);
  assert.match(
    body,
    /A full reviewed SHA is required\.'; exit 1; \}\n\s*printf 'Verifying PR/,
  );
  assert.ok(body.indexOf("printf 'Verifying PR") < body.indexOf('case '));
  const workflowSha = 'b'.repeat(40);
  const repository = fixtures.GITHUB_REPOSITORY;
  const startedAt = '2026-09-11T12:00:00Z';
  for (const invalid of [
    { GITHUB_EVENT_NAME: 'unsupported' },
    { GITHUB_REF: 'refs/heads/untrusted' },
    { FAKE_HEAD: 'c'.repeat(40) },
    { FAKE_SOURCE: 'contributor/fork' },
    { FAKE_BASE: 'other' },
    { FAKE_STATE: 'closed' },
    { FAKE_GH_RESULT: '42' },
  ]) {
    const output = runStep(step, {
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/main',
      ...invalid,
    });
    assert.notEqual(output.status, 0);
    assert.equal(output.stdout.split('\n')[0], `Verifying PR 3 at head ${sha}`);
    assert.deepEqual(readVerificationSubject(output.stdout), {
      pullRequest: '3',
      headSha: sha,
    });
    for (const candidate of [sha, 'd'.repeat(40)]) {
      const previous = {
        id: 11,
        head_sha: workflowSha,
        event: 'workflow_dispatch',
        run_attempt: 1,
        status: 'completed',
        run_started_at: startedAt,
      };
      const responses = {
        [`repos/${repository}/actions/workflows/salesforce-verify.yml/runs?per_page=100&page=1`]:
          {
            total_count: 2,
            workflow_runs: [
              {
                id: 12,
                head_sha: candidate,
                event: 'pull_request',
                run_attempt: 1,
              },
              previous,
            ],
          },
        [`repos/${repository}/actions/runs/11/attempts/1`]: previous,
        [`repos/${repository}/actions/runs/11/attempts/1/jobs?per_page=100`]: {
          total_count: 1,
          jobs: [
            {
              id: 100,
              run_id: 11,
              run_attempt: 1,
              head_sha: workflowSha,
              name: 'Scratch org tests and 85 percent coverage',
              status: 'completed',
              conclusion: 'failure',
              started_at: startedAt,
              steps: [
                { name: step, status: 'completed', conclusion: 'failure' },
                {
                  name: 'Verify reviewed metadata using only trusted harness code',
                  status: 'completed',
                  conclusion: 'skipped',
                },
              ],
            },
          ],
        },
      };
      const attempts = collectAttempts({
        repository,
        headSha: candidate,
        runId: '12',
        attempt: 1,
        api: (path) => {
          assert.ok(Object.hasOwn(responses, path), path);
          return structuredClone(responses[path]);
        },
        readLog: (runId, attempt, jobId) => {
          assert.deepEqual([runId, attempt, jobId], [11, 1, 100]);
          return output.stdout;
        },
      });
      if (candidate === sha) {
        assert.equal(attempts.length, 1);
        assert.equal(attempts[0].headSha, sha);
        assert.equal(attempts[0].verificationOutcome, 'failed-infrastructure');
      } else assert.deepEqual(attempts, []);
    }
  }
});

test('invalid PR or head syntax emits no verification subject', () => {
  for (const invalid of [
    { PR_NUMBER: '0' },
    { PR_NUMBER: '3; echo unsafe' },
    { REVIEWED_SHA: 'short' },
    { REVIEWED_SHA: `${sha}\nVerifying PR 4 at head ${sha}` },
  ]) {
    const result = runStep(
      'Confirm reviewed commit and trusted workflow',
      invalid,
    );
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /Verifying PR/);
    assert.throws(() => readVerificationSubject(result.stdout));
  }
});
test('Salesforce authentication guard rejects mismatched checkout and changed head', () => {
  const step = 'Recheck exact head immediately before authentication';
  assert.equal(runStep(step).status, 0);
  assert.equal(runStep(step, { FAKE_CHECKOUT: 'b'.repeat(40) }).status, 1);
  assert.equal(runStep(step, { FAKE_HEAD: 'b'.repeat(40) }).status, 1);
});

test('classification refuses a failed checkout identity command before running policy code', () => {
  const step = 'Classify complete reviewed diff';
  assert.doesNotMatch(shellStep(step), /export\s+\w+=\s*["']?\$\(/);
  const result = runStep(step, { FAKE_GIT_RESULT: '42' });
  assert.equal(result.status, 42);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('each Apex attempt rechecks trusted budget before auth even if the early policy passed', () => {
  const names = [
    'Recheck exact head immediately before authentication',
    'Recheck trusted retry budget immediately before authentication',
    'Authenticate dedicated Dev Hub without printing its auth URL',
  ];
  const body =
    names.map(shellStep).join('\n') + "\nprintf 'Authentication completed\\n'";
  for (const attempt of ['1', '2', '3']) {
    const allowed = runShell(body, { GITHUB_RUN_ATTEMPT: attempt });
    assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr);
    assert.equal(
      allowed.stdout,
      `Budget checked for attempt ${attempt}\nAuthentication completed\n`,
    );
    // Simulate an already-successful policy job retained by a partial rerun.
    // The fresh Apex-local budget failure must stop execution before auth.
    const refused = runShell(body, {
      GITHUB_RUN_ATTEMPT: attempt,
      BUDGET_ALLOWED: 'true',
      FAKE_BUDGET_RESULT: '1',
      SF_DEV_HUB_AUTH_URL: '',
    });
    assert.equal(refused.status, 1);
    assert.equal(refused.stdout, `Budget checked for attempt ${attempt}\n`);
    assert.equal(refused.stderr, '');
  }
  const stale = runShell(body, { FAKE_HEAD: 'b'.repeat(40) });
  assert.equal(stale.status, 1);
  assert.doesNotMatch(stale.stdout, /Budget checked|Authentication completed/);
});

test('retry admission stays inside the approved Apex job with narrowly scoped read access', () => {
  assert.match(
    apexJob,
    /permissions:\n      contents: read\n      pull-requests: read\n      actions: read\n/,
  );
  const jobEnv = apexJob.slice(
    apexJob.indexOf('    env:\n'),
    apexJob.indexOf('    steps:\n'),
  );
  assert.doesNotMatch(jobEnv, /GH_TOKEN|SF_DEV_HUB_AUTH_URL/);
  assert.match(
    jobEnv,
    /KUSANYA_POLICY_REPOSITORY: \$\{\{ github\.repository \}\}/,
  );
  assert.match(
    jobEnv,
    /KUSANYA_POLICY_HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \|\| inputs\.reviewed_sha \}\}/,
  );
  const budget = stepConfig(
    'Recheck trusted retry budget immediately before authentication',
  );
  assert.match(budget, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(budget, /\n        if:/);
  assert.match(budget, /node trusted\/scripts\/apex-run-budget\.mjs/);
  assert.match(
    stepConfig('Enforce complete exact-head retry budget'),
    /node trusted\/scripts\/apex-run-budget\.mjs/,
  );
  const ordered = [
    'Checkout trusted verification harness',
    'Recheck exact head immediately before authentication',
    'Recheck trusted retry budget immediately before authentication',
    'Authenticate dedicated Dev Hub without printing its auth URL',
    'Verify reviewed metadata using only trusted harness code',
  ].map((name) => apexJob.indexOf(`      - name: ${name}\n`));
  assert.ok(ordered.every((index) => index >= 0));
  assert.deepEqual(
    ordered,
    [...ordered].sort((a, b) => a - b),
  );
});

test('Apex step deadlines reserve separate owned cleanup and five minutes of job slack', () => {
  const jobMinutes = Number(
    apexJob.match(/^    timeout-minutes: (\d+)$/m)?.[1],
  );
  const steps = apexJob.split(/^      - /m).slice(1);
  const deadlines = steps.map((step) => {
    const value = step.match(/^        timeout-minutes: (\d+)$/m)?.[1];
    assert.ok(value, `Missing bounded deadline: ${step.split('\n')[0]}`);
    return Number(value);
  });
  assert.equal(jobMinutes, 45);
  assert.ok(deadlines.every((minutes) => minutes > 0));
  assert.ok(deadlines.reduce((sum, minutes) => sum + minutes, 0) <= 40);
  assert.match(
    stepConfig('Verify reviewed metadata using only trusted harness code'),
    /id: verify\n        timeout-minutes: 20/,
  );
  const cleanup = stepConfig(
    "Clean up this authenticated run's owned scratch intents",
  );
  assert.match(cleanup, /timeout-minutes: 5/);
  assert.match(cleanup, /run: node trusted\/scripts\/cleanup-salesforce\.mjs/);
  assert.match(cleanup, /always\(\) && steps\.auth\.outcome == 'success'/);
  for (const outcome of ['failure', 'cancelled'])
    assert.ok(cleanup.includes(`steps.verify.outcome == '${outcome}'`));
  assert.doesNotMatch(cleanup, /steps\.verify\.outcome == 'success'/);
  assert.doesNotMatch(cleanup, /steps\.verify\.outcome == 'skipped'/);
  assert.doesNotMatch(
    cleanup,
    /GH_TOKEN|SF_DEV_HUB_AUTH_URL|continue-on-error/,
  );
  // runner context is available in step env, not job env.
  assert.doesNotMatch(apexJob.split('    steps:\n')[0], /runner\.temp/);
  for (const step of [
    cleanup,
    stepConfig('Verify reviewed metadata using only trusted harness code'),
  ])
    assert.match(
      step,
      /KUSANYA_CLEANUP_JOURNAL: \$\{\{ runner\.temp \}\}\/kusanya-scratch-intents\.json/,
    );
  assert.ok(
    apexJob.indexOf("Clean up this authenticated run's owned scratch intents") <
      apexJob.indexOf('Remove Dev Hub authentication'),
  );
});
test('fallback only runs for failed or cancelled verification, never after a passed cleanup marker', () => {
  const cleanup = stepConfig(
    "Clean up this authenticated run's owned scratch intents",
  );
  const expression = cleanup
    .match(/        if: >-\n([\s\S]*?)        timeout-minutes:/)?.[1]
    .trim();
  assert.ok(expression);
  const expected =
    "always() && steps.auth.outcome == 'success' && (steps.verify.outcome == 'failure' || steps.verify.outcome == 'cancelled')";
  assert.equal(expression.replace(/\s+/g, ' '), expected);
  // Exercise the actual workflow boolean guard, whose operators have the same
  // semantics in Bash [[ ]]. always() is true even after a step failure.
  const shell = expression
    .replace(/\s+/g, ' ')
    .replace('always()', '-n always')
    .replaceAll('steps.auth.outcome', '"$AUTH_RESULT"')
    .replaceAll('steps.verify.outcome', '"$VERIFY_RESULT"');
  for (const auth of ['success', 'failure', 'skipped', 'cancelled']) {
    for (const verify of ['success', 'failure', 'cancelled', 'skipped', '']) {
      const result = runShell(
        `if [[ ${shell} ]]; then printf 'fallback'; else printf 'skipped'; fi`,
        {
          AUTH_RESULT: auth,
          VERIFY_RESULT: verify,
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        result.stdout,
        auth === 'success' && ['failure', 'cancelled'].includes(verify)
          ? 'fallback'
          : 'skipped',
      );
    }
  }
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
  assert.equal(failed.stdout, 'Dev Hub authentication failed: unrecognized\n');
  for (const result of [missing, failed]) {
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /synthetic-auth-input-not-a-credential/,
    );
    assert.equal(result.stderr, '');
  }
});

test('auth failure prints only an exact allowlisted top-level class using the real inline parser', () => {
  const step = 'Authenticate dedicated Dev Hub without printing its auth URL';
  const secret = fixtures.SF_DEV_HUB_AUTH_URL;
  // command node bypasses the budget-only shell double: these cases execute
  // the actual inline JSON parser with the installed Node runtime.
  assert.match(shellStep(step), /\| command node -e '/);
  const allowed = [
    'ENOTFOUND',
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'EAI_AGAIN',
    'invalid_grant',
    'INVALID_SFDX_AUTH_URL',
    'AuthDecryptError',
    'RequestError',
  ];
  for (const name of allowed) {
    const raw = JSON.stringify({
      status: 1,
      name,
      message: secret,
      stack: secret,
      data: { authUrl: secret, instanceUrl: secret, name: secret },
      result: { accessToken: secret, username: secret },
    });
    const result = runStep(step, {
      FAKE_AUTH_RESULT: '1',
      FAKE_AUTH_STDOUT: raw,
      FAKE_AUTH_STDERR: `${secret}\n${raw}`,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, `Dev Hub authentication failed: ${name}\n`);
    assert.equal(result.stderr, '');
    assert.ok(!(result.stdout + result.stderr).includes(secret));
  }
});

test('RefreshTokenAuthError inspects only top-level message and cause strings and emits static subtype labels', () => {
  const step = 'Authenticate dedicated Dev Hub without printing its auth URL';
  const secret = fixtures.SF_DEV_HUB_AUTH_URL;
  const url = `https://${secret}.invalid/token?refresh_token=${secret}`;
  const base = {
    status: 1,
    name: 'RefreshTokenAuthError',
    code: 'RefreshTokenAuthError',
    message: `Unable to refresh session at ${url}`,
    cause: secret,
    data: { accessToken: secret, instanceUrl: url, message: 'ENOTFOUND' },
  };
  for (const [details, label] of [
    [
      {
        message: `request to ${url} failed, reason: getaddrinfo ENOTFOUND ${secret}`,
      },
      'dns',
    ],
    [{ cause: `eai_again ${url}` }, 'dns'],
    [{ cause: `GetAddrInfo ${url}` }, 'dns'],
    [{ message: `ETIMEDOUT ${url}` }, 'timeout'],
    [{ cause: `connection TiMeD OuT ${secret}` }, 'timeout'],
    [{ message: `ECONNRESET ${url}` }, 'connection'],
    [{ cause: `econnrefused ${secret}` }, 'connection'],
    [{ cause: `Socket Hang Up ${url}` }, 'connection'],
    [{ message: `expired access/refresh token ${secret}` }, 'token-rejected'],
    [{ cause: `Expired Access/Refresh Token ${secret}` }, 'token-rejected'],
    [{ cause: `expired access token ${secret}` }, 'other'],
    [{ cause: `expired refresh token ${secret}` }, 'other'],
    [{ message: `INVALID_GRANT ${secret}` }, 'token-rejected'],
    [{ message: `ETIMEDOUT ${secret}`, cause: `ENOTFOUND ${url}` }, 'dns'],
    [{ message: `ECONNRESET ${secret}`, cause: `timed out ${url}` }, 'timeout'],
    [
      { message: `invalid_grant ${secret}`, cause: `ECONNREFUSED ${url}` },
      'connection',
    ],
    [{ message: secret, cause: url }, 'other'],
    [
      {
        message: ['ENOTFOUND', secret],
        cause: { message: 'ETIMEDOUT', token: secret },
      },
      'other',
    ],
    [{ message: null, cause: 42 }, 'other'],
    [{ message: false, cause: undefined }, 'other'],
    [{ message: `${secret}NOTENOTFOUND`, cause: '' }, 'other'],
  ]) {
    const raw = JSON.stringify({ ...base, ...details });
    const result = runStep(step, {
      FAKE_AUTH_RESULT: '1',
      FAKE_AUTH_STDOUT: raw,
      FAKE_AUTH_STDERR: `${secret}\n${raw}`,
    });
    assert.equal(result.status, 1);
    assert.equal(
      result.stdout,
      `Dev Hub authentication failed: RefreshTokenAuthError/${label}\n`,
    );
    assert.equal(result.stderr, '');
    assert.ok(!(result.stdout + result.stderr).includes(secret));
    assert.ok(!(result.stdout + result.stderr).includes(url));
  }
  // Neither code nor a nested object may promote a different top-level name.
  for (const [record, expected] of [
    [{ ...base, name: 'RequestError', message: 'ENOTFOUND' }, 'RequestError'],
    [{ ...base, name: 'refreshtokenautherror' }, 'unrecognized'],
    [{ ...base, name: undefined, cause: 'ENOTFOUND' }, 'unrecognized'],
    [{ ...base, name: { name: 'RefreshTokenAuthError' } }, 'unrecognized'],
  ]) {
    const result = runStep(step, {
      FAKE_AUTH_RESULT: '1',
      FAKE_AUTH_STDOUT: JSON.stringify(record),
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, `Dev Hub authentication failed: ${expected}\n`);
    assert.equal(result.stderr, '');
  }
});

test('auth parser refuses malicious, nested, malformed and non-object classifications without leaks', () => {
  const step = 'Authenticate dedicated Dev Hub without printing its auth URL';
  const secret = fixtures.SF_DEV_HUB_AUTH_URL;
  for (const raw of [
    secret,
    '',
    `{"name":"ENOTFOUND","message":"${secret}"`,
    `{"name":"RefreshTokenAuthError","message":"ENOTFOUND ${secret}"`,
    JSON.stringify({ name: `${secret}\nENOTFOUND`, message: secret }),
    JSON.stringify({ name: `ENOTFOUND\n${secret}`, message: secret }),
    JSON.stringify({ name: `$(printf '${secret}')`, message: secret }),
    JSON.stringify({ name: 'enotfound', message: secret }),
    JSON.stringify({ name: 'Error', message: secret }),
    JSON.stringify({ name: ['ENOTFOUND'], message: secret }),
    JSON.stringify({ name: { name: 'ENOTFOUND' }, message: secret }),
    JSON.stringify({ name: null, message: secret }),
    JSON.stringify({ data: { name: 'ENOTFOUND' }, message: secret }),
    JSON.stringify({ result: { name: 'ENOTFOUND' }, message: secret }),
    JSON.stringify([{ name: 'ENOTFOUND', message: secret }]),
    JSON.stringify(`ENOTFOUND ${secret}`),
    'null',
    'true',
    '123',
  ]) {
    const result = runStep(step, {
      FAKE_AUTH_RESULT: '1',
      FAKE_AUTH_STDOUT: raw,
      // A plausible stderr classification must never become the output class.
      FAKE_AUTH_STDERR: JSON.stringify({
        name: 'RequestError',
        message: secret,
      }),
    });
    assert.equal(result.status, 1);
    assert.equal(
      result.stdout,
      'Dev Hub authentication failed: unrecognized\n',
    );
    assert.equal(result.stderr, '');
    assert.ok(!(result.stdout + result.stderr).includes(secret));
  }
});

test('successful auth discards every stdout and stderr field and never persists raw JSON', () => {
  const step = 'Authenticate dedicated Dev Hub without printing its auth URL';
  const secret = fixtures.SF_DEV_HUB_AUTH_URL;
  for (const raw of [
    secret,
    JSON.stringify({
      status: 0,
      result: { accessToken: secret, instanceUrl: secret },
    }),
    JSON.stringify({ status: 0, name: 'ENOTFOUND', message: secret }),
  ]) {
    const result = runStep(step, {
      FAKE_AUTH_RESULT: '0',
      FAKE_AUTH_STDOUT: raw,
      FAKE_AUTH_STDERR: raw,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
  const body = shellStep(step);
  assert.match(
    body,
    /auth_json="\$\(printf '%s' "\$SF_DEV_HUB_AUTH_URL" \| sf /,
  );
  assert.doesNotMatch(body, /export|GITHUB_OUTPUT|GITHUB_ENV|tee\s|writeFile/);
  assert.equal((body.match(/unset auth_json/g) ?? []).length, 2);
  assert.equal(
    (workflow.match(/secrets\.SF_DEV_HUB_AUTH_URL/g) ?? []).length,
    1,
  );
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
  const immutableRefs = [...workflow.matchAll(/ref: ([0-9a-f]{40})\n/g)].map(
    (match) => match[1],
  );
  assert.equal(immutableRefs.length, 2);
  assert.equal(immutableRefs[0], immutableRefs[1]);
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
