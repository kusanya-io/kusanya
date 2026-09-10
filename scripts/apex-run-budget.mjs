import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideInfrastructureRetry } from './apex-pr-policy.mjs';

const jobName = 'Scratch org tests and 85 percent coverage';
const outcomes = new Set([
  'passed',
  'failed-tests',
  'failed-infrastructure',
  'blocked-quota',
  'failed-cleanup',
]);

export function readVerificationMarker(log, { runId, attempt, headSha }) {
  if (typeof log !== 'string')
    throw new Error('Verification log is unavailable.');
  const records = [];
  for (const line of log.split(/\r?\n/)) {
    // gh prefixes actual log lines with job/step names and an ISO timestamp.
    // Do not accept a shell command that merely contains the marker's spelling.
    const match = line.match(
      /(?:^|\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z\s+)KUSANYA_VERIFICATION_RESULT (.*)\s*$/,
    );
    if (!match) continue;
    try {
      records.push(JSON.parse(match[1]));
    } catch {
      throw new Error('Verification marker is malformed.');
    }
  }
  if (records.length !== 1)
    throw new Error('Exactly one verification outcome marker is required.');
  const record = records[0];
  if (
    record.schemaVersion !== 1 ||
    record.role !== 'ci' ||
    record.runId !== `${runId}-${attempt}` ||
    record.headSha !== headSha ||
    typeof record.startedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.startedAt) ||
    !Number.isFinite(Date.parse(record.startedAt)) ||
    new Date(record.startedAt).toISOString() !== record.startedAt ||
    !outcomes.has(record.outcome) ||
    typeof record.retryable !== 'boolean' ||
    (['passed', 'failed-tests', 'failed-cleanup'].includes(record.outcome) &&
      record.retryable)
  )
    throw new Error('Verification marker does not match this exact attempt.');
  return {
    verificationOutcome: record.outcome,
    retryable: record.retryable,
    startedAt: record.startedAt,
  };
}

export function readVerificationSubject(log) {
  if (typeof log !== 'string')
    throw new Error('Verification subject log is unavailable.');
  const subjects = [];
  for (const line of log.split(/\r?\n/)) {
    const match = line.match(
      /(?:^|\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z\s+)Verifying PR (.*)\s*$/,
    );
    if (!match) continue;
    const subject = match[1]
      .trim()
      .match(/^([1-9][0-9]*) at head ([0-9a-f]{40})$/);
    if (!subject) throw new Error('Verification subject is malformed.');
    subjects.push({ pullRequest: subject[1], headSha: subject[2] });
  }
  if (subjects.length !== 1)
    throw new Error(
      'Exactly one trusted verification subject is required for a dispatched run.',
    );
  return subjects[0];
}

