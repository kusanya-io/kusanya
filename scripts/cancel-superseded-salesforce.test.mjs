import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { cancelSupersededSalesforceRun } from './cancel-superseded-salesforce.mjs';

const repository = 'kusanya-io/kusanya';
const pullRequest = 49;
const headSha = 'b'.repeat(40);
const oldSha = 'a'.repeat(40);
const headRef = 'phase-1/repeat-cardinality-policy';
const defaultBranch = 'main';
const runId = 36052471718;
const pull = {
  number: pullRequest,
  state: 'open',
  base: { ref: defaultBranch, repo: { full_name: repository } },
  head: { ref: headRef, sha: headSha, repo: { full_name: repository } },
};
const run = {
  id: runId,
  name: 'Salesforce verification',
  path: '.github/workflows/salesforce-verify.yml',
  event: 'pull_request',
  run_attempt: 1,
  head_sha: oldSha,
  head_branch: headRef,
  repository: { full_name: repository },
  head_repository: { full_name: repository },
  status: 'waiting',
  conclusion: null,
};
const association = [
  {
    number: pullRequest,
    state: 'open',
    base: { ref: defaultBranch, repo: { full_name: repository } },
    head: { ref: headRef, repo: { full_name: repository } },
  },
];
const jobs = {
  total_count: 3,
  jobs: [
    { name: 'Classify PR and check retry eligibility' },
    {
      id: 107811311914,
      name: 'Scratch org tests and 85 percent coverage',
      run_id: runId,
      run_attempt: 1,
      head_sha: oldSha,
      status: 'waiting',
      conclusion: null,
      steps: [],
      runner_id: 0,
      runner_name: '',
    },
    { name: 'Salesforce verification gate' },
  ],
};

const clone = (value) => structuredClone(value);
function fixture(overrides = {}) {
  const calls = [];
  const cancelled = [];
  const values = {
    pull: clone(pull),
    list: { total_count: 1, workflow_runs: [clone(run)] },
    run: clone(run),
    association: clone(association),
    jobs: clone(jobs),
    ...overrides,
  };
  const api = (path) => {
    calls.push(path);
    if (path === `repos/${repository}/pulls/${pullRequest}`)
      return clone(values.pull);
    if (path.includes('/actions/workflows/salesforce-verify.yml/runs?'))
      return clone(values.list);
    if (path === `repos/${repository}/actions/runs/${runId}`)
      return clone(values.run);
    if (path.includes(`/commits/${oldSha}/pulls?`))
      return clone(values.association);
    if (path.includes(`/actions/runs/${runId}/attempts/1/jobs?`))
      return clone(values.jobs);
    throw new Error(`Unexpected API path: ${path}`);
  };
  const cancel = (path) => cancelled.push(path);
  const execute = () =>
    cancelSupersededSalesforceRun({
      api,
      cancel,
      repository,
      pullRequest,
      headSha,
      defaultBranch,
    });
  return { calls, cancelled, execute, values };
}

test('cancels one exact same-PR waiting run only after two complete proofs', () => {
  const value = fixture();
  assert.deepEqual(value.execute(), { outcome: 'cancelled' });
  assert.deepEqual(value.cancelled, [
    `repos/${repository}/actions/runs/${runId}/cancel`,
  ]);
  assert.equal(
    value.calls.filter((path) => path.includes('/pulls/49')).length,
    2,
  );
  assert.equal(
    value.calls.filter((path) => path.includes('/attempts/1/jobs')).length,
    2,
  );
  assert.equal(
    value.calls.filter((path) => path.includes(`/commits/${oldSha}/pulls`))
      .length,
    2,
  );
});

test('does nothing when no superseded waiting run exists', () => {
  for (const workflow_runs of [
    [],
    [{ ...run, head_sha: headSha }],
    [{ ...run, head_branch: 'another-branch' }],
    [{ ...run, head_repository: { full_name: 'other/repository' } }],
  ]) {
    const value = fixture({
      list: { total_count: workflow_runs.length, workflow_runs },
    });
    assert.deepEqual(value.execute(), { outcome: 'none' });
    assert.deepEqual(value.cancelled, []);
  }
});

test('refuses malformed event and live pull-request identities', () => {
  const invalidCalls = [
    { repository: '../bad' },
    { pullRequest: 0 },
    { headSha: 'A'.repeat(40) },
    { defaultBranch: 'bad branch' },
  ];
  for (const invalid of invalidCalls) {
    assert.throws(() =>
      cancelSupersededSalesforceRun({
        api() {},
        cancel() {},
        repository,
        pullRequest,
        headSha,
        defaultBranch,
        ...invalid,
      }),
    );
  }
  for (const mutate of [
    (value) => (value.state = 'closed'),
    (value) => (value.number = 50),
    (value) => (value.head.sha = oldSha),
    (value) => (value.head.repo.full_name = 'fork/repository'),
    (value) => (value.base.ref = 'release'),
    (value) => (value.head.ref = 'bad branch'),
  ]) {
    const changed = clone(pull);
    mutate(changed);
    const value = fixture({ pull: changed });
    assert.throws(value.execute);
    assert.deepEqual(value.cancelled, []);
  }
});

