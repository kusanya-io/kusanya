import assert from 'node:assert/strict';
import { test } from 'node:test';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { compileForm } from '../../src/compiler/compile.js';
import { exportAuthoringBundle } from '../../src/interchange/bundle.js';
import {
  exportXlsFormWorkbook,
  importXlsFormWorkbook,
} from '../../src/interchange/xlsx-workbook.js';
import { question, simpleForm } from '../fixtures/compiler.js';
import { reviewerFixture } from '../fixtures/print.js';

const emptyMappings = { schemaVersion: 1, mappings: [] };
const fixedDate = new Date(1980, 0, 1);

function fixture() {
  const { form, mappings } = reviewerFixture();
  const result = exportXlsFormWorkbook(form, mappings);
  assert.ok(result.ok);
  return { form, mappings, ...result };
}
function rejects(input: unknown, code: string) {
  const result = importXlsFormWorkbook(input);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('Expected workbook rejection');
  assert.equal(result.diagnostics[0]!.code, code);
  assert.ok(!JSON.stringify(result).includes('HOSTILE_SENTINEL'));
}
function rewrite(
  workbook: Uint8Array,
  mutate: (entries: Record<string, Uint8Array>) => void,
): Uint8Array {
  const entries = unzipSync(workbook);
  mutate(entries);
  return zipSync(entries, { level: 6, mtime: fixedDate });
}

void test('round-trips deterministic XLSX bytes to the same bundle and compiled XML', () => {
  const { form, mappings, workbook, warnings } = fixture();
  const second = exportXlsFormWorkbook(form, mappings);
  assert.ok(second.ok);
  assert.deepEqual(second.workbook, workbook);
  const imported = importXlsFormWorkbook(workbook);
  assert.ok(imported.ok);
  assert.deepEqual(imported.warnings, warnings);
  assert.deepEqual(compileForm(imported.bundle.definition), compileForm(form));
  const canonical = exportAuthoringBundle(form, mappings);
  assert.ok(canonical.ok);
  assert.deepEqual(imported.bundle.mappings, canonical.bundle.mappings);
});

void test('writes every cell as exact inline text so formula prefixes never execute', () => {
  const values = [
    '=1+1',
    '+cmd|calc',
    '-2+3',
    '@SUM(A1)',
    '  leading and trailing  ',
    '00123',
  ];
  const form = simpleForm(
    values.map((value, index) =>
      question(`answer_${index}`, {
        label: value,
        defaultValue: value,
        authorNotes: value,
        order: index + 1,
      }),
    ),
  );
  const exported = exportXlsFormWorkbook(form, emptyMappings);
  assert.ok(exported.ok);
  const entries = unzipSync(exported.workbook);
  for (const [path, bytes] of Object.entries(entries)) {
    if (!path.startsWith('xl/worksheets/')) continue;
    const xml = strFromU8(bytes);
    assert.ok(!xml.includes('<f>'));
    assert.ok(!xml.includes('t="str"'));
    assert.ok(!xml.includes('t="n"'));
  }
  const survey = strFromU8(entries['xl/worksheets/sheet1.xml']!);
  for (const value of values)
    assert.ok(survey.includes(value.replaceAll('&', '&amp;')));
  const imported = importXlsFormWorkbook(exported.workbook);
  assert.ok(imported.ok);
  for (const [index, value] of values.entries()) {
    const restored: {
      label?: string;
      defaultValue?: string;
      authorNotes?: string;
    } = imported.bundle.definition.questions[index]!;
    assert.equal(restored.label, value);
    assert.equal(restored.defaultValue, value);
    assert.equal(restored.authorNotes, value);
  }
});

void test('rejects formulas, typed cells, comments and changed visible projections', () => {
  const { workbook } = fixture();
  const formula = rewrite(workbook, (entries) => {
    const path = 'xl/worksheets/sheet1.xml';
    const xml = strFromU8(entries[path]!).replace(
      /<is><t xml:space="preserve">type<\/t><\/is>/,
      '<f>1+1</f><v>2</v>',
    );
    entries[path] = strToU8(xml);
  });
  rejects(formula, 'XLSX_WORKSHEET_SHAPE');
  const typed = rewrite(workbook, (entries) => {
    const path = 'xl/worksheets/sheet1.xml';
    entries[path] = strToU8(
      strFromU8(entries[path]!).replace('t="inlineStr"', 't="n"'),
    );
  });
  rejects(typed, 'XLSX_WORKSHEET_SHAPE');
  const comment = rewrite(workbook, (entries) => {
    const path = 'xl/worksheets/sheet1.xml';
    entries[path] = strToU8(
      strFromU8(entries[path]!).replace('<sheetData>', '<!--x--><sheetData>'),
    );
  });
  rejects(comment, 'XLSX_WORKSHEET_SHAPE');
  const changed = rewrite(workbook, (entries) => {
    const path = 'xl/worksheets/sheet3.xml';
    entries[path] = strToU8(
      strFromU8(entries[path]!).replace('form_title', 'HOSTILE_SENTINEL'),
    );
  });
  rejects(changed, 'XLSFORM_PROJECTION_MISMATCH');
});

void test('rejects macros, external links, missing parts and altered package metadata', () => {
  const { workbook } = fixture();
  const macro = rewrite(workbook, (entries) => {
    entries['xl/vbaProject.bin'] = new Uint8Array([1]);
  });
  rejects(macro, 'XLSX_ARCHIVE_SHAPE');
  const external = rewrite(workbook, (entries) => {
    entries['xl/externalLinks/externalLink1.xml'] = strToU8('<x/>');
  });
  rejects(external, 'XLSX_ARCHIVE_SHAPE');
  const missing = rewrite(workbook, (entries) => {
    delete entries['xl/styles.xml'];
  });
  rejects(missing, 'XLSX_ARCHIVE_SHAPE');
  const changed = rewrite(workbook, (entries) => {
    entries['xl/styles.xml'] = strToU8(
      strFromU8(entries['xl/styles.xml']!).replace('Arial', 'Aptos'),
    );
  });
  rejects(changed, 'XLSX_PACKAGE_SHAPE');
});

void test('rejects malformed archives, invalid input types and oversized expanded parts', () => {
  rejects('not bytes', 'XLSX_INPUT_TYPE');
  rejects(new Uint8Array(), 'XLSX_INPUT_LIMIT');
  rejects(strToU8('not a zip'), 'XLSX_ARCHIVE');
  const { workbook } = fixture();
  const oversized = rewrite(workbook, (entries) => {
    entries['xl/worksheets/sheet1.xml'] = new Uint8Array(10_000_001);
  });
  rejects(oversized, 'XLSX_INPUT_LIMIT');
});

void test('does not mutate source definitions or caller-owned workbook bytes', () => {
  const { form, mappings } = reviewerFixture();
  const before = JSON.stringify({ form, mappings });
  const exported = exportXlsFormWorkbook(form, mappings);
  assert.ok(exported.ok);
  assert.equal(JSON.stringify({ form, mappings }), before);
  const copy = new Uint8Array(exported.workbook);
  const imported = importXlsFormWorkbook(copy);
  assert.ok(imported.ok);
  assert.deepEqual(copy, exported.workbook);
  imported.bundle.definition.form.title = 'changed';
  assert.deepEqual(copy, exported.workbook);
});