/** Read complete workflow history; never grant budget from missing logs or pages. */
export function collectAttempts({
  api,
  readLog,
  repository,
  headSha,
  runId,
  attempt,
}) {
  const runs = [];
  let total;
  for (let page = 1; page <= 10; page += 1) {
    const result = api(
      `repos/${repository}/actions/workflows/salesforce-verify.yml/runs?per_page=100&page=${page}`,
    );
    if (
      !Number.isSafeInteger(result?.total_count) ||
      result.total_count < 1 ||
      result.total_count > 1000 ||
      !Array.isArray(result.workflow_runs) ||
      (total !== undefined && result.total_count !== total)
    )
      throw new Error('Workflow history is incomplete or changing.');
    total = result.total_count;
    runs.push(...result.workflow_runs);
    if (runs.length === total) break;
    if (result.workflow_runs.length !== 100 || runs.length > total)
      throw new Error('Workflow history pagination is incomplete.');
  }
  if (runs.length !== total) throw new Error('Workflow history is incomplete.');
  const seen = new Set();
  const attempts = [];
  let foundCurrent = false;
  for (const run of runs) {
    if (
      !Number.isSafeInteger(run.id) ||
      run.id < 1 ||
      seen.has(run.id) ||
      !/^[a-f0-9]{40}$/.test(run.head_sha ?? '') ||
      !['pull_request', 'workflow_dispatch'].includes(run.event) ||
      !Number.isSafeInteger(run.run_attempt) ||
      run.run_attempt < 1 ||
      run.run_attempt > 100
    )
      throw new Error('Unexpected workflow run identity.');
    seen.add(run.id);
    if (run.event === 'pull_request' && run.head_sha !== headSha) {
      if (String(run.id) === runId)
        throw new Error('Current pull request run has the wrong head.');
      continue;
    }
    for (let number = 1; number <= run.run_attempt; number += 1) {
      if (String(run.id) === runId && number === attempt) {
        foundCurrent = true;
        continue;
      }
      const previous = api(
        `repos/${repository}/actions/runs/${run.id}/attempts/${number}`,
      );
      if (
        previous?.id !== run.id ||
        previous.run_attempt !== number ||
        previous.head_sha !== run.head_sha ||
        previous.event !== run.event ||
        !Number.isFinite(Date.parse(previous.run_started_at))
      )
        throw new Error('Historical attempt identity is incomplete.');
      if (previous.status !== 'completed')
        throw new Error('Another attempt for this head has not finished.');
      const jobResult = api(
        `repos/${repository}/actions/runs/${run.id}/attempts/${number}/jobs?per_page=100`,
      );
      if (
        !Number.isSafeInteger(jobResult?.total_count) ||
        !Array.isArray(jobResult.jobs) ||
        jobResult.total_count !== jobResult.jobs.length
      )
        throw new Error('Historical jobs are incomplete.');
      const matching = jobResult.jobs.filter((job) => job.name === jobName);
      if (matching.length !== 1)
        throw new Error('Historical Apex job is ambiguous.');
      const job = matching[0];
      // A wholly skipped job never entered the credentialed lifecycle.
      if (
        job.conclusion === 'skipped' &&
        Array.isArray(job.steps) &&
        job.steps.length === 0
      )
        continue;
      if (
        !Number.isSafeInteger(job.id) ||
        job.id < 1 ||
        job.status !== 'completed' ||
        !Number.isFinite(Date.parse(job.started_at))
      )
        throw new Error('Historical Apex job has not finished.');
      const log = readLog(run.id, number, job.id);
      const reviewedHead =
        run.event === 'workflow_dispatch'
          ? readVerificationSubject(log).headSha
          : run.head_sha;
      if (reviewedHead !== headSha) continue;
      const marker = readVerificationMarker(log, {
        runId: String(run.id),
        attempt: number,
        headSha: reviewedHead,
      });
      if (
        (marker.verificationOutcome === 'passed') !==
        (job.conclusion === 'success')
      )
        throw new Error('Apex outcome disagrees with job completion.');
      attempts.push({
        runId: String(run.id),
        attempt: number,
        headSha: reviewedHead,
        status: previous.status,
        conclusion: job.conclusion,
        ...marker,
      });
    }
  }
  if (!foundCurrent) throw new Error('Current run is absent from history.');
  return attempts;
}

function gh(args) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    shell: false,
    timeout: 60000,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error('Read-only GitHub history request failed.');
  return result.stdout;
}

export function runBudget({
  env = process.env,
  now = new Date(),
  api,
  readLog,
}) {
  const repository = env.KUSANYA_POLICY_REPOSITORY;
  const headSha = env.KUSANYA_POLICY_HEAD_SHA;
  const runId = env.GITHUB_RUN_ID;
  const attempt = Number(env.GITHUB_RUN_ATTEMPT);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(
      repository ?? '',
    ) ||
    !/^[0-9a-f]{40}$/.test(headSha ?? '') ||
    !/^[1-9][0-9]*$/.test(runId ?? '') ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    attempt > 100 ||
    !Number.isFinite(now.getTime())
  )
    throw new Error('Explicit valid workflow and head identity is required.');
  const attempts = collectAttempts({
    api,
    readLog,
    repository,
    headSha,
    runId,
    attempt,
  });
  return decideInfrastructureRetry({
    headSha,
    utcDay: now.toISOString().slice(0, 10),
    attempts,
    currentRunId: runId,
    currentAttempt: attempt,
    historyComplete: true,
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.length !== 2)
      throw new Error('No arguments are accepted.');
    const decision = runBudget({
      api: (path) => JSON.parse(gh(['api', path])),
      readLog: (id, attempt, job) =>
        gh([
          'run',
          'view',
          String(id),
          '--repo',
          process.env.KUSANYA_POLICY_REPOSITORY,
          '--attempt',
          String(attempt),
          '--job',
          String(job),
          '--log',
        ]),
    });
    console.log(JSON.stringify(decision));
    if (!decision.allowed) process.exitCode = 1;
  } catch {
    console.error(
      'FAILED: retry eligibility could not be established from complete exact-head history; no org creation is authorized.',
    );
    process.exitCode = 1;
  }
}
