import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { checkApexCoverage, productionApexNames } from './apex-coverage.mjs';

const directory = process.env.KUSANYA_SALESFORCE_DIR
  ? resolve(process.env.KUSANYA_SALESFORCE_DIR)
  : fileURLToPath(new URL('../salesforce/', import.meta.url));
const devHub = process.env.KUSANYA_DEV_HUB;
const alias = `kusanya-verify-${randomUUID()}`;
let created = false;
function sf(stage, args) {
  const cliArgs = [...args, '--json'];
  // All arguments are fixed flags/paths or a validated alias. Reject shell syntax
  // before invoking the Windows batch launcher; never concatenate arbitrary input.
  if (!cliArgs.every((arg) => /^[A-Za-z0-9@._+/-]+$/.test(arg)))
    throw new Error('Unsafe Salesforce CLI argument.');
  const windows = process.platform === 'win32';
  const result = spawnSync(
    windows ? 'cmd.exe' : 'sf',
    windows ? ['/d', '/c', `sf ${cliArgs.join(' ')}`] : cliArgs,
    {
      cwd: directory,
      encoding: 'utf8',
      shell: false,
      env: {
        ...process.env,
        SF_DISABLE_LOG_FILE: 'true',
        SF_DISABLE_TELEMETRY: 'true',
      },
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  // Do not echo raw CLI auth/error output; it can include credentials.
  if (result.error || result.status !== 0)
    throw new Error(
      `${stage} failed; inspect privately with Salesforce CLI. No raw auth output was logged.`,
    );
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`${stage} returned invalid JSON.`);
  }
  if (parsed.status !== 0) throw new Error(`${stage} did not succeed.`);
  return parsed;
}
try {
  if (!devHub || !/^[A-Za-z0-9@._+-]+$/.test(devHub))
    throw new Error(
      'Set KUSANYA_DEV_HUB to an explicitly authorised authenticated Dev Hub alias or username.',
    );
  const orgs = sf('Dev Hub discovery', ['org', 'list', '--all']);
  const hub = orgs.result.nonScratchOrgs?.find(
    (org) =>
      (org.alias === devHub || org.username === devHub) &&
      org.isDevHub === true,
  );
  if (!hub)
    throw new Error(
      'KUSANYA_DEV_HUB is not an authenticated Dev Hub. No org was created or changed.',
    );
  console.log(
    `Creating one-day disposable scratch org ${alias} for Phase 0 verification.`,
  );
  sf('Scratch creation', [
    'org',
    'create',
    'scratch',
    '--target-dev-hub',
    devHub,
    '--definition-file',
    'config/project-scratch-def.json',
    '--alias',
    alias,
    '--duration-days',
    '1',
    '--wait',
    '15',
  ]);
  created = true;
  sf('Source deployment', [
    'project',
    'deploy',
    'start',
    '--source-dir',
    'force-app',
    '--target-org',
    alias,
    '--wait',
    '15',
  ]);
  const report = sf('Apex test execution', [
    'apex',
    'run',
    'test',
    '--target-org',
    alias,
    '--test-level',
    'RunLocalTests',
    '--code-coverage',
    '--result-format',
    'json',
    '--wait',
    '15',
  ]);
  const outcome = checkApexCoverage(
    report,
    productionApexNames(join(directory, 'force-app')),
  );
  console.log(
    `Apex: ${outcome.tests} passed; ${outcome.covered}/${outcome.total} lines covered (${outcome.percentage.toFixed(2)}%). No C10 acceptance test is claimed.`,
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (created) {
    try {
      sf('Scratch cleanup', [
        'org',
        'delete',
        'scratch',
        '--target-org',
        alias,
        '--no-prompt',
      ]);
      console.log(
        'Deleted only the disposable scratch org created by this verification run.',
      );
    } catch {
      console.error(
        `Scratch cleanup failed. Maintainer must delete scratch alias ${alias}; it expires after one day.`,
      );
      process.exitCode = 1;
    }
  }
}
