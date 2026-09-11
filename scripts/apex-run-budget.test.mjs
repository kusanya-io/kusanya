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

const verificationStepName =
  'Verify reviewed metadata using only trusted harness code';
const skippedVerification = () => ({
  name: verificationStepName,
  status: 'completed',
  conclusion: 'skipped',
});

function preHarnessFailureHistory({
  failedStep = 'auth',
  stepFailureConclusion = 'failure',
  event = 'pull_request',
  workflowHead = event === 'workflow_dispatch' ? 'b'.repeat(40) : headSha,
  jobChanges = {},
  attemptChanges = {},
  log = subject(),
} = {}) {
  const history = fakeHistory();
  const originalApi = history.api;
  const logReads = [];
  history.api = (path) => {
    const result = originalApi(path);
    if (path.includes('/workflows/'))
      Object.assign(
        result.workflow_runs.find((run) => run.id === 11),
        {
          event,
          head_sha: workflowHead,
        },
      );
    if (path.endsWith('/attempts/1'))
      Object.assign(result, {
        event,
        head_sha: workflowHead,
        ...attemptChanges,
      });
    if (path.includes('/jobs?'))
      Object.assign(result.jobs[0], {
        head_sha: workflowHead,
        steps: [
          {
            name: 'Confirm reviewed commit and trusted workflow',
            status: 'completed',
            conclusion: 'success',
          },
          {
            name: 'Install pinned Salesforce CLI',
            status: 'completed',
            conclusion:
              failedStep === 'install' ? stepFailureConclusion : 'success',
          },
          {
            name: 'Authenticate dedicated Dev Hub without printing its auth URL',
            status: 'completed',
            conclusion:
              failedStep === 'install' ? 'skipped' : stepFailureConclusion,
          },
          skippedVerification(),
        ],
        ...jobChanges,
      });
    return result;
  };
  history.readLog = (run, attempt, job) => {
    logReads.push([run, attempt, job]);
    return log;
  };
  return { ...history, logReads };
}

test('auth and CLI install failures with completed/skipped verification consume a retry without requiring an outcome log', () => {
  for (const failedStep of ['auth', 'install']) {
    const history = preHarnessFailureHistory({ failedStep, log: undefined });
    history.readLog = () =>
      assert.fail('PR skipped-verification proof needs no log.');
    assert.deepEqual(collectAttempts(history), [
      {
        runId: '11',
        attempt: 1,
        headSha,
        status: 'completed',
        conclusion: 'failure',
        verificationOutcome: 'failed-infrastructure',
        retryable: true,
        startedAt: '2026-09-10T12:00:00Z',
        verificationNotStarted: true,
      },
    ]);
    assert.equal(
      runBudget({
        ...history,
        env: budgetEnv(),
        now: new Date('2026-09-10T13:00:00Z'),
      }).kind,
      'infrastructure-retry',
    );
  }
});

test('skipped-verification exception retains exact failed job identity and completed run requirements', () => {
  for (const jobChanges of [
    { id: undefined },
    { run_id: 12 },
    { run_attempt: 2 },
    { head_sha: 'c'.repeat(40) },
    { status: 'in_progress' },
    { status: undefined },
    { conclusion: undefined },
    { conclusion: 'success' },
    { conclusion: 'skipped' },
    { conclusion: 'timed_out' },
  ])
    assert.throws(() =>
      collectAttempts(preHarnessFailureHistory({ jobChanges })),
    );
  for (const attemptChanges of [
    { id: 12 },
    { run_attempt: 2 },
    { head_sha: 'c'.repeat(40) },
    { status: 'in_progress' },
  ])
    assert.throws(() =>
      collectAttempts(preHarnessFailureHistory({ attemptChanges })),
    );
});

test('missing, duplicate, incomplete and executed verification steps still require trusted outcome markers', () => {
  for (const steps of [
    [],
    [null],
    [{ name: 'Another step', status: 'completed', conclusion: 'skipped' }],
    [skippedVerification(), skippedVerification()],
    [
      skippedVerification(),
      {
        name: verificationStepName,
        status: 'completed',
        conclusion: 'failure',
      },
    ],
    [{ name: verificationStepName, conclusion: 'skipped' }],
    [{ ...skippedVerification(), status: 'in_progress' }],
    [{ ...skippedVerification(), conclusion: undefined }],
    [{ ...skippedVerification(), conclusion: 'success' }],
    [{ ...skippedVerification(), conclusion: 'failure' }],
    [{ ...skippedVerification(), conclusion: 'cancelled' }],
  ]) {
    const history = preHarnessFailureHistory({
      jobChanges: { steps },
      log: '',
    });
    assert.throws(() => collectAttempts(history), /outcome marker/);
    assert.deepEqual(history.logReads, [[11, 1, 100]]);
  }
  // Preserve support for legacy job step naming when a valid exact-attempt
  // harness marker supplies the required evidence.
  assert.equal(
    collectAttempts(fakeHistory())[0].verificationOutcome,
    'failed-infrastructure',
  );
  const testFailure = preHarnessFailureHistory({
    jobChanges: {
      steps: [{ ...skippedVerification(), conclusion: 'failure' }],
    },
    log: marker({ outcome: 'failed-tests', retryable: false }),
  });
  assert.equal(
    runBudget({
      ...testFailure,
      env: budgetEnv(),
      now: new Date('2026-09-11T12:00:00Z'),
    }).allowed,
    false,
  );
});

