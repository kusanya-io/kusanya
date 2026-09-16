import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const [{ reviewerFixture }, { compileForm }, workbookModule] =
  await Promise.all([
    import('../service/dist/test/fixtures/print.js'),
    import('../service/dist/src/compiler/compile.js'),
    import('../service/dist/src/interchange/xlsx-workbook.js'),
  ]);
const { exportXlsFormWorkbook, importXlsFormWorkbook } = workbookModule;
const { form, mappings } = reviewerFixture();
const formulaPrefixValues = ['=1+1', '+cmd|calc', '-2+3', '@SUM(A1)'];
assert.ok(form.questions.length >= formulaPrefixValues.length);
for (const [index, value] of formulaPrefixValues.entries())
  form.questions[index].label = value;
form.questions[0].authorNotes = '@SUM(A1)';
const exported = exportXlsFormWorkbook(form, mappings);
assert.ok(exported.ok);
const restored = importXlsFormWorkbook(exported.workbook);
assert.ok(restored.ok);
assert.deepEqual(compileForm(restored.bundle.definition), compileForm(form));

const work = resolve(root, 'work');
await mkdir(work, { recursive: true });
const directory = await mkdtemp(join(work, 'xlsx-'));
const workbookPath = join(directory, 'reviewer-profile.xlsx');
await writeFile(workbookPath, exported.workbook);
const manifest = {
  schemaVersion: 1,
  fixture: 'synthetic reviewer profile',
  workbook: 'reviewer-profile.xlsx',
  bytes: exported.workbook.length,
  sha256: createHash('sha256').update(exported.workbook).digest('hex'),
  sheets: ['survey', 'choices', 'settings', 'kusanya_source'],
  formulaPrefixValues,
  roundTrip: 'passed',
};
await writeFile(
  join(directory, 'manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
);
console.log(JSON.stringify({ directory, ...manifest }));
