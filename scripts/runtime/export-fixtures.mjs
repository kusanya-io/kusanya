/** Export synthetic, deterministic compiler outputs. No network, auth or device writes. */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { compileForm } from '../../service/dist/src/compiler/compile.js';
import {
  nestedCountRuntimeForm,
  sectionCountRuntimeForm,
} from '../../service/dist/test/fixtures/repeat-runtime.js';

export function compiledFixtures() {
  return Object.fromEntries(
    Object.entries({
      nested: nestedCountRuntimeForm,
      section: sectionCountRuntimeForm,
    }).map(([name, build]) => {
      const result = compileForm(build());
      if (!result.ok)
        throw new Error(`Synthetic ${name} fixture failed compilation`);
      return [name, result.xml];
    }),
  );
}

export function createOutput(prefix) {
  if (!/^[a-z-]+$/.test(prefix))
    throw new Error('Invalid internal output prefix');
  const work = fileURLToPath(new URL('../../work/', import.meta.url));
  mkdirSync(work, { recursive: true });
  return mkdtempSync(join(work, prefix));
}

export function exportFixtures(output, fixtures) {
  const manifest = {
    syntheticOnly: true,
    acceptanceTestsClaimed: [],
    files: {},
  };
  for (const [name, xml] of Object.entries(fixtures)) {
    if (!['nested', 'section'].includes(name))
      throw new Error('Unknown synthetic fixture');
    const filename = `${name}.xml`;
    writeFileSync(join(output, filename), xml, {
      encoding: 'utf8',
      flag: 'wx',
    });
    manifest.files[filename] = {
      sha256: createHash('sha256').update(xml).digest('hex'),
    };
  }
  writeFileSync(
    join(output, 'fixtures.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: 'wx' },
  );
  return manifest;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  if (process.argv.length !== 2)
    throw new Error('Usage: node scripts/runtime/export-fixtures.mjs');
  const output = createOutput('runtime-fixtures-');
  exportFixtures(output, compiledFixtures());
  console.log(`Synthetic forms and SHA-256 manifest: ${output}`);
  console.log('No Collect, C10, namespace or publication compatibility claim.');
}
