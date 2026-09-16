/** Offline engine probe only. Never downloads dependencies, authenticates, or creates an org. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  compiledFixtures,
  createOutput,
  exportFixtures,
} from './export-fixtures.mjs';

const [java, javac, jarDirectory, ...extra] = process.argv.slice(2);
if (
  !java ||
  !javac ||
  !jarDirectory ||
  extra.length ||
  !isAbsolute(java) ||
  !isAbsolute(javac) ||
  !isAbsolute(jarDirectory)
)
  throw new Error(
    'Usage: node scripts/runtime/check-javarosa.mjs <absolute-java> <absolute-javac> <absolute-jar-directory>',
  );

const here = dirname(fileURLToPath(import.meta.url));
const dependencies = JSON.parse(
  readFileSync(join(here, 'javarosa-dependencies.json'), 'utf8'),
).artifacts;
const jars = dependencies.map(({ file, sha256 }) => {
  if (!/^[a-z0-9.-]+\.jar$/.test(file) || !/^[0-9a-f]{64}$/.test(sha256))
    throw new Error('Invalid reviewed dependency manifest.');
  const path = join(jarDirectory, file);
  if (createHash('sha256').update(readFileSync(path)).digest('hex') !== sha256)
    throw new Error(`Dependency checksum mismatch: ${file}`);
  return path;
});

const output = createOutput('runtime-javarosa-');
const childEnv = Object.fromEntries(
  ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'LANG', 'LC_ALL']
    .filter((name) => process.env[name] !== undefined)
    .map((name) => [name, process.env[name]]),
);
function child(executable, args, logName) {
  const result = spawnSync(executable, args, {
    cwd: output,
    env: childEnv,
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const log = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  writeFileSync(join(output, logName), log, 'utf8');
  if (result.error || result.signal || result.status !== 0)
    throw new Error(
      `JavaRosa diagnostic failed; inspect ${join(output, logName)}`,
    );
  process.stdout.write(log);
  return log.trim();
}

const manifest = exportFixtures(output, compiledFixtures());
const fixtures = ['nested.xml', 'section.xml'].map((name) =>
  join(output, name),
);
const javaVersion = child(java, ['-Xmx256m', '-version'], 'java-version.txt');
const javacVersion = child(
  javac,
  ['-J-Xmx256m', '-version'],
  'javac-version.txt',
);
child(
  javac,
  [
    '-J-Xmx256m',
    '-encoding',
    'UTF-8',
    '--release',
    '21',
    '-implicit:none',
    '-cp',
    jars.join(delimiter),
    '-d',
    output,
    join(here, 'RepeatProbe.java'),
  ],
  'javac.txt',
);
child(
  java,
  [
    '-Xmx256m',
    '-Djava.awt.headless=true',
    '-cp',
    [output, ...jars].join(delimiter),
    'RepeatProbe',
    ...fixtures,
  ],
  'runtime.txt',
);
const drafts = Object.fromEntries(
  [
    'nested-draft.xml',
    'nested-reduced.xml',
    'section-draft.xml',
    'section-reduced.xml',
  ].map((name) => [
    name,
    {
      sha256: createHash('sha256')
        .update(readFileSync(join(output, name)))
        .digest('hex'),
    },
  ]),
);
writeFileSync(
  join(output, 'report.json'),
  `${JSON.stringify(
    {
      engine: 'JavaRosa',
      version: '6.0.0',
      status: 'passed',
      generatedAtUtc: new Date().toISOString(),
      syntheticOnly: true,
      collectUiVerified: false,
      acceptanceTestsClaimed: [],
      javaVersion,
      javacVersion,
      fixtures: manifest.files,
      drafts,
      dependencies: Object.fromEntries(
        dependencies.map(({ file, sha256 }) => [file, { sha256 }]),
      ),
    },
    null,
    2,
  )}\n`,
  { flag: 'wx' },
);
console.log(
  `JavaRosa 6.0.0 synthetic artifacts retained only in ignored ${output}`,
);
console.log(
  'Engine regression evidence only: no Collect Android UI, Enketo, Salesforce, namespace or C10 claim.',
);