test('skipped-verification attempts use a validated executing job UTC date, never the earlier workflow queue date', () => {
  const history = preHarnessFailureHistory({
    attemptChanges: { run_started_at: '2026-09-10T23:00:00Z' },
    jobChanges: { started_at: '2026-09-11T00:01:00Z' },
  });
  assert.equal(collectAttempts(history)[0].startedAt, '2026-09-11T00:01:00Z');
  assert.equal(
    runBudget({
      ...history,
      env: budgetEnv(),
      now: new Date('2026-09-11T00:05:00Z'),
    }).kind,
    'infrastructure-retry',
  );
  assert.equal(
    runBudget({
      ...history,
      env: budgetEnv(),
      now: new Date('2026-09-12T00:00:00Z'),
    }).kind,
    'initial',
  );
  for (const started_at of [
    undefined,
    null,
    1,
    '2026-02-30T12:00:00Z',
    '2026-09-11T00:01:00+03:00',
    '2026-09-11T00:01:00',
  ])
    assert.throws(
      () =>
        collectAttempts(
          preHarnessFailureHistory({ jobChanges: { started_at } }),
        ),
      /job start/,
    );
  const future = preHarnessFailureHistory({
    jobChanges: { started_at: '2026-09-12T00:00:00Z' },
  });
  assert.equal(
    runBudget({
      ...future,
      env: budgetEnv(),
      now: new Date('2026-09-11T12:00:00Z'),
    }).allowed,
    false,
  );
});

test('pre-harness failures exhaust the same initial-plus-one UTC-day budget across rerun attempts', () => {
  const history = rerunHistory({ runAttempt: 3 });
  const originalApi = history.api;
  history.api = (path) => {
    const result = originalApi(path);
    if (path.includes('/jobs?')) result.jobs[0].steps = [skippedVerification()];
    return result;
  };
  history.readLog = () =>
    assert.fail('Validated skipped PR verification needs no outcome log.');
  const env = budgetEnv({ GITHUB_RUN_ID: '11', GITHUB_RUN_ATTEMPT: '3' });
  assert.equal(collectAttempts(history).length, 2);
  const exhausted = runBudget({
    ...history,
    env,
    now: new Date('2026-09-10T13:00:00Z'),
  });
  assert.equal(exhausted.allowed, false);
  assert.match(exhausted.reason, /already consumed/);
  assert.equal(
    runBudget({ ...history, env, now: new Date('2026-09-11T00:00:00Z') }).kind,
    'initial',
  );
});

test('skipped dispatch verification still requires trusted reviewed-subject identity, not workflow head', () => {
  const history = preHarnessFailureHistory({
    event: 'workflow_dispatch',
    log: subject(),
  });
  assert.equal(collectAttempts(history)[0].headSha, headSha);
  assert.deepEqual(history.logReads, [[11, 1, 100]]);
  for (const log of [
    '',
    `${subject()}\n${subject()}`,
    'Verifying PR malformed',
    `echo '${subject()}'`,
  ])
    assert.throws(
      () =>
        collectAttempts(
          preHarnessFailureHistory({ event: 'workflow_dispatch', log }),
        ),
      /subject/,
    );
  const unrelated = preHarnessFailureHistory({
    event: 'workflow_dispatch',
    log: subject('c'.repeat(40)),
  });
  assert.deepEqual(collectAttempts(unrelated), []);
  assert.equal(
    runBudget({
      ...unrelated,
      env: budgetEnv(),
      now: new Date('2026-09-10T13:00:00Z'),
    }).kind,
    'initial',
  );
  const wrongPrHead = preHarnessFailureHistory({
    workflowHead: 'c'.repeat(40),
  });
  assert.deepEqual(collectAttempts(wrongPrHead), []);
  assert.deepEqual(wrongPrHead.logReads, []);
});

function cancelledSetupHistory(changes = {}) {
  return preHarnessFailureHistory({
    failedStep: 'install',
    stepFailureConclusion: 'cancelled',
    ...changes,
    jobChanges: { conclusion: 'cancelled', ...changes.jobChanges },
  });
}

test('cancellation during CLI installation consumes an attempt while retaining the cancelled job conclusion', () => {
  const history = cancelledSetupHistory();
  history.readLog = () =>
    assert.fail('Skipped PR verification needs no marker log.');
  assert.deepEqual(collectAttempts(history), [
    {
      runId: '11',
      attempt: 1,
      headSha,
      status: 'completed',
      conclusion: 'cancelled',
      verificationOutcome: 'failed-infrastructure',
      retryable: true,
      startedAt: '2026-09-10T12:00:00Z',
      verificationNotStarted: true,
    },
  ]);
  assert.equal(
    runBudget({
      ...history,
      env: budgetEnv(),
      now: new Date('2026-09-10T13:00:00Z'),
    }).kind,
    'infrastructure-retry',
  );
});

