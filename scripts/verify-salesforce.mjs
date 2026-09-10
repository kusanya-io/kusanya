import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { checkApexCoverage, productionApexNames } from './apex-coverage.mjs';
import {
  createSalesforceClient,
  SalesforceCommandError,
} from './salesforce-client.mjs';
import {
  acquireScratchOrgs,
  cleanupOwnedOrgs,
  LifecycleError,
  QuotaBlockedError,
  validateIdentity,
} from './scratch-lifecycle.mjs';

const defaultDirectory = fileURLToPath(
  new URL('../salesforce/', import.meta.url),
);

/** Fresh-only Phase-0 suite. Dependencies are injectable for secret-free fixtures. */
export function runVerification({
  env = process.env,
  args = [],
  sf: suppliedClient,
  log = console.log,
  errorLog = console.error,
  now = new Date(),
  nonce,
  sourceNames = productionApexNames,
  coverage = checkApexCoverage,
} = {}) {
  const result = {
    schemaVersion: 1,
    role: null,
    runId: null,
    headSha: null,
    outcome: 'failed-infrastructure',
    retryable: false,
  };
  let exitCode = 1;
  let sf;
  let orgs = [];
  let testing = false;
  try {
    const identity = validateIdentity({
      role: env.KUSANYA_VERIFY_ROLE,
      runId: env.KUSANYA_RUN_ID,
      sha: env.KUSANYA_HEAD_SHA,
    });
    Object.assign(result, {
      role: identity.role,
      runId: identity.runId,
      headSha: identity.sha,
    });
    if (
      !Array.isArray(args) ||
      args.length !== 0 ||
      [
        'KUSANYA_TARGET_ORG',
        'KUSANYA_EXISTING_ORG',
        'SF_TARGET_ORG',
        'SFDX_DEFAULTUSERNAME',
      ].some((key) => env[key] !== undefined && env[key] !== '')
    )
      throw new LifecycleError();
    const devHub = env.KUSANYA_DEV_HUB;
    if (typeof devHub !== 'string' || !/^[A-Za-z0-9@._+-]+$/.test(devHub))
      throw new LifecycleError();
    const directory = env.KUSANYA_SALESFORCE_DIR
      ? resolve(env.KUSANYA_SALESFORCE_DIR)
      : defaultDirectory;
    sf = suppliedClient ?? createSalesforceClient({ cwd: directory, env });
    const discovered = sf('hub-discovery', ['org', 'list', '--all']).result;
    if (
      !Array.isArray(discovered?.nonScratchOrgs) ||
      !discovered.nonScratchOrgs.some(
        (org) =>
          (org.alias === devHub || org.username === devHub) &&
          org.isDevHub === true,
      )
    )
      throw new LifecycleError();
    log(
      `Fresh verification: role ${identity.role}, run ${identity.runId}, head ${identity.sha}.`,
    );
    const acquired = acquireScratchOrgs(sf, {
      devHub,
      ...identity,
      count: 1,
      now,
      ...(nonce ? { nonce } : {}),
      onEvent: log,
    });
    orgs = acquired.orgs;
    const target = orgs[0].username;
    sf('source-deploy', [
      'project',
      'deploy',
      'start',
      '--source-dir',
      'force-app',
      '--target-org',
      target,
      '--wait',
      '15',
    ]);
    testing = true;
    const report = sf('apex-tests', [
      'apex',
      'run',
      'test',
      '--target-org',
      target,
      '--test-level',
      'RunLocalTests',
      '--code-coverage',
      '--result-format',
      'json',
      '--wait',
      '15',
    ]);
    const measured = coverage(
      report,
      sourceNames(join(directory, 'force-app')),
    );
    log(
      `Apex for ${identity.sha}: ${measured.tests} passed; ${measured.covered}/${measured.total} executable lines (${measured.percentage.toFixed(2)}%). No C10 acceptance test is claimed.`,
    );
    result.outcome = 'passed';
    exitCode = 0;
  } catch (error) {
    if (
      error instanceof LifecycleError &&
      ['CLEANUP_FAILED', 'RECONCILIATION_REQUIRED'].includes(error.code)
    ) {
      result.outcome = 'failed-cleanup';
    } else if (testing) {
      result.outcome = 'failed-tests';
    } else if (error instanceof QuotaBlockedError) {
      result.outcome = 'blocked-quota';
      result.retryable = true;
      exitCode = 75;
    } else if (error instanceof SalesforceCommandError) {
      result.retryable = error.retryable === true;
    }
    if (
      error instanceof QuotaBlockedError ||
      error instanceof LifecycleError ||
      error instanceof SalesforceCommandError
    )
      errorLog(error.message);
    else
      errorLog('Verification failed; unrecognized exception details withheld.');
  } finally {
    if (orgs.length !== 0) {
      try {
        const cleanup = cleanupOwnedOrgs(sf, orgs);
        log(
          `Cleanup for ${result.headSha}: ${cleanup.deleted} owned scratch org(s) deleted; ${cleanup.alreadyDeleted} already deleted.`,
        );
      } catch {
        result.outcome = 'failed-cleanup';
        result.retryable = false;
        exitCode = 1;
        errorLog(
          'Owned scratch cleanup failed; maintainer reconciliation is required before any retry.',
        );
      }
    }
    log(`KUSANYA_VERIFICATION_RESULT ${JSON.stringify(result)}`);
  }
  return { exitCode, result };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = runVerification({ args: process.argv.slice(2) }).exitCode;
}
