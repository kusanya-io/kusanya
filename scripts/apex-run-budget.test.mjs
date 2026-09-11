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
    if (path.includes('/jobs?')) result.jobs[0].head_sha = workflowSha;
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
test('trusted harness start, not workflow or job approval-queue date, determines UTC attempt day', () => {
  const history = fakeHistory();
  const originalApi = history.api;
  history.api = (path) => {
    const result = originalApi(path);
    if (path.endsWith('/attempts/1'))
      result.run_started_at = '2026-09-09T23:00:00Z';
    if (path.includes('/jobs?'))
      result.jobs[0].started_at = '2026-09-09T23:01:00Z';
    return result;
  };
  assert.equal(
    collectAttempts(history)[0].startedAt,
    '2026-09-10T12:00:00.000Z',
  );
  const env = {
    KUSANYA_POLICY_REPOSITORY: repository,
    KUSANYA_POLICY_HEAD_SHA: headSha,
    GITHUB_RUN_ID: '12',
    GITHUB_RUN_ATTEMPT: '1',
  };
  assert.equal(
    runBudget({ env, now: new Date('2026-09-10T13:00:00Z'), ...history }).kind,
    'infrastructure-retry',
  );
});
const identity = { runId: '11', attempt: 1, headSha };
const marker = (changes = {}) =>
  `2026-09-10T12:00:01.000Z KUSANYA_VERIFICATION_RESULT ${JSON.stringify({
    schemaVersion: 1,
    role: 'ci',
    runId: '11-1',
    headSha,
    outcome: 'failed-infrastructure',
    startedAt: '2026-09-10T12:00:00.000Z',
    retryable: true,
    ...changes,
  })}`;

