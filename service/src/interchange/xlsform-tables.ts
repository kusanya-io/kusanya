/** Author-bearing table profile only: no XLSX, delivery, persistence or expression evaluation. */
import { types } from 'node:util';
import { validXmlText } from '../compiler/definition.js';
import { prepareForm } from '../compiler/prepare.js';
import {
  CompileError,
  type Diagnostic,
  type FormDefinition,
  type QuestionNode,
  type QuestionDefinition,
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

function optionalText(value: string): string | undefined {
  return value === '' ? undefined : value;
}

function setQuestionText(
  question: QuestionDefinition,
  key:
    | 'label'
    | 'hint'
    | 'defaultValue'
    | 'calculation'
    | 'constraint'
    | 'constraintMessage'
    | 'relevant'
    | 'appearance'
    | 'repeatSourceQuestion',
  value: string | undefined,
): void {
  if (value === undefined) delete question[key];
  else question[key] = value;
}

function yes(value: string): boolean {
  if (value === '') return false;
  if (value === 'yes') return true;
  throw new CompileError('XLSFORM_EDIT_VALUE');
}

/**
 * Import bounded edits to the visible profile while retaining author-only and
 * mapping data from the embedded source. Structural row identities stay fixed:
 * this is an edit path for a Kusanya export, not an arbitrary XLSForm converter.
 */
export function importEditedXlsFormTables(
  input: unknown,
): ReturnType<typeof importAuthoringBundle> {
  let location = 'tables';
  try {
    const tables = inspectTables(input, (value) => {
      location = value;
    });
    const sourceRows = tables.sheets.kusanya_source;
    location = 'tables.sheets.kusanya_source';
    if (
      sourceRows.length < 2 ||
      sourceRows[0]!.length !== sourceHeader.length ||
      sourceRows[0]!.some((value, index) => value !== sourceHeader[index])
    )
      return failure('XLSFORM_PROJECTION_MISMATCH', location);
    let sourceLength = 0;
    for (let index = 1; index < sourceRows.length; index++) {
      const row = sourceRows[index]!;
      if (row.length !== 2 || row[0] !== String(index))
        return failure('XLSFORM_PROJECTION_MISMATCH', location);
      sourceLength += row[1]!.length;
      if (sourceLength > 4_000_000)
        return failure('XLSFORM_INPUT_LIMIT', location);
    }
    const source = importAuthoringBundle(
      sourceRows
        .slice(1)
        .map((row) => row[1]!)
        .join(''),
    );
    if (!source.ok) return source;
    const baseline = exportXlsFormTables(
      source.bundle.definition,
      source.bundle.mappings,
    );
    if (!baseline.ok) return baseline;

    const actualSurvey = tables.sheets.survey;
    const expectedSurvey = baseline.tables.sheets.survey;
    const actualChoices = tables.sheets.choices;
    const expectedChoices = baseline.tables.sheets.choices;
    const actualSettings = tables.sheets.settings;
    const expectedSettings = baseline.tables.sheets.settings;
    if (
      actualSurvey.length !== expectedSurvey.length ||
      actualChoices.length !== expectedChoices.length ||
      actualSettings.length !== 2 ||
      expectedSettings.length !== 2
    )
      return failure('XLSFORM_EDIT_STRUCTURE', location);

    const prepared = prepareForm(source.bundle.definition);
    if (!prepared.ok) return prepared;
    const editable: QuestionDefinition[] = prepared.graph.nodes.map((node) => ({
      ...node.definition,
    }));
    const changedRelevance = new Set<string>();
    let questionIndex = 0;
    for (let rowIndex = 0; rowIndex < actualSurvey.length; rowIndex++) {
      location = `tables.sheets.survey[${rowIndex}]`;
      const actual = actualSurvey[rowIndex]!;
      const expected = expectedSurvey[rowIndex]!;
      if (actual.length !== surveyHeader.length)
        throw new CompileError('XLSFORM_EDIT_STRUCTURE');
      if (rowIndex === 0) {
        if (actual.some((cell, column) => cell !== expected[column]))
          throw new CompileError('XLSFORM_EDIT_STRUCTURE');
        continue;
      }
      if (expected[0] === 'end group' || expected[0] === 'end repeat') {
        if (actual.some((cell, column) => cell !== expected[column]))
          throw new CompileError('XLSFORM_EDIT_STRUCTURE');
        continue;
      }
      if (
        actual[0] !== expected[0] ||
        actual[1] !== expected[1] ||
        actual[13] !== expected[13]
      )
        throw new CompileError('XLSFORM_EDIT_STRUCTURE');
      const question = editable[questionIndex++];
      if (!question || question.name !== actual[1])
        throw new CompileError('XLSFORM_EDIT_STRUCTURE');
      if (actual[2] !== expected[2])
        setQuestionText(question, 'label', optionalText(actual[2]!));
      if (actual[3] !== expected[3])
        setQuestionText(question, 'hint', optionalText(actual[3]!));
      if (actual[4] !== expected[4]) question.required = yes(actual[4]!);
      if (actual[5] !== expected[5]) question.readOnly = yes(actual[5]!);
      if (actual[6] !== expected[6])
        setQuestionText(question, 'defaultValue', optionalText(actual[6]!));
      if (actual[7] !== expected[7])
        setQuestionText(question, 'calculation', optionalText(actual[7]!));
      if (actual[8] !== expected[8]) {
        setQuestionText(question, 'constraint', optionalText(actual[8]!));
        delete question.regex;
        delete question.regexExample;
        delete question.minimum;
        delete question.maximum;
      }
      if (actual[9] !== expected[9])
        setQuestionText(
          question,
          'constraintMessage',
          optionalText(actual[9]!),
        );
      if (actual[10] !== expected[10]) {
        setQuestionText(question, 'relevant', optionalText(actual[10]!));
        changedRelevance.add(question.name);
      }
      if (actual[11] !== expected[11])
        setQuestionText(question, 'appearance', optionalText(actual[11]!));
      if (actual[12] !== expected[12]) {
        if (question.type !== 'repeat')
          throw new CompileError('XLSFORM_EDIT_VALUE');
        const answer = /^\$\{([A-Za-z_][A-Za-z0-9_.-]*)\}$/.exec(actual[12]!);
        if (actual[12] === '') {
          question.repeatMode = 'open';
          delete question.repeatCount;
          delete question.repeatSourceQuestion;
        } else if (answer) {
          question.repeatMode = 'from_answer';
          delete question.repeatCount;
          setQuestionText(question, 'repeatSourceQuestion', answer[1]);
        } else if (/^[1-9][0-9]*$/.test(actual[12]!)) {
          question.repeatMode = 'fixed';
          question.repeatCount = Number(actual[12]);
          delete question.repeatSourceQuestion;
        } else throw new CompileError('XLSFORM_EDIT_VALUE');
      }
    }
    if (questionIndex !== editable.length)
      throw new CompileError('XLSFORM_EDIT_STRUCTURE');

    const choiceLists = source.bundle.definition.choiceLists.map((list) => ({
      ...list,
      choices: list.choices.map((choice) => ({ ...choice })),
    }));
    const choicesByIdentity = new Map(
      choiceLists.flatMap((list) =>
        list.choices.map(
          (choice) => [`${list.name}\0${choice.value}`, choice] as const,
        ),
      ),
    );
    for (let rowIndex = 0; rowIndex < actualChoices.length; rowIndex++) {
      location = `tables.sheets.choices[${rowIndex}]`;
      const actual = actualChoices[rowIndex]!;
      const expected = expectedChoices[rowIndex]!;
      if (
        actual.length !== choiceHeader.length ||
        actual[0] !== expected[0] ||
        actual[1] !== expected[1]
      )
        throw new CompileError('XLSFORM_EDIT_STRUCTURE');
      if (rowIndex === 0 && actual[2] !== expected[2])
        throw new CompileError('XLSFORM_EDIT_STRUCTURE');
      if (rowIndex > 0) {
        const choice = choicesByIdentity.get(`${actual[0]}\0${actual[1]}`);
        if (!choice) throw new CompileError('XLSFORM_EDIT_STRUCTURE');
        choice.label = actual[2]!;
      }
    }

    location = 'tables.sheets.settings';
    if (
      actualSettings[0]!.some(
        (cell, column) => cell !== expectedSettings[0]![column],
      ) ||
      actualSettings[1]!.length !== settingsHeader.length ||
      actualSettings[1]![1] !== expectedSettings[1]![1] ||
      actualSettings[1]![3] !== expectedSettings[1]![3] ||
      actualSettings[1]![4] !== expectedSettings[1]![4] ||
      !/^[1-9][0-9]*$/.test(actualSettings[1]![2]!)
    )
      throw new CompileError('XLSFORM_EDIT_STRUCTURE');
    const definition: FormDefinition = {
      ...source.bundle.definition,
      form: {
        ...source.bundle.definition.form,
        title: actualSettings[1]![0]!,
        version: Number(actualSettings[1]![2]),
      },
      questions: editable,
      choiceLists,
      skipRules: source.bundle.definition.skipRules.filter(
        (rule) => !changedRelevance.has(rule.question),
      ),
    };
    const edited = exportAuthoringBundle(definition, source.bundle.mappings);
    if (!edited.ok) return edited;
    const regenerated = exportXlsFormTables(
      edited.bundle.definition,
      edited.bundle.mappings,
    );
    if (!regenerated.ok) return regenerated;
    for (const name of ['survey', 'choices', 'settings'] as const) {
      location = `tables.sheets.${name}`;
      const actual = tables.sheets[name];
      const expected = regenerated.tables.sheets[name];
      const original = baseline.tables.sheets[name];
      if (actual.length !== expected.length)
        return failure('XLSFORM_EDIT_PROJECTION', location);
      for (let rowIndex = 0; rowIndex < actual.length; rowIndex++) {
        if (actual[rowIndex]!.length !== expected[rowIndex]!.length) {
          location = `tables.sheets.${name}[${rowIndex}]`;
          return failure('XLSFORM_EDIT_PROJECTION', location);
        }
        for (let column = 0; column < actual[rowIndex]!.length; column++) {
          if (
            actual[rowIndex]![column] !== expected[rowIndex]![column] &&
            actual[rowIndex]![column] !== original[rowIndex]![column]
          ) {
            location = `tables.sheets.${name}[${rowIndex}][${column}]`;
            return failure('XLSFORM_EDIT_PROJECTION', location);
          }
        }
      }
    }
    return edited;
  } catch (error) {
    if (error instanceof CompileError) return failure(error.code, location);
    throw error;
  }
}
