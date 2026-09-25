import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const apexJobName = 'Scratch org tests and 85 percent coverage';
const workflowName = 'Salesforce verification';
const workflowPath = '.github/workflows/salesforce-verify.yml';
const shaPattern = /^[0-9a-f]{40}$/;

function fail(message) {
  throw new Error(message);
}

function identity(value, expected) {
  if (value !== expected)
    fail('GitHub state changed or has an unexpected identity.');
}

function readPullRequest(value, subject) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Number.isSafeInteger(value.number) ||
    value.number !== subject.pullRequest ||
    value.state !== 'open' ||
    value.base?.ref !== subject.defaultBranch ||
    value.base?.repo?.full_name !== subject.repository ||
    value.head?.repo?.full_name !== subject.repository ||
    value.head?.sha !== subject.headSha ||
    !shaPattern.test(value.head.sha) ||
    typeof value.head.ref !== 'string' ||
    !/^[A-Za-z0-9._/-]{1,255}$/.test(value.head.ref)
  )
    fail('The live pull request does not match the trusted event.');
  return { ...subject, headRef: value.head.ref };
}

function readRun(value, subject) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Number.isSafeInteger(value.id) ||
    value.id < 1 ||
    value.name !== workflowName ||
    value.path !== workflowPath ||
    value.event !== 'pull_request' ||
    !Number.isSafeInteger(value.run_attempt) ||
    value.run_attempt < 1 ||
    value.run_attempt > 100 ||
    !shaPattern.test(value.head_sha ?? '') ||
    value.head_sha === subject.headSha ||
    value.head_branch !== subject.headRef ||
    value.repository?.full_name !== subject.repository ||
    value.head_repository?.full_name !== subject.repository ||
    value.status !== 'waiting' ||
    value.conclusion !== null
  )
    fail('A candidate run is not a superseded waiting pull-request run.');
  return value;
}

function readApexJob(value, run) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Number.isSafeInteger(value.total_count) ||
    !Array.isArray(value.jobs) ||
    value.total_count !== value.jobs.length ||
    value.total_count < 1 ||
    value.total_count > 20
  )
    fail('Candidate job data is incomplete.');
  const matches = value.jobs.filter((job) => job?.name === apexJobName);
  if (matches.length !== 1) fail('Candidate Apex job is ambiguous.');
  const job = matches[0];
  if (
    !Number.isSafeInteger(job.id) ||
    job.id < 1 ||
    job.run_id !== run.id ||
    job.run_attempt !== run.run_attempt ||
    job.head_sha !== run.head_sha ||
    job.status !== 'waiting' ||
    job.conclusion !== null ||
    !Array.isArray(job.steps) ||
    job.steps.length !== 0 ||
    (job.runner_id !== 0 && job.runner_id !== null) ||
    (job.runner_name !== '' && job.runner_name !== null)
  )
    fail('Candidate Apex job may have started or has an unexpected identity.');
  return job;
}

function readPullAssociation(value, subject) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100)
    fail('Candidate pull-request association is incomplete.');
  const matches = value.filter(
    (pull) =>
      pull?.number === subject.pullRequest &&
      pull?.state === 'open' &&
      pull?.base?.ref === subject.defaultBranch &&
      pull?.base?.repo?.full_name === subject.repository &&
      pull?.head?.ref === subject.headRef &&
      pull?.head?.repo?.full_name === subject.repository,
  );
  if (matches.length !== 1)
    fail('Candidate head is not uniquely associated with this pull request.');
}