test('fails closed on incomplete, changing and ambiguous waiting-run history', () => {
  const cases = [
    { total_count: -1, workflow_runs: [] },
    { total_count: 1001, workflow_runs: [] },
    { total_count: 2, workflow_runs: [run] },
    { total_count: 2, workflow_runs: [run, run] },
    { total_count: 2, workflow_runs: [run, { ...run, id: runId + 1 }] },
  ];
  for (const list of cases) {
    const value = fixture({ list });
    assert.throws(value.execute);
    assert.deepEqual(value.cancelled, []);
  }
});

test('never cancels dispatches, same-head retries, active or completed runs', () => {
  for (const change of [
    { event: 'workflow_dispatch' },
    { head_sha: headSha },
    { status: 'queued' },
    { status: 'in_progress' },
    { status: 'completed', conclusion: 'failure' },
    { run_attempt: 0 },
    { path: '.github/workflows/other.yml' },
  ]) {
    const candidate = { ...run, ...change };
    const value = fixture({
      list: { total_count: 1, workflow_runs: [candidate] },
      run: candidate,
    });
    if (change.head_sha === headSha) {
      assert.deepEqual(value.execute(), { outcome: 'none' });
    } else {
      assert.throws(value.execute);
    }
    assert.deepEqual(value.cancelled, []);
  }
});

test('requires a unique positive association with the current pull request', () => {
  const wrong = clone(association[0]);
  wrong.number = 48;
  for (const associationValue of [
    [],
    [wrong],
    [{ ...association[0], state: 'closed' }],
    [association[0], association[0]],
  ]) {
    const value = fixture({ association: associationValue });
    assert.throws(value.execute);
    assert.deepEqual(value.cancelled, []);
  }
});

test('requires exactly one zero-step waiting Apex job with no runner', () => {
  const apex = jobs.jobs[1];
  for (const change of [
    { status: 'queued' },
    { status: 'in_progress' },
    { status: 'completed', conclusion: 'cancelled' },
    { steps: [{ name: 'Set up job' }] },
    { runner_id: 42, runner_name: 'runner' },
    { head_sha: 'c'.repeat(40) },
    { run_attempt: 2 },
  ]) {
    const changedJobs = clone(jobs);
    changedJobs.jobs[1] = { ...apex, ...change };
    const value = fixture({ jobs: changedJobs });
    assert.throws(value.execute);
    assert.deepEqual(value.cancelled, []);
  }
  const duplicate = clone(jobs);
  duplicate.jobs.push(clone(apex));
  duplicate.total_count += 1;
  const value = fixture({ jobs: duplicate });
  assert.throws(value.execute);
  assert.deepEqual(value.cancelled, []);
});

test('rechecks live state immediately before cancellation', () => {
  const base = fixture();
  let pullReads = 0;
  const originalApi = (path) => {
    if (path === `repos/${repository}/pulls/${pullRequest}`) {
      pullReads += 1;
      const value = clone(pull);
      if (pullReads === 2) value.head.sha = 'c'.repeat(40);
      return value;
    }
    if (path.includes('/actions/workflows/salesforce-verify.yml/runs?'))
      return { total_count: 1, workflow_runs: [clone(run)] };
    if (path === `repos/${repository}/actions/runs/${runId}`) return clone(run);
    if (path.includes('/commits/')) return clone(association);
    if (path.includes('/jobs?')) return clone(jobs);
    throw new Error('Unexpected path');
  };
  assert.throws(() =>
    cancelSupersededSalesforceRun({
      api: originalApi,
      cancel: (path) => base.cancelled.push(path),
      repository,
      pullRequest,
      headSha,
      defaultBranch,
    }),
  );
  assert.deepEqual(base.cancelled, []);
});

test('trusted workflow has only the narrow cancellation capability', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/salesforce-supersede.yml', import.meta.url),
    'utf8',
  ).replaceAll('\r\n', '\n');
  assert.match(
    workflow,
    /pull_request_target:\n    branches: \[main\]\n    types: \[synchronize\]/,
  );
  assert.match(workflow, /^permissions: \{\}$/m);
  assert.match(
    workflow,
    /permissions:\n      actions: write\n      contents: read\n      pull-requests: read/,
  );
  assert.match(
    workflow,
    /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/,
  );
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /sparse-checkout: scripts/);
  assert.doesNotMatch(
    workflow,
    /pull_request\.head\.sha \}\}\n          persist|secrets\.|salesforce\/|sf org|workflow_dispatch/,
  );
  assert.equal((workflow.match(/actions: write/g) ?? []).length, 1);
  assert.match(
    workflow,
    /run: node scripts\/cancel-superseded-salesforce\.mjs/,
  );
});
