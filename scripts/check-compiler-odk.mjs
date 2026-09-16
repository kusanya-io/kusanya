/** Optional, offline synthetic compiler probe. Never authenticates or creates an org. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { compileForm } from '../service/dist/src/compiler/compile.js';
import { odkFixtures } from '../service/dist/test/fixtures/compiler.js';

const [jar, java, ...extra] = process.argv.slice(2);
const digest =
  '92756ea4aed195355a07e5572f025f0921a31282387a870ae63e1f5cdf37e0c3';
if (!jar || !java || !isAbsolute(java) || extra.length)
  throw new Error(
    'Usage: node scripts/check-compiler-odk.mjs <ODK-Validate-v1.20.0.jar> <absolute-java-executable>',
  );
if (createHash('sha256').update(readFileSync(jar)).digest('hex') !== digest)
  throw new Error(
    'ODK Validate jar does not match the reviewed v1.20.0 SHA-256.',
  );

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'work'), { recursive: true });
const output = mkdtempSync(join(root, 'work', 'compiler-odk-'));
const childEnvironment = Object.fromEntries(
  ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'LANG', 'LC_ALL']
    .filter((name) => process.env[name] !== undefined)
    .map((name) => [name, process.env[name]]),
);
function validate(name, xml, expectedValid) {
  const path = join(output, `${name}.xml`);
  writeFileSync(path, xml, 'utf8');
  const result = spawnSync(
    java,
    ['-Xmx256m', '-Djava.awt.headless=true', '-jar', resolve(jar), path],
    {
      encoding: 'utf8',
      shell: false,
      cwd: root,
      env: childEnvironment,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    },
  );
  writeFileSync(
    join(output, `${name}.txt`),
    `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    'utf8',
  );
  if (result.error || result.signal || result.status === null)
    throw new Error(
      `Validator infrastructure failure for synthetic fixture ${name}.`,
    );
  if (expectedValid ? result.status !== 0 : result.status === 0)
    throw new Error(
      `Unexpected validator result for synthetic fixture ${name}; exit ${result.status}. See ${output}`,
    );
  console.log(
    `${name}: ${expectedValid ? 'valid' : 'invalid negative control'} (exit ${result.status})`,
  );
}
for (const [name, build] of Object.entries(odkFixtures)) {
  const result = compileForm(build());
  if (!result.ok)
    throw new Error(`Compiler rejected synthetic fixture ${name}.`);
  validate(name, result.xml, true);
}
validate('negative-control', '<not-an-xform/>', false);
const baseline = compileForm(odkFixtures.scalars());
if (!baseline.ok) throw new Error('Negative-control baseline did not compile.');
const invalidXPath = baseline.xml.replace(
  'concat(&apos;uuid:&apos;, uuid())',
  'unsupported-function()',
);
if (invalidXPath === baseline.xml)
  throw new Error('Negative-control expression was not replaced.');
validate('negative-xpath', invalidXPath, false);
console.log(`ODK Validate 1.20.0 / JavaRosa 5.1.0; SHA-256 ${digest}`);
console.log(`Synthetic artifacts/logs retained only in ignored ${output}`);
console.log(
  'Definition validation only: no Collect/Enketo runtime or C10 acceptance claim.',
);