function collectRuns(api, subject) {
  const runs = [];
  const seen = new Set();
  let total;
  for (let page = 1; page <= 10; page += 1) {
    const value = api(
      `repos/${subject.repository}/actions/workflows/salesforce-verify.yml/runs?event=pull_request&status=waiting&per_page=100&page=${page}`,
    );
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !Number.isSafeInteger(value.total_count) ||
      value.total_count < 0 ||
      value.total_count > 1000 ||
      !Array.isArray(value.workflow_runs) ||
      (total !== undefined && value.total_count !== total)
    )
      fail('Waiting-run history is incomplete or changing.');
    total = value.total_count;
    for (const run of value.workflow_runs) {
      if (!Number.isSafeInteger(run?.id) || run.id < 1 || seen.has(run.id))
        fail('Waiting-run history contains an invalid or duplicate identity.');
      seen.add(run.id);
      runs.push(run);
    }
    if (runs.length === total) return runs;
    if (value.workflow_runs.length !== 100 || runs.length > total)
      fail('Waiting-run history pagination is incomplete.');
  }
  fail('Waiting-run history exceeds the review bound.');
}

function readSubject({ repository, pullRequest, headSha, defaultBranch }) {
  if (
    typeof repository !== 'string' ||
    !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository) ||
    !Number.isSafeInteger(pullRequest) ||
    pullRequest < 1 ||
    !shaPattern.test(headSha ?? '') ||
    typeof defaultBranch !== 'string' ||
    !/^[A-Za-z0-9._/-]{1,255}$/.test(defaultBranch)
  )
    fail('The trusted event identity is invalid.');
  return { repository, pullRequest, headSha, defaultBranch };
}

export function cancelSupersededSalesforceRun({
  api,
  cancel,
  repository,
  pullRequest,
  headSha,
  defaultBranch,
}) {
  if (typeof api !== 'function' || typeof cancel !== 'function')
    fail('GitHub adapters are required.');
  let subject = readSubject({
    repository,
    pullRequest,
    headSha,
    defaultBranch,
  });
  const pullPath = `repos/${repository}/pulls/${pullRequest}`;
  subject = readPullRequest(api(pullPath), subject);
  const candidates = collectRuns(api, subject).filter(
    (run) =>
      run?.head_sha !== subject.headSha &&
      run?.head_branch === subject.headRef &&
      run?.repository?.full_name === subject.repository &&
      run?.head_repository?.full_name === subject.repository,
  );
  if (candidates.length === 0) return { outcome: 'none' };
  if (candidates.length !== 1)
    fail('More than one superseded waiting run requires manual review.');

  const first = readRun(candidates[0], subject);
  const associationPath = `repos/${repository}/commits/${first.head_sha}/pulls?per_page=100`;
  readPullAssociation(api(associationPath), subject);
  const jobsPath = `repos/${repository}/actions/runs/${first.id}/attempts/${first.run_attempt}/jobs?per_page=100`;
  readApexJob(api(jobsPath), first);

  // Close the time-of-check/time-of-use window as far as the API permits.
  subject = readPullRequest(api(pullPath), subject);
  const current = readRun(
    api(`repos/${repository}/actions/runs/${first.id}`),
    subject,
  );
  identity(current.id, first.id);
  identity(current.run_attempt, first.run_attempt);
  identity(current.head_sha, first.head_sha);
  readPullAssociation(api(associationPath), subject);
  readApexJob(api(jobsPath), current);

  cancel(`repos/${repository}/actions/runs/${current.id}/cancel`);
  return { outcome: 'cancelled' };
}

function ghApi(path) {
  return JSON.parse(
    execFileSync('gh', ['api', path], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    }),
  );
}

function ghCancel(path) {
  execFileSync('gh', ['api', '--method', 'POST', path], {
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: 30_000,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = cancelSupersededSalesforceRun({
    api: ghApi,
    cancel: ghCancel,
    repository: process.env.KUSANYA_SUPERSEDE_REPOSITORY,
    pullRequest: Number(process.env.KUSANYA_SUPERSEDE_PR_NUMBER),
    headSha: process.env.KUSANYA_SUPERSEDE_HEAD_SHA,
    defaultBranch: process.env.KUSANYA_SUPERSEDE_DEFAULT_BRANCH,
  });
  process.stdout.write(
    result.outcome === 'cancelled'
      ? 'Cancelled one superseded, zero-step waiting Salesforce run.\n'
      : 'No superseded, zero-step waiting Salesforce run exists.\n',
  );
}
