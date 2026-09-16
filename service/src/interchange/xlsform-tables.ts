/** Author-bearing table profile only: no XLSX, delivery, persistence or expression evaluation. */
import { types } from 'node:util';
import { validXmlText } from '../compiler/definition.js';
import { prepareForm } from '../compiler/prepare.js';
import {
  CompileError,
  type Diagnostic,
  type QuestionNode,
  type QuestionType,
} from '../compiler/types.js';
import { exportAuthoringBundle, importAuthoringBundle } from './bundle.js';

export interface XlsFormTables {
  schemaVersion: 1;
  kind: 'kusanya-xlsform-profile';
  sheets: {
    survey: string[][];
    choices: string[][];
    settings: string[][];
    kusanya_source: string[][];
  };
}
type Failure = {
  readonly ok: false;
  readonly diagnostics: readonly Diagnostic[];
};
export type XlsFormTablesResult =
  | Failure
  | {
      readonly ok: true;
      readonly tables: XlsFormTables;
      readonly audience: 'authoring-only';
      readonly validation: 'structural-only';
      readonly warnings: readonly Diagnostic[];
    };
const sheetNames = ['survey', 'choices', 'settings', 'kusanya_source'] as const;
const surveyHeader = [
  'type',
  'name',
  'label',
  'hint',
  'required',
  'read_only',
  'default',
  'calculation',
  'constraint',
  'constraint_message',
  'relevant',
  'appearance',
  'repeat_count',
  'bind::type',
];
const choiceHeader = ['list_name', 'name', 'label'];
const settingsHeader = [
  'form_title',
  'form_id',
  'version',
  'name',
  'clean_text_values',
];
const sourceHeader = ['index', 'json'];
const binaryCompare = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;
const bindTypes: Partial<Record<QuestionType, string>> = {
  note: 'string',
  text: 'string',
  text_long: 'string',
  integer: 'int',
  decimal: 'decimal',
  select_one: 'select1',
  select_multiple: 'select',
  date: 'date',
  time: 'time',
  datetime: 'dateTime',
  geopoint: 'geopoint',
  geotrace: 'geotrace',
  geoshape: 'geoshape',
  photo: 'binary',
  signature: 'binary',
  audio: 'binary',
  video: 'binary',
  file: 'binary',
  barcode: 'barcode',
  calculate: 'string',
  reference: 'string',
};
function failure(code: string, location: string): Failure {
  return { ok: false, diagnostics: [{ code, location }] };
}

/** Validate all bounds before copying, joining source chunks or decoding JSON. */
function inspectTables(
  input: unknown,
  at: (value: string) => void,
): XlsFormTables {
  function record(
    value: unknown,
    keys: readonly string[],
  ): Record<string, unknown> {
    if (
      !value ||
      typeof value !== 'object' ||
      types.isProxy(value) ||
      Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null)
    )
      throw new CompileError('XLSFORM_INPUT_SHAPE');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const names = Reflect.ownKeys(descriptors);
    if (
      names.length !== keys.length ||
      names.some((name) => typeof name !== 'string' || !keys.includes(name))
    )
      throw new CompileError('XLSFORM_INPUT_SHAPE');
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (
        !descriptor ||
        !Object.hasOwn(descriptor, 'value') ||
        !descriptor.enumerable
      )
        throw new CompileError('XLSFORM_INPUT_SHAPE');
      result[key] = descriptor.value as unknown;
    }
    return result;
  }
  function array(value: unknown, limit: number): unknown[] {
    if (
      !value ||
      typeof value !== 'object' ||
      types.isProxy(value) ||
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype
    )
      throw new CompileError('XLSFORM_INPUT_SHAPE');
    if (value.length > limit) throw new CompileError('XLSFORM_INPUT_LIMIT');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== value.length + 1)
      throw new CompileError('XLSFORM_INPUT_SHAPE');
    for (let index = 0; index < value.length; index++) {
      const descriptor = descriptors[String(index)];
      if (
        !descriptor ||
        !Object.hasOwn(descriptor, 'value') ||
        !descriptor.enumerable
      )
        throw new CompileError('XLSFORM_INPUT_SHAPE');
    }
    return value as unknown[];
  }
  at('tables');
  const root = record(input, ['schemaVersion', 'kind', 'sheets']);
  if (root.schemaVersion !== 1 || root.kind !== 'kusanya-xlsform-profile')
    throw new CompileError('XLSFORM_SCHEMA_VERSION');
  at('tables.sheets');
  const sheets = record(root.sheets, sheetNames);
  let cells = 0;
  let textUnits = 0;
  for (const name of sheetNames) {
    at(`tables.sheets.${name}`);
    const rows = array(sheets[name], 6000);
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      at(`tables.sheets.${name}[${rowIndex}]`);
      const row = array(rows[rowIndex], 100_000 - cells);
      cells += row.length;
      for (let column = 0; column < row.length; column++) {
        at(`tables.sheets.${name}[${rowIndex}][${column}]`);
        const cell = row[column];
        if (typeof cell !== 'string')
          throw new CompileError('XLSFORM_INPUT_TEXT');
        if (cell.length > 32767) throw new CompileError('XLSFORM_CELL_LIMIT');
        textUnits += cell.length;
        if (textUnits > 8_000_000)
          throw new CompileError('XLSFORM_INPUT_LIMIT');
        if (!validXmlText(cell)) throw new CompileError('XLSFORM_INPUT_TEXT');
      }
    }
  }
  return input as XlsFormTables;
}
function chunkSource(json: string): string[][] {
  const rows = [[...sourceHeader]];
  for (let offset = 0; offset < json.length;) {
    let end = Math.min(offset + 30_000, json.length);
    const last = json.charCodeAt(end - 1);
    if (end < json.length && last >= 0xd800 && last <= 0xdbff) end--;
    rows.push([String(rows.length), json.slice(offset, end)]);
    offset = end;
  }
  return rows;
}

