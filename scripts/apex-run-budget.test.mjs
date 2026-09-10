import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  readVerificationMarker,
  readVerificationSubject,
  collectAttempts,
  runBudget,
} from './apex-run-budget.mjs';

const headSha = 'a'.repeat(40);
const repository = 'kusanya-io/kusanya';
const subject = (sha = headSha) =>
  `2026-09-10T12:00:00Z Verifying PR 3 at head ${sha}`;

test('dispatched subjects are exact, unique and fail closed', () => {
  assert.deepEqual(readVerificationSubject(subject()), {
    pullRequest: '3',
    headSha,
  });
  for (const log of [
    '',
    `${subject()}\n${subject()}`,
    `${subject()}\n2026-09-10T12:00:01Z Verifying PR malformed`,
    `echo '${subject()}'`,
  ])
    assert.throws(() => readVerificationSubject(log));
});
test('historical dispatches are attributed to reviewed subject, not main workflow SHA', () => {
  const workflowSha = 'b'.repeat(40);
  const history = fakeHistory({ log: `${subject()}\n${marker()}` });
  const originalApi = history.api;
  history.api = (path) => {
    const result = originalApi(path);
    if (path.includes('/workflows/'))
      Object.assign(
        result.workflow_runs.find((run) => run.id === 11),
        { event: 'workflow_dispatch', head_sha: workflowSha },
      );
    if (path.endsWith('/attempts/1'))
      Object.assign(result, {
        event: 'workflow_dispatch',
        head_sha: workflowSha,
      });
    return result;
  };
  assert.equal(collectAttempts(history)[0].headSha, headSha);
});
test('current dispatch uses its checked subject while unrelated legacy subjects need no outcome', () => {
  const current = fakeHistory({ prior: false });
  const currentApi = current.api;
  current.api = (path) => {
    const result = currentApi(path);
    Object.assign(result.workflow_runs[0], {
      event: 'workflow_dispatch',
      head_sha: 'b'.repeat(40),
    });
    return result;
  };
  assert.deepEqual(collectAttempts(current), []);
  const previous = fakeHistory({ log: subject('c'.repeat(40)) });
  const previousApi = previous.api;
  previous.api = (path) => {
    const result = previousApi(path);
    if (path.includes('/workflows/'))
      result.workflow_runs.find((run) => run.id === 11).event =
        'workflow_dispatch';
    if (path.endsWith('/attempts/1')) result.event = 'workflow_dispatch';
    return result;
  };
  assert.deepEqual(collectAttempts(previous), []);
  previous.readLog = () => subject();
  assert.throws(() => collectAttempts(previous), /outcome marker/);
  previous.readLog = () => 'No trusted subject';
  assert.throws(() => collectAttempts(previous), /subject/);
});
test('Apex job start, not workflow queue date, determines UTC attempt day', () => {
  const history = fakeHistory();
  const originalApi = history.api;
  history.api = (path) => {
    const result = originalApi(path);
    if (path.endsWith('/attempts/1'))
      result.run_started_at = '2026-09-09T23:00:00Z';
    return result;
  };
  assert.equal(collectAttempts(history)[0].startedAt, '2026-09-10T12:00:00Z');
});
const identity = { runId: '11', attempt: 1, headSha };
const marker = (changes = {}) =>
  `2026-09-10T12:00:01.000Z KUSANYA_VERIFICATION_RESULT ${JSON.stringify({
    schemaVersion: 1,
    role: 'ci',
    runId: '11-1',
    headSha,
    outcome: 'failed-infrastructure',
    retryable: true,
    ...changes,
  })}`;

test('budget accepts one exact-head, exact-attempt sanitized outcome', () => {
  assert.deepEqual(readVerificationMarker(marker(), identity), {
    verificationOutcome: 'failed-infrastructure',
    retryable: true,
  });
  assert.deepEqual(
    readVerificationMarker(
      `job\tstep\t${marker({ outcome: 'passed', retryable: false })}`,
      identity,
    ),
    {
      verificationOutcome: 'passed',
      retryable: false,
    },
  );
});

