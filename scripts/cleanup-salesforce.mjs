import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSalesforceClient } from './salesforce-client.mjs';
import { cleanupRunIntents, validateIdentity } from './scratch-lifecycle.mjs';
import { readCleanupJournal } from './scratch-cleanup-journal.mjs';

/** Current CI attempt recovery only. Not an org selector or a cross-run janitor. */
export function runCleanup({
  env = process.env,
  args = [],
  sf,
  log = console.log,
  errorLog = console.error,
} = {}) {
  try {
    const identity = {
      ...validateIdentity({
        role: env.KUSANYA_VERIFY_ROLE,
        runId: env.KUSANYA_RUN_ID,
        sha: env.KUSANYA_HEAD_SHA,
      }),
      devHub: env.KUSANYA_DEV_HUB,
    };
    if (
      env.GITHUB_ACTIONS !== 'true' ||
      identity.role !== 'ci' ||
      !/^[A-Za-z0-9@._+-]+$/.test(identity.devHub ?? '') ||
      !Array.isArray(args) ||
      args.length !== 0 ||
      [
        'KUSANYA_TARGET_ORG',
        'KUSANYA_EXISTING_ORG',
        'SF_TARGET_ORG',
        'SFDX_DEFAULTUSERNAME',
      ].some((key) => env[key] !== undefined && env[key] !== '')
    )
      throw new Error();
    const journal = readCleanupJournal({ env, identity });
    const client =
      sf ??
      createSalesforceClient({
        cwd: fileURLToPath(new URL('../', import.meta.url)),
        env,
      });
    const result = cleanupRunIntents(client, {
      ...identity,
      tags: journal.tags,
      rejectedTags: journal.rejectedTags,
    });
    log(
      `Recovery cleanup for ${identity.runId} at ${identity.sha}: ${result.deleted} owned scratch org(s) deleted; ${result.alreadyDeleted} already deleted; ${result.rejected} confirmed rejected.`,
    );
    return { exitCode: 0, result };
  } catch {
    errorLog(
      'FAILED: current-attempt cleanup could not be confirmed; reconcile only this run’s recorded ownership tags privately. No retry is authorized.',
    );
    return { exitCode: 1 };
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = runCleanup({ args: process.argv.slice(2) }).exitCode;
}