test('cancelled pre-harness jobs use the same daily limit and reset as failed attempts', () => {
  const history = rerunHistory({ runAttempt: 3 });
  const originalApi = history.api;
  history.api = (path) => {
    const result = originalApi(path);
    if (path.includes('/jobs?')) {
      result.jobs[0].conclusion = 'cancelled';
      result.jobs[0].steps = [
        {
          name: 'Install pinned Salesforce CLI',
          status: 'completed',
          conclusion: 'cancelled',
        },
        skippedVerification(),
      ];
    }
    return result;
  };
  history.readLog = () =>
    assert.fail('Skipped PR verification needs no outcome log.');
  const env = budgetEnv({ GITHUB_RUN_ID: '11', GITHUB_RUN_ATTEMPT: '3' });
  assert.deepEqual(
    collectAttempts(history).map((value) => value.conclusion),
    ['cancelled', 'cancelled'],
  );
  const sameDay = runBudget({
    ...history,
    env,
    now: new Date('2026-09-10T13:00:00Z'),
  });
  assert.equal(sameDay.allowed, false);
  assert.match(sameDay.reason, /already consumed/);
  assert.equal(
    runBudget({ ...history, env, now: new Date('2026-09-11T00:00:00Z') }).kind,
    'initial',
  );
});

test('cancelled job skipped-verification exception requires positive executed-step evidence', () => {
  for (const extraSteps of [
    [],
    [null],
    [
      {
        name: 'Install pinned Salesforce CLI',
        status: 'completed',
        conclusion: 'skipped',
      },
    ],
    [
      {
        name: 'Install pinned Salesforce CLI',
        status: 'in_progress',
        conclusion: 'cancelled',
      },
    ],
    [
      {
        name: 'Install pinned Salesforce CLI',
        status: 'completed',
        conclusion: undefined,
      },
    ],
  ])
    assert.throws(
      () =>
        collectAttempts(
          cancelledSetupHistory({
            jobChanges: { steps: [...extraSteps, skippedVerification()] },
          }),
        ),
      /positive executed-step evidence/,
    );
  assert.throws(
    () =>
      collectAttempts(
        cancelledSetupHistory({
          jobChanges: { conclusion: 'success' },
          log: marker({ outcome: 'passed', retryable: false }),
        }),
      ),
    /failed or cancelled Apex job/,
  );
});

test('cancelled job without unique completed/skipped verification cannot import proof from a harness marker', () => {
  for (const verificationSteps of [
    [],
    [skippedVerification(), skippedVerification()],
    [{ ...skippedVerification(), status: 'in_progress' }],
    [{ ...skippedVerification(), conclusion: 'cancelled' }],
    [{ ...skippedVerification(), conclusion: 'failure' }],
  ]) {
    const jobChanges = {
      steps: [
        {
          name: 'Install pinned Salesforce CLI',
          status: 'completed',
          conclusion: 'success',
        },
        ...verificationSteps,
      ],
    };
    const absent = cancelledSetupHistory({ jobChanges, log: '' });
    assert.throws(() => collectAttempts(absent), /outcome marker/);
    const forgedProof = cancelledSetupHistory({
      jobChanges,
      log: marker({ verificationNotStarted: true }),
    });
    const [evidence] = collectAttempts(forgedProof);
    assert.equal(evidence.conclusion, 'cancelled');
    assert.equal(Object.hasOwn(evidence, 'verificationNotStarted'), false);
    assert.equal(
      runBudget({
        ...forgedProof,
        env: budgetEnv(),
        now: new Date('2026-09-10T13:00:00Z'),
      }).allowed,
      false,
    );
  }
});

test('pre-harness cancellation retains exact dispatch-subject attribution', () => {
  const history = cancelledSetupHistory({ event: 'workflow_dispatch' });
  assert.equal(collectAttempts(history)[0].headSha, headSha);
  assert.deepEqual(history.logReads, [[11, 1, 100]]);
  assert.equal(
    runBudget({
      ...history,
      env: budgetEnv(),
      now: new Date('2026-09-10T13:00:00Z'),
    }).kind,
    'infrastructure-retry',
  );
  for (const log of ['', `${subject()}\n${subject()}`])
    assert.throws(
      () =>
        collectAttempts(
          cancelledSetupHistory({ event: 'workflow_dispatch', log }),
        ),
      /subject/,
    );
  assert.deepEqual(
    collectAttempts(
      cancelledSetupHistory({
        event: 'workflow_dispatch',
        log: subject('c'.repeat(40)),
      }),
    ),
    [],
  );
  const wrongPrHead = cancelledSetupHistory({ workflowHead: 'c'.repeat(40) });
  assert.deepEqual(collectAttempts(wrongPrHead), []);
  assert.deepEqual(wrongPrHead.logReads, []);
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
