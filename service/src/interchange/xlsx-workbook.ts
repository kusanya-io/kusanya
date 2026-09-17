/** Strict XLSX boundary for the consistency-checked authoring table profile. */
import { SaxesParser, type SaxesTagPlain } from 'saxes';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { CompileError, type Diagnostic } from '../compiler/types.js';
import {
  exportXlsFormTables,
  importXlsFormTables,
  type XlsFormTables,
} from './xlsform-tables.js';

type Failure = {
  readonly ok: false;
  readonly diagnostics: readonly Diagnostic[];
};
export type XlsFormWorkbookResult =
  | Failure
  | {
      readonly ok: true;
      readonly workbook: Uint8Array;
      readonly audience: 'authoring-only';
      readonly validation: 'structural-only';
      readonly warnings: readonly Diagnostic[];
    };

const sheetNames = ['survey', 'choices', 'settings', 'kusanya_source'] as const;
const spreadsheetNamespace =
  'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const relationshipNamespace =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const fixedDate = new Date(1980, 0, 1);
const maxArchiveBytes = 12_000_000;
const maxExpandedBytes = 20_000_000;
const maxEntryBytes = 10_000_000;

const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheetNames.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`;
const rootRelationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${spreadsheetNamespace}" xmlns:r="${relationshipNamespace}"><sheets>${sheetNames.map((name, index) => `<sheet name="${name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>`;
const workbookRelationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetNames.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${spreadsheetNamespace}"><fonts count="1"><font><sz val="11"/><name val="Arial"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

const fixedEntries: Readonly<Record<string, string>> = {
  '[Content_Types].xml': contentTypes,
  '_rels/.rels': rootRelationships,
  'xl/workbook.xml': workbookXml,
  'xl/_rels/workbook.xml.rels': workbookRelationships,
  'xl/styles.xml': stylesXml,
};
const worksheetEntries = Object.fromEntries(
  sheetNames.map((_, index) => [`xl/worksheets/sheet${index + 1}.xml`, index]),
) as Record<string, number>;
const allowedEntries = new Set([
  ...Object.keys(fixedEntries),
  ...Object.keys(worksheetEntries),
]);