/** The source sheet is authoritative; visible cells are a consistency-checked projection. */
export function exportXlsFormTables(
  formInput: unknown,
  mappingInput: unknown,
): XlsFormTablesResult {
  const source = exportAuthoringBundle(formInput, mappingInput);
  if (!source.ok) return source;
  const prepared = prepareForm(source.bundle.definition);
  if (!prepared.ok) return prepared;
  const { graph, logic: preparedLogic } = prepared;
  const survey: string[][] = [[...surveyHeader]];
  function visit(node: QuestionNode): void {
    const question = node.definition;
    const logic = preparedLogic.get(question.name)!;
    let type: string = question.type;
    if (question.type === 'section') type = 'begin group';
    else if (question.type === 'repeat') type = 'begin repeat';
    else if (question.hidden) type = 'hidden';
    else if (
      question.type === 'select_one' ||
      question.type === 'select_multiple'
    )
      type = `${question.type} ${question.choiceList!}`;
    else if (question.type === 'text_long' || question.type === 'reference')
      type = 'text';
    else if (question.type === 'photo' || question.type === 'signature')
      type = 'image';
    else if (question.type === 'datetime') type = 'dateTime';
    const appearance =
      question.type === 'signature'
        ? 'signature'
        : (question.appearance ??
          (question.type === 'text_long' ? 'multiline' : ''));
    const repeatCount =
      question.repeatMode === 'fixed'
        ? String(question.repeatCount)
        : question.repeatMode === 'from_answer'
          ? `\${${question.repeatSourceQuestion!}}`
          : '';
    survey.push([
      type,
      question.name,
      question.label ?? '',
      question.hint ?? '',
      question.required ? 'yes' : '',
      question.readOnly ||
      ['note', 'calculate', 'reference'].includes(question.type)
        ? 'yes'
        : '',
      question.defaultValue ?? '',
      logic.calculation ?? '',
      logic.constraint ?? '',
      question.constraintMessage ?? '',
      logic.relevant ?? '',
      appearance,
      repeatCount,
      question.hidden ? bindTypes[question.type]! : '',
    ]);
    for (const child of node.children) visit(child);
    if (question.type === 'section' || question.type === 'repeat') {
      const closing = Array<string>(surveyHeader.length).fill('');
      closing[0] = question.type === 'section' ? 'end group' : 'end repeat';
      survey.push(closing);
    }
  }
  for (const node of graph.roots) visit(node);
  const choices: string[][] = [[...choiceHeader]];
  for (const list of [...graph.definition.choiceLists].sort((a, b) =>
    binaryCompare(a.name, b.name),
  ))
    for (const choice of [...list.choices].sort(
      (a, b) => a.order - b.order || binaryCompare(a.value, b.value),
    ))
      choices.push([list.name, choice.value, choice.label]);
  const form = source.bundle.definition.form;
  const tables: XlsFormTables = {
    schemaVersion: 1,
    kind: 'kusanya-xlsform-profile',
    sheets: {
      survey,
      choices,
      settings: [
        [...settingsHeader],
        [form.title, form.key, String(form.version), 'data', 'no'],
      ],
      kusanya_source: chunkSource(source.json),
    },
  };
  let location = 'tables';
  try {
    inspectTables(tables, (value) => {
      location = value;
    });
    return {
      ok: true,
      tables,
      audience: 'authoring-only',
      validation: 'structural-only',
      warnings: source.warnings,
    };
  } catch (error) {
    if (error instanceof CompileError) return failure(error.code, location);
    throw error;
  }
}

/** Import only this complete profile; ordinary or independently edited XLSForms fail closed. */
export function importXlsFormTables(
  input: unknown,
): ReturnType<typeof importAuthoringBundle> {
  let location = 'tables';
  try {
    const tables = inspectTables(input, (value) => {
      location = value;
    });
    location = 'tables.sheets.kusanya_source';
    const rows = tables.sheets.kusanya_source;
    if (
      rows.length < 2 ||
      rows[0]!.length !== sourceHeader.length ||
      rows[0]!.some((value, index) => value !== sourceHeader[index])
    )
      return failure('XLSFORM_PROJECTION_MISMATCH', location);
    let textUnits = 0;
    for (let index = 1; index < rows.length; index++) {
      const row = rows[index]!;
      if (row.length !== 2 || row[0] !== String(index))
        return failure('XLSFORM_PROJECTION_MISMATCH', location);
      textUnits += row[1]!.length;
      if (textUnits > 4_000_000)
        return failure('XLSFORM_INPUT_LIMIT', location);
    }
    const source = importAuthoringBundle(
      rows
        .slice(1)
        .map((row) => row[1]!)
        .join(''),
    );
    if (!source.ok) return source;
    const regenerated = exportXlsFormTables(
      source.bundle.definition,
      source.bundle.mappings,
    );
    if (!regenerated.ok) return regenerated;
    for (const name of sheetNames) {
      location = `tables.sheets.${name}`;
      const actual = tables.sheets[name];
      const expected = regenerated.tables.sheets[name];
      if (
        actual.length !== expected.length ||
        actual.some(
          (row, rowIndex) =>
            row.length !== expected[rowIndex]!.length ||
            row.some((cell, column) => cell !== expected[rowIndex]![column]),
        )
      )
        return failure('XLSFORM_PROJECTION_MISMATCH', location);
    }
    return source;
  } catch (error) {
    if (error instanceof CompileError) return failure(error.code, location);
    throw error;
  }
}