test('budget refuses absent, malformed, duplicate, spoofed and contradictory markers', () => {
  for (const log of [
    '',
    undefined,
    `${marker()}\n${marker()}`,
    `${marker()}\n2026-09-10T12:00:02Z KUSANYA_VERIFICATION_RESULT {`,
    '2026-09-10T12:00:01Z KUSANYA_VERIFICATION_RESULT {',
    `echo '${marker()}'`,
    marker({ role: 'builder' }),
    marker({ runId: '11-2' }),
    marker({ headSha: 'b'.repeat(40) }),
    marker({ outcome: 'skipped' }),
    marker({ retryable: 'true' }),
    marker({ schemaVersion: 2 }),
    marker({ outcome: 'failed-tests', retryable: true }),
    marker({ outcome: 'passed', retryable: true }),
  ])
    assert.throws(() => readVerificationMarker(log, identity));
});

function fakeHistory({ prior = true, overrides = {}, log = marker() } = {}) {
  const paths = [];
  const responses = {
    [`repos/${repository}/actions/workflows/salesforce-verify.yml/runs?per_page=100&page=1`]:
      {
        total_count: prior ? 2 : 1,
        workflow_runs: [
          { id: 12, head_sha: headSha, event: 'pull_request', run_attempt: 1 },
          ...(prior
            ? [
                {
                  id: 11,
                  head_sha: headSha,
                  event: 'pull_request',
                  run_attempt: 1,
                },
              ]
            : []),
        ],
      },
    [`repos/${repository}/actions/runs/11/attempts/1`]: {
      id: 11,
      head_sha: headSha,
      event: 'pull_request',
      run_attempt: 1,
      status: 'completed',
      run_started_at: '2026-09-10T12:00:00Z',
    },
    [`repos/${repository}/actions/runs/11/attempts/1/jobs?per_page=100`]: {
      total_count: 1,
      jobs: [
        {
          id: 100,
          name: 'Scratch org tests and 85 percent coverage',
          status: 'completed',
          started_at: '2026-09-10T12:00:00Z',
          conclusion: 'failure',
          steps: [{ name: 'Verify' }],
        },
      ],
    },
    ...overrides,
  };
  return {
    paths,
    api(path) {
      paths.push(path);
      assert.ok(Object.hasOwn(responses, path), path);
      return structuredClone(responses[path]);
    },
    readLog(run, attempt, job) {
      assert.deepEqual([run, attempt, job], [11, 1, 100]);
      return log;
    },
    repository,
    headSha,
    runId: '12',
    attempt: 1,
  };
}

test('collects previous attempts across run IDs, excluding the current attempt', () => {
  const history = fakeHistory();
  const attempts = collectAttempts(history);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].runId, '11');
  assert.equal(attempts[0].retryable, true);
  assert.equal(attempts[0].verificationOutcome, 'failed-infrastructure');
  assert.equal(history.paths.length, 3);
  assert.deepEqual(collectAttempts(fakeHistory({ prior: false })), []);
});

test('reads previous rerun attempts instead of resetting budget for the same run ID', () => {
  const history = fakeHistory();
  history.runId = '11';
  history.attempt = 2;
  const originalApi = history.api;
  history.api = (path) =>
    path.includes('/workflows/')
      ? {
          total_count: 1,
          workflow_runs: [
            {
              id: 11,
              head_sha: headSha,
              event: 'pull_request',
              run_attempt: 2,
            },
          ],
        }
      : originalApi(path);
  assert.equal(collectAttempts(history).length, 1);
});