function failure(code: string, location = 'workbook'): Failure {
  return { ok: false, diagnostics: [{ code, location }] };
}
function escapeText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\r', '&#13;');
}
function columnName(index: number): string {
  let value = index + 1;
  let result = '';
  while (value) {
    value--;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}
function columnIndex(value: string): number {
  let result = 0;
  for (const character of value)
    result = result * 26 + character.charCodeAt(0) - 64;
  return result - 1;
}
function worksheetXml(rows: readonly (readonly string[])[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${spreadsheetNamespace}"><sheetData>${rows
    .map(
      (row, rowIndex) =>
        `<row r="${rowIndex + 1}">${row
          .map(
            (cell, column) =>
              `<c r="${columnName(column)}${rowIndex + 1}" t="inlineStr" s="1"><is><t xml:space="preserve">${escapeText(cell)}</t></is></c>`,
          )
          .join('')}</row>`,
    )
    .join('')}</sheetData></worksheet>`;
}

function archive(tables: XlsFormTables): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, value] of Object.entries(fixedEntries))
    entries[name] = strToU8(value);
  for (const [index, name] of sheetNames.entries())
    entries[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(
      worksheetXml(tables.sheets[name]),
    );
  return zipSync(entries, { level: 6, mtime: fixedDate });
}

/** Produce deterministic workbook bytes with literal inline-string cells only. */
export function exportXlsFormWorkbook(
  formInput: unknown,
  mappingInput: unknown,
): XlsFormWorkbookResult {
  const result = exportXlsFormTables(formInput, mappingInput);
  if (!result.ok) return result;
  try {
    const workbook = archive(result.tables);
    if (workbook.length > maxArchiveBytes) return failure('XLSX_OUTPUT_LIMIT');
    return {
      ok: true,
      workbook,
      audience: 'authoring-only',
      validation: 'structural-only',
      warnings: result.warnings,
    };
  } catch (error) {
    if (error instanceof CompileError) return failure(error.code);
    throw error;
  }
}

function inputBytes(input: unknown): Uint8Array {
  if (input instanceof Uint8Array) return new Uint8Array(input);
  if (input instanceof ArrayBuffer) return new Uint8Array(input.slice(0));
  throw new CompileError('XLSX_INPUT_TYPE');
}
function attributes(tag: SaxesTagPlain): Record<string, string> {
  return tag.attributes;
}
function exactAttributes(
  actual: Record<string, string>,
  expected: Readonly<Record<string, string>>,
): boolean {
  const keys = Object.keys(actual);
  const expectedKeys = Object.keys(expected);
  return (
    keys.length === expectedKeys.length &&
    expectedKeys.every((key) => actual[key] === expected[key])
  );
}

/** Parse only the worksheet subset emitted above; no formulas or alternate cell types. */
function parseWorksheet(xml: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] | undefined;
  let currentCell = '';
  let currentReference = '';
  let text = '';
  const stack: string[] = [];
  let sawSheetData = false;
  let totalCells = 0;
  let totalText = 0;
  const invalid = (): never => {
    throw new CompileError('XLSX_WORKSHEET_SHAPE');
  };
  const parser = new SaxesParser({ xmlns: false, position: false });
  parser.on('doctype', invalid);
  parser.on('comment', invalid);
  parser.on('processinginstruction', invalid);
  parser.on('opentag', (tag) => {
    const parent = stack.at(-1);
    const attrs = attributes(tag);
    if (
      (tag.name === 'worksheet' &&
        (!exactAttributes(attrs, { xmlns: spreadsheetNamespace }) || parent)) ||
      (tag.name === 'sheetData' &&
        (!exactAttributes(attrs, {}) || parent !== 'worksheet' || sawSheetData))
    ) {
      invalid();
    }
    if (tag.name === 'sheetData') sawSheetData = true;
    else if (tag.name === 'row') {
      if (parent !== 'sheetData' || currentRow) invalid();
      const expected = String(rows.length + 1);
      if (!exactAttributes(attrs, { r: expected }) || rows.length >= 6000)
        invalid();
      currentRow = [];
    } else if (tag.name === 'c') {
      if (parent !== 'row' || !currentRow || currentReference) invalid();
      const row = currentRow!;
      const expected = `${columnName(row.length)}${rows.length + 1}`;
      if (!exactAttributes(attrs, { r: expected, t: 'inlineStr', s: '1' }))
        invalid();
      currentReference = expected;
      currentCell = '';
      totalCells++;
      if (totalCells > 100_000) invalid();
    } else if (tag.name === 'is') {
      if (parent !== 'c' || !currentReference || !exactAttributes(attrs, {}))
        invalid();
    } else if (tag.name === 't') {
      if (
        parent !== 'is' ||
        !currentReference ||
        !exactAttributes(attrs, { 'xml:space': 'preserve' })
      )
        invalid();
      text = '';
    } else if (!['worksheet', 'sheetData'].includes(tag.name)) invalid();
    stack.push(tag.name);
  });
  parser.on('text', (value) => {
    if (stack.at(-1) === 't') {
      text += value;
      if (text.length > 32767) invalid();
    } else if (value.trim()) invalid();
  });
  parser.on('cdata', invalid);
  parser.on('closetag', (tag) => {
    if (stack.pop() !== tag.name) invalid();
    if (tag.name === 't') {
      currentCell = text;
      totalText += text.length;
      if (totalText > 8_000_000) invalid();
    } else if (tag.name === 'c') {
      if (!currentRow || !currentReference) invalid();
      const row = currentRow!;
      const match = /^([A-Z]+)([1-9][0-9]*)$/.exec(currentReference);
      if (
        !match ||
        columnIndex(match[1]!) !== row.length ||
        Number(match[2]) !== rows.length + 1
      )
        invalid();
      row.push(currentCell);
      currentReference = '';
    } else if (tag.name === 'row') {
      if (!currentRow || currentReference || currentRow.length === 0) invalid();
      const row = currentRow!;
      rows.push(row);
      currentRow = undefined;
    }
  });
  try {
    parser.write(xml).close();
  } catch (error) {
    if (error instanceof CompileError) throw error;
    throw new CompileError('XLSX_XML');
  }
  if (
    stack.length ||
    !sawSheetData ||
    currentRow ||
    currentReference ||
    rows.length === 0
  )
    invalid();
  return rows;
}

/** Import only Kusanya's strict, formula-free workbook subset. */
export function importXlsFormWorkbook(
  input: unknown,
): ReturnType<typeof importXlsFormTables> {
  let location = 'workbook';
  try {
    const bytes = inputBytes(input);
    if (bytes.length === 0 || bytes.length > maxArchiveBytes)
      return failure('XLSX_INPUT_LIMIT', location);
    const seen = new Set<string>();
    let expanded = 0;
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(bytes, {
        filter(file) {
          if (
            !allowedEntries.has(file.name) ||
            seen.has(file.name) ||
            ![0, 8].includes(file.compression)
          )
            throw new CompileError('XLSX_ARCHIVE_SHAPE');
          seen.add(file.name);
          expanded += file.originalSize;
          if (file.originalSize > maxEntryBytes || expanded > maxExpandedBytes)
            throw new CompileError('XLSX_INPUT_LIMIT');
          return true;
        },
      });
    } catch (error) {
      if (error instanceof CompileError) throw error;
      throw new CompileError('XLSX_ARCHIVE');
    }
    if (
      seen.size !== allowedEntries.size ||
      [...allowedEntries].some((name) => !Object.hasOwn(files, name))
    )
      throw new CompileError('XLSX_ARCHIVE_SHAPE');
    for (const [name, expected] of Object.entries(fixedEntries)) {
      location = `workbook.${name}`;
      let actual: string;
      try {
        actual = strFromU8(files[name]!);
      } catch {
        throw new CompileError('XLSX_XML');
      }
      if (actual !== expected) throw new CompileError('XLSX_PACKAGE_SHAPE');
    }
    const tables: XlsFormTables = {
      schemaVersion: 1,
      kind: 'kusanya-xlsform-profile',
      sheets: { survey: [], choices: [], settings: [], kusanya_source: [] },
    };
    for (const [index, name] of sheetNames.entries()) {
      location = `workbook.${name}`;
      const path = `xl/worksheets/sheet${index + 1}.xml`;
      let xml: string;
      try {
        xml = strFromU8(files[path]!);
      } catch {
        throw new CompileError('XLSX_XML');
      }
      tables.sheets[name] = parseWorksheet(xml);
    }
    return importXlsFormTables(tables);
  } catch (error) {
    if (error instanceof CompileError) return failure(error.code, location);
    throw error;
  }
}
