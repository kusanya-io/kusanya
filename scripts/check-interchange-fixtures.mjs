/** Offline synthetic interchange round trips only. No input files, orgs, installs or publication. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileForm } from '../service/dist/src/compiler/compile.js';
import {
  exportAuthoringBundle,
  importAuthoringBundle,
} from '../service/dist/src/interchange/bundle.js';
import {
  exportXlsFormTables,
  importXlsFormTables,
} from '../service/dist/src/interchange/xlsform-tables.js';
import { odkFixtures } from '../service/dist/test/fixtures/compiler.js';
import {
  reviewerFixture,
  largeReviewerFixture,
} from '../service/dist/test/fixtures/print.js';
import {
  nestedCountRuntimeForm,
  sectionCountRuntimeForm,
} from '../service/dist/test/fixtures/repeat-runtime.js';

if (process.argv.length !== 2)
  throw new Error('Usage: node scripts/check-interchange-fixtures.mjs');
const root = fileURLToPath(new URL('../', import.meta.url));
mkdirSync(join(root, 'work'), { recursive: true });
const output = mkdtempSync(join(root, 'work', 'interchange-'));
const fixtures = {
  ...Object.fromEntries(
    Object.entries(odkFixtures).map(([name, build]) => [
      name,
      () => ({ form: build(), mappings: { schemaVersion: 1, mappings: [] } }),
    ]),
  ),
  review: reviewerFixture,
  large: largeReviewerFixture,
  'runtime-nested': () => ({
    form: nestedCountRuntimeForm(),
    mappings: { schemaVersion: 1, mappings: [] },
  }),
  'runtime-section': () => ({
    form: sectionCountRuntimeForm(),
    mappings: { schemaVersion: 1, mappings: [] },
  }),
};
const files = {};
for (const [name, build] of Object.entries(fixtures)) {
  const { form, mappings } = build();
  const original = compileForm(form);
  const exported = exportAuthoringBundle(form, mappings);
  const tables = exportXlsFormTables(form, mappings);
  assert.equal(original.ok, true, `${name}: baseline compile`);
  assert.equal(exported.ok, true, `${name}: bundle export`);
  assert.equal(tables.ok, true, `${name}: table export`);
  const restored = importAuthoringBundle(exported.json);
  const restoredTables = importXlsFormTables(tables.tables);
  for (const [route, result] of [
    ['json', restored],
    ['tables', restoredTables],
  ]) {
    assert.equal(result.ok, true, `${name}: ${route} import`);
    assert.equal(
      result.json,
      exported.json,
      `${name}: ${route} canonical source`,
    );
    const compiled = compileForm(result.bundle.definition);
    assert.equal(compiled.ok, true, `${name}: ${route} compile`);
    assert.equal(compiled.xml, original.xml, `${name}: ${route} exact XML`);
  }
  const changed = structuredClone(tables.tables);
  changed.sheets.settings[1][0] += '_CHANGED';
  assert.equal(
    importXlsFormTables(changed).ok,
    false,
    `${name}: changed projection refused`,
  );
  for (const [suffix, value] of Object.entries({
    'bundle.json': exported.json,
    'tables.json': `${JSON.stringify(tables.tables, null, 2)}\n`,
    xml: original.xml,
  })) {
    const filename = `${name}.${suffix}`;
    writeFileSync(join(output, filename), value, {
      encoding: 'utf8',
      flag: 'wx',
    });
    files[filename] = createHash('sha256').update(value).digest('hex');
  }
  console.log(
    `${name}: canonical JSON and table round trips preserve XML; changed projection rejected`,
  );
}
writeFileSync(
  join(output, 'manifest.json'),
  `${JSON.stringify({ audience: 'authoring-only', validation: 'structural-only', syntheticOnly: true, files }, null, 2)}\n`,
  { encoding: 'utf8', flag: 'wx' },
);
console.log(`Synthetic artifacts only: ${output}`);
console.log(
  'No XLSX, third-party converter, Salesforce round trip, runtime or C10 evidence.',
);