test('budget accepts one exact-head, exact-attempt sanitized outcome', () => {
  assert.deepEqual(readVerificationMarker(marker(), identity), {
    verificationOutcome: 'failed-infrastructure',
    retryable: true,
    startedAt: '2026-09-10T12:00:00.000Z',
  });
  assert.deepEqual(
    readVerificationMarker(
      `job\tstep\t${marker({ outcome: 'passed', retryable: false })}`,
      identity,
    ),
    {
      verificationOutcome: 'passed',
      retryable: false,
      startedAt: '2026-09-10T12:00:00.000Z',
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
    marker({ startedAt: null }),
    marker({ startedAt: undefined }),
    marker({ startedAt: '2026-02-30T12:00:00.000Z' }),
    marker({ startedAt: '2026-09-10T15:00:00.000+03:00' }),
    marker({ outcome: 'failed-tests', retryable: true }),
    marker({ outcome: 'passed', retryable: true }),
    marker({ outcome: 'failed-creation-rejected', retryable: true }),
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
          run_id: 11,
          run_attempt: 1,
          head_sha: headSha,
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

// Observed run 34523279197 was cancelled while awaiting approval. GitHub
// returned a completed cancelled Apex job with zero steps and no log. Bind
// the fixture to its run/attempt/job identities; the workflow SHA is synthetic.
function unstartedHistory({
  event = 'pull_request',
  conclusion = 'cancelled',
  runChanges = {},
  attemptChanges = {},
  jobChanges = {},
} = {}) {
  const priorId = 34523279197;
  const priorHead = event === 'workflow_dispatch' ? 'b'.repeat(40) : headSha;
  const history = fakeHistory({ prior: false });
  const currentApi = history.api;
  const run = {
    id: priorId,
    head_sha: priorHead,
    event,
    run_attempt: 1,
    ...runChanges,
  };
  history.api = (path) => {
    if (path.includes('/workflows/')) {
      const result = currentApi(path);
      result.total_count += 1;
      result.workflow_runs.push(structuredClone(run));
      return result;
    }
    if (path === `repos/${repository}/actions/runs/${priorId}/attempts/1`)
      return {
        ...run,
        status: 'completed',
        run_started_at: '2026-09-10T19:55:58Z',
        ...attemptChanges,
      };
    assert.equal(
      path,
      `repos/${repository}/actions/runs/${priorId}/attempts/1/jobs?per_page=100`,
    );
    return {
      total_count: 1,
      jobs: [
        {
          id: 103025935762,
          run_id: priorId,
          run_attempt: 1,
          head_sha: priorHead,
          name: 'Scratch org tests and 85 percent coverage',
          status: 'completed',
          conclusion,
          started_at: '2026-09-10T19:55:58Z',
          steps: [],
          ...jobChanges,
        },
      ],
    };
  };
  history.readLog = () => assert.fail('A never-started job has no log.');
  return history;
}

test('completed zero-step skipped or cancelled Apex jobs consume no allocation and never read logs', () => {
  for (const conclusion of ['skipped', 'cancelled']) {
    const history = unstartedHistory({ conclusion });
    assert.deepEqual(collectAttempts(history), []);
    assert.equal(
      runBudget({
        ...history,
        env: budgetEnv(),
        now: new Date('2026-09-11T12:00:00Z'),
      }).kind,
      'initial',
    );
    // Zero-step jobs may lack start information as well as a log; neither
    // supplies an allocation date when nothing ran.
    assert.deepEqual(
      collectAttempts(
        unstartedHistory({ conclusion, jobChanges: { started_at: null } }),
      ),
      [],
    );
  }
});

test('cancelled zero-step dispatch cannot block the reviewed head or unrelated heads forever', () => {
  for (const targetHead of [headSha, 'c'.repeat(40)]) {
    const history = unstartedHistory({ event: 'workflow_dispatch' });
    const originalApi = history.api;
    history.headSha = targetHead;
    history.api = (path) => {
      const result = originalApi(path);
      if (path.includes('/workflows/'))
        result.workflow_runs.find((run) => run.id === 12).head_sha = targetHead;
      return result;
    };
    assert.equal(
      runBudget({
        ...history,
        env: budgetEnv({ KUSANYA_POLICY_HEAD_SHA: targetHead }),
        now: new Date('2026-09-11T12:00:00Z'),
      }).kind,
      'initial',
    );
  }
});

test('zero-step exception requires completed valid run, attempt and job identities', () => {
  for (const event of ['pull_request', 'workflow_dispatch']) {
    for (const conclusion of ['skipped', 'cancelled']) {
      for (const jobChanges of [
        { id: undefined },
        { id: 0 },
        { id: '103025935762' },
        { run_id: undefined },
        { run_id: 34523279198 },
        { run_attempt: undefined },
        { run_attempt: 2 },
        { head_sha: undefined },
        { head_sha: 'd'.repeat(40) },
        { status: undefined },
        { status: 'queued' },
        { status: 'in_progress' },
        { steps: undefined },
        { steps: null },
        { steps: {} },
      ])
        assert.throws(
          () =>
            collectAttempts(
              unstartedHistory({ event, conclusion, jobChanges }),
            ),
          /Historical Apex job identity or completion/,
        );
      for (const attemptChanges of [
        { id: 1 },
        { run_attempt: 2 },
        { head_sha: 'd'.repeat(40) },
        { event: 'push' },
        { run_started_at: null },
        { status: 'in_progress' },
      ])
        assert.throws(() =>
          collectAttempts(
            unstartedHistory({ event, conclusion, attemptChanges }),
          ),
        );
    }
  }
});

test('executed steps and any other zero-step conclusion never receive the no-log exception', () => {
  for (const event of ['pull_request', 'workflow_dispatch']) {
    for (const conclusion of ['skipped', 'cancelled']) {
      const history = unstartedHistory({
        event,
        conclusion,
        jobChanges: {
          started_at: '2026-09-10T18:00:00Z',
          steps: [{ name: 'Set up job', status: 'completed' }],
        },
      });
      let read = false;
      history.readLog = () => {
        read = true;
        return '';
      };
      assert.throws(() => collectAttempts(history), /marker|subject/);
      assert.equal(read, true);
    }
    for (const conclusion of [
      undefined,
      null,
      'success',
      'failure',
      'timed_out',
    ]) {
      const history = unstartedHistory({
        event,
        // Assign separately because default arguments intentionally default
        // undefined to cancellation in the helper.
        jobChanges: { conclusion, started_at: '2026-09-10T18:00:00Z' },
      });
      let read = false;
      history.readLog = () => {
        read = true;
        return '';
      };
      assert.throws(() => collectAttempts(history), /marker|subject/);
      assert.equal(read, true);
    }
  }
});

function budgetEnv(changes = {}) {
  return {
    KUSANYA_POLICY_REPOSITORY: repository,
    KUSANYA_POLICY_HEAD_SHA: headSha,
    GITHUB_RUN_ID: '12',
    GITHUB_RUN_ATTEMPT: '1',
    ...changes,
  };
}

test('proven creation rejection is a valid non-retryable marker, never a quota retry or cleanup failure', () => {
  const history = fakeHistory({
    log: marker({ outcome: 'failed-creation-rejected', retryable: false }),
  });
  assert.equal(
    collectAttempts(history)[0].verificationOutcome,
    'failed-creation-rejected',
  );
  for (const now of [
    new Date('2026-09-10T13:00:00Z'),
    new Date('2026-09-11T13:00:00Z'),
  ]) {
    const decision = runBudget({ ...history, env: budgetEnv(), now });
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /creation rejection is non-retryable/);
  }
});

function rerunHistory({
  runAttempt = 3,
  startedAt = '2026-09-10T12:00:00.000Z',
} = {}) {
  const history = fakeHistory();
  const originalApi = history.api;
  history.runId = '11';
  history.attempt = runAttempt;
  history.api = (path) => {
    if (path.includes('/workflows/'))
      return {
        total_count: 1,
        workflow_runs: [
          {
            id: 11,
            head_sha: headSha,
            event: 'pull_request',
            run_attempt: runAttempt,
          },
        ],
      };
    const attempt = Number(path.match(/\/attempts\/(\d+)/)?.[1]);
    const result = originalApi(
      path.replace(`/attempts/${attempt}`, '/attempts/1'),
    );
    if (path.includes('/jobs?')) {
      result.jobs[0].id = 100 + attempt;
      result.jobs[0].run_attempt = attempt;
    } else result.run_attempt = attempt;
    return result;
  };
  history.readLog = (run, attempt, job) => {
    assert.deepEqual([run, job], [11, 100 + attempt]);
    return marker({ runId: `11-${attempt}`, startedAt });
  };
  return history;
}

test('runBudget rechecks complete attempts on partial reruns even when the policy job did not rerun', () => {
  for (const runAttempt of [2, 3]) {
    const history = rerunHistory({ runAttempt });
    const decision = runBudget({
      ...history,
      env: budgetEnv({
        GITHUB_RUN_ID: '11',
        GITHUB_RUN_ATTEMPT: String(runAttempt),
      }),
      now: new Date('2026-09-10T13:00:00Z'),
    });
    assert.equal(decision.allowed, runAttempt === 2);
    if (runAttempt === 2) assert.equal(decision.kind, 'infrastructure-retry');
    else assert.match(decision.reason, /already consumed/);
    assert.equal(history.paths.length, 2 * (runAttempt - 1));
  }
});

test('runBudget uses the current UTC approval-day check, not the original queued policy date', () => {
  const history = rerunHistory();
  const env = budgetEnv({ GITHUB_RUN_ID: '11', GITHUB_RUN_ATTEMPT: '3' });
  // Both attempts consumed September 10; the job can sit behind approval
  // until September 11. No event or previous policy timestamp is consulted.
  assert.equal(
    runBudget({ ...history, env, now: new Date('2026-09-10T23:59:59Z') })
      .allowed,
    false,
  );
  assert.equal(
    runBudget({ ...history, env, now: new Date('2026-09-11T00:00:00Z') }).kind,
    'initial',
  );
  // Conversely, new attempts admitted on the approval day must be read
  // again; a cached policy success from the previous day is not evidence.
  const consumedOnApprovalDay = rerunHistory({
    startedAt: '2026-09-11T00:00:01.000Z',
  });
  assert.equal(
    runBudget({
      ...consumedOnApprovalDay,
      env,
      now: new Date('2026-09-11T00:05:00Z'),
    }).allowed,
    false,
  );
});

test('runBudget cannot authorize partial reruns from unavailable or incomplete history', () => {
  const env = budgetEnv({ GITHUB_RUN_ID: '11', GITHUB_RUN_ATTEMPT: '3' });
  for (const failure of [
    'missing-attempt',
    'missing-jobs',
    'missing-log',
    'incomplete-page',
  ]) {
    const history = rerunHistory();
    const originalApi = history.api;
    history.api = (path) => {
      if (failure === 'missing-attempt' && path.endsWith('/attempts/2'))
        throw new Error('unavailable attempt');
      const result = originalApi(path);
      if (failure === 'missing-jobs' && path.includes('/attempts/2/jobs?'))
        result.total_count += 1;
      if (failure === 'incomplete-page' && path.includes('/workflows/'))
        result.total_count += 1;
      return result;
    };
    if (failure === 'missing-log') history.readLog = () => '';
    assert.throws(() =>
      runBudget({ ...history, env, now: new Date('2026-09-11T00:05:00Z') }),
    );
  }
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
