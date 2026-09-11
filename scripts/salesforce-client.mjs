import { spawnSync } from 'node:child_process';

const codes = new Set([
  'INVALID_INPUT',
  'CLI_NOT_FOUND',
  'INVALID_JSON',
  'CLI_FAILED',
  'AUTH',
  'NETWORK',
  'TIMEOUT',
  'SCRATCH_QUOTA',
  'CREATION_REJECTED',
]);
const transientStages = new Set([
  'quota-read',
  'scratch-read',
  'scratch-create',
  'source-deploy',
]);
export class SalesforceCommandError extends Error {
  constructor(code, stage = 'salesforce-operation', jobId) {
    const safeCode = codes.has(code) ? code : 'CLI_FAILED';
    const safeStage = /^[a-z][a-z0-9-]{0,47}$/.test(stage)
      ? stage
      : 'salesforce-operation';
    super(
      `Salesforce operation ${safeStage} failed (${safeCode}); raw CLI output withheld.`,
    );
    this.name = 'SalesforceCommandError';
    this.code = safeCode;
    this.stage = safeStage;
    this.exitCode = safeCode === 'SCRATCH_QUOTA' ? 75 : 1;
    this.retryable =
      safeCode === 'SCRATCH_QUOTA' ||
      (['NETWORK', 'TIMEOUT'].includes(safeCode) &&
        transientStages.has(safeStage));
    if (
      typeof jobId === 'string' &&
      /^2SR[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(jobId)
    )
      this.jobId = jobId;
  }
}
function classify(parsed, processError, stage) {
  if (processError?.code === 'ETIMEDOUT') return 'TIMEOUT';
  // A transport/process failure cannot establish a positive provider rejection.
  if (processError) parsed = null;
  const name = parsed?.name ?? parsed?.code ?? processError?.code;
  const message = typeof parsed?.message === 'string' ? parsed.message : '';
  if (
    stage === 'scratch-create' &&
    ['REQUEST_LIMIT_EXCEEDED', 'LIMIT_EXCEEDED'].includes(name) &&
    /(?:daily.*(?:scratch|signup).*limit|maximum.*scratch org|cannot create more than.*scratch org|scratch org.*(?:daily|active).*limit)/i.test(
      message,
    )
  )
    return 'SCRATCH_QUOTA';
  // Salesforce core emits this only after ScratchOrgInfo reaches Error with
  // a recognized signup ErrorCode. Still reconcile the exact request/tag before
  // deciding cleanup is unnecessary; a generic CLI failure proves nothing.
  if (stage === 'scratch-create' && name === 'RemoteOrgSignupFailed')
    return 'CREATION_REJECTED';
  if (
    [
      'ScratchOrgInfoTimeoutError',
      'ScratchOrgResumeTimeOutError',
      'ETIMEDOUT',
      'EAI_AGAIN',
      'ECONNRESET',
      'ENOTFOUND',
      'ECONNREFUSED',
    ].includes(name)
  )
    return /Timeout|TimeOut|ETIMEDOUT/.test(name) ? 'TIMEOUT' : 'NETWORK';
  if (
    [
      'INVALID_SESSION_ID',
      'INVALID_AUTH_HEADER',
      'invalid_grant',
      'AuthError',
    ].includes(name)
  )
    return 'AUTH';
  if (name === 'ENOENT') return 'CLI_NOT_FOUND';
  return 'CLI_FAILED';
}
/** Synchronous CLI adapter. Success envelopes stay private to callers; errors never contain CLI output. */
export function createSalesforceClient({
  cwd,
  env = process.env,
  spawn = spawnSync,
  platform = process.platform,
}) {
  return (stage, args) => {
    if (
      !Array.isArray(args) ||
      args.length === 0 ||
      args.some(
        (arg) => typeof arg !== 'string' || !arg || /[\x00-\x1f\x7f]/.test(arg),
      )
    )
      throw new SalesforceCommandError('INVALID_INPUT', stage);
    const cliArgs = [...args, '--json'];
    // Quoted Windows arguments permit SOQL spaces/single quotes. Reject cmd expansion/control syntax.
    if (platform === 'win32' && cliArgs.some((arg) => /["%!&|<>^]/.test(arg)))
      throw new SalesforceCommandError('INVALID_INPUT', stage);
    let result;
    try {
      result = spawn(
        platform === 'win32' ? 'cmd.exe' : 'sf',
        platform === 'win32'
          ? [
              '/d',
              '/s',
              '/c',
              `sf ${cliArgs.map((arg) => `"${arg}"`).join(' ')}`,
            ]
          : cliArgs,
        {
          cwd,
          encoding: 'utf8',
          shell: false,
          env: {
            ...env,
            SF_DISABLE_LOG_FILE: 'true',
            SF_DISABLE_TELEMETRY: 'true',
          },
          maxBuffer: 20 * 1024 * 1024,
          timeout: ['scratch-create', 'source-deploy', 'apex-tests'].includes(
            stage,
          )
            ? 6 * 60 * 1000
            : 30 * 1000,
          killSignal: 'SIGKILL',
        },
      );
    } catch {
      throw new SalesforceCommandError('CLI_FAILED', stage);
    }
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new SalesforceCommandError(
        result.error ? classify(null, result.error, stage) : 'INVALID_JSON',
        stage,
      );
    }
    if (result.error || result.status !== 0 || parsed?.status !== 0)
      throw new SalesforceCommandError(
        classify(parsed, result.error, stage),
        stage,
        parsed?.data?.scratchOrgInfoId ??
          parsed?.data?.jobId ??
          parsed?.result?.jobId,
      );
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Object.hasOwn(parsed, 'result')
    )
      throw new SalesforceCommandError('INVALID_JSON', stage);
    return parsed;
  };
}