test('refuses missing current run, mismatched SHA, duplicate IDs and incomplete pages', () => {
  const path = `repos/${repository}/actions/workflows/salesforce-verify.yml/runs?per_page=100&page=1`;
  for (const result of [
    { total_count: 0, workflow_runs: [] },
    {
      total_count: 2,
      workflow_runs: [
        { id: 12, head_sha: headSha, event: 'pull_request', run_attempt: 1 },
      ],
    },
    {
      total_count: 1,
      workflow_runs: [
        { id: 11, head_sha: headSha, event: 'pull_request', run_attempt: 1 },
      ],
    },
    {
      total_count: 1,
      workflow_runs: [
        {
          id: 12,
          head_sha: 'b'.repeat(40),
          event: 'pull_request',
          run_attempt: 1,
        },
      ],
    },
    {
      total_count: 2,
      workflow_runs: Array(2).fill({
        id: 12,
        head_sha: headSha,
        event: 'pull_request',
        run_attempt: 1,
      }),
    },
    {
      total_count: 1,
      workflow_runs: [
        { id: 12, head_sha: headSha, event: 'pull_request', run_attempt: 101 },
      ],
    },
  ])
    assert.throws(() =>
      collectAttempts(fakeHistory({ overrides: { [path]: result } })),
    );
});

test('refuses active, ambiguous, missing and internally inconsistent historical evidence', () => {
  const attemptPath = `repos/${repository}/actions/runs/11/attempts/1`;
  const jobsPath = `repos/${repository}/actions/runs/11/attempts/1/jobs?per_page=100`;
  assert.throws(() =>
    collectAttempts(
      fakeHistory({
        overrides: {
          [attemptPath]: {
            id: 11,
            head_sha: headSha,
            event: 'pull_request',
            run_attempt: 1,
            status: 'in_progress',
            run_started_at: '2026-09-10T12:00:00Z',
          },
        },
      }),
    ),
  );
  for (const jobs of [
    { total_count: 1, jobs: [] },
    { total_count: 0, jobs: [] },
    {
      total_count: 1,
      jobs: [
        {
          id: 100,
          name: 'unrelated',
          status: 'completed',
          conclusion: 'failure',
        },
      ],
    },
    {
      total_count: 1,
      jobs: [
        {
          id: 100,
          name: 'Scratch org tests and 85 percent coverage',
          status: 'completed',
          conclusion: 'success',
        },
      ],
    },
  ])
    assert.throws(() =>
      collectAttempts(fakeHistory({ overrides: { [jobsPath]: jobs } })),
    );
  assert.throws(() => collectAttempts(fakeHistory({ log: '' })));
});

test('an entirely skipped Apex job consumes no allocation or retry evidence', () => {
  const jobsPath = `repos/${repository}/actions/runs/11/attempts/1/jobs?per_page=100`;
  assert.deepEqual(
    collectAttempts(
      fakeHistory({
        overrides: {
          [jobsPath]: {
            total_count: 1,
            jobs: [
              {
                id: 100,
                name: 'Scratch org tests and 85 percent coverage',
                status: 'completed',
                conclusion: 'skipped',
                steps: [],
              },
            ],
          },
        },
      }),
    ),
    [],
  );
});

test('first attempt budget is allowed only with validated current run and complete history', () => {
  const history = fakeHistory({ prior: false });
  const env = {
    KUSANYA_POLICY_REPOSITORY: repository,
    KUSANYA_POLICY_HEAD_SHA: headSha,
    GITHUB_RUN_ID: '12',
    GITHUB_RUN_ATTEMPT: '1',
  };
  assert.equal(
    runBudget({ env, now: new Date('2026-09-10T13:00:00Z'), ...history })
      .allowed,
    true,
  );
  for (const bad of [
    { GITHUB_RUN_ID: '' },
    { GITHUB_RUN_ATTEMPT: '0' },
    { KUSANYA_POLICY_HEAD_SHA: 'not-a-sha' },
    { KUSANYA_POLICY_REPOSITORY: '../wrong' },
  ])
    assert.throws(() => runBudget({ env: { ...env, ...bad }, ...history }));
});
