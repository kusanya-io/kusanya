import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileForm } from '../../src/compiler/compile.js';
import { validXmlText } from '../../src/compiler/definition.js';
import { exportAuthoringBundle } from '../../src/interchange/bundle.js';
import { createSalesforceNames } from '../../src/salesforce-names.js';
import {
  exportXlsFormTables,
  importXlsFormTables,
  type XlsFormTables,
} from '../../src/interchange/xlsform-tables.js';
import {
  mixedRepeatForm,
  nestedRepeatForm,
  question,
  quotedForm,
  scalarForm,
  simpleForm,
} from '../fixtures/compiler.js';
import { largeReviewerFixture, reviewerFixture } from '../fixtures/print.js';

const emptyMappings = { schemaVersion: 1, mappings: [] };
function fixture() {
  const { form, mappings } = reviewerFixture();
  const result = exportXlsFormTables(form, mappings);
  assert.ok(result.ok);
  return { form, mappings, ...result };
}
function rejects(input: unknown, code = 'XLSFORM_PROJECTION_MISMATCH') {
  const result = importXlsFormTables(input);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('Expected profile rejection');
  assert.equal(result.diagnostics[0]!.code, code);
  assert.ok(!JSON.stringify(result).includes('HOSTILE_SENTINEL'));
}
function row(tables: XlsFormTables, name: string): Record<string, string> {
  const entries = tables.sheets.survey;
  const values = entries.find((value) => value[1] === name);
  assert.ok(values);
  return Object.fromEntries(
    entries[0]!.map((header, index) => [header, values[index]!]),
  );
}

void test('round-trips supported compiler and reviewer fixtures through source and tables with identical XML', () => {
  const reviewer = reviewerFixture();
  const large = largeReviewerFixture();
  const fixtures = [
    ...[
      simpleForm(),
      mixedRepeatForm(),
      nestedRepeatForm(),
      scalarForm(),
      quotedForm(),
    ].map((form) => ({ form, mappings: emptyMappings })),
    reviewer,
    large,
  ];
  for (const { form, mappings } of fixtures) {
    const expected = exportAuthoringBundle(form, mappings);
    assert.ok(expected.ok);
    const exported = exportXlsFormTables(form, mappings);
    assert.ok(exported.ok);
    assert.equal(exported.audience, 'authoring-only');
    assert.equal(exported.validation, 'structural-only');
    const imported = importXlsFormTables(exported.tables);
    assert.ok(imported.ok);
    assert.equal(imported.json, expected.json);
    assert.deepEqual(imported.bundle, expected.bundle);
    assert.deepEqual(
      compileForm(imported.bundle.definition),
      compileForm(expected.bundle.definition),
    );
    assert.deepEqual(exported.warnings, imported.warnings);
  }
});

void test('projects standard survey/choices/settings columns and exactly balanced nested containers', () => {
  const { tables } = fixture();
  assert.deepEqual(tables.sheets.settings[0], [
    'form_title',
    'form_id',
    'version',
    'name',
    'clean_text_values',
  ]);
  assert.deepEqual(tables.sheets.settings[1]!.slice(-2), ['data', 'no']);
  assert.equal(row(tables, 'students').repeat_count, '${student_count}');
  assert.equal(row(tables, 'samples').repeat_count, '5');
  assert.equal(row(tables, 'handwashing').type, 'select_one yes_no');
  assert.equal(row(tables, 'site').type, 'text');
  assert.equal(row(tables, 'site').read_only, 'yes');
  assert.equal(row(tables, 'student_count').required, 'yes');
  assert.ok(row(tables, 'student_count').constraint!.includes('. <= 40'));
  assert.ok(row(tables, 'reason').relevant!.includes('../handwashing'));
  assert.ok(row(tables, 'visit_time').constraint!.includes('regex('));
  assert.deepEqual(tables.sheets.choices[0], ['list_name', 'name', 'label']);
  const stack: string[] = [];
  for (const values of tables.sheets.survey.slice(1)) {
    if (values[0]!.startsWith('begin ')) stack.push(values[0]!.slice(6));
    else if (values[0]!.startsWith('end '))
      assert.equal(stack.pop(), values[0]!.slice(4));
  }
  assert.equal(stack.length, 0);
  assert.ok(!JSON.stringify(tables.sheets.survey).includes('_ksny_count_'));
});

void test('preserves hidden datatypes and calculated/reference/note read-only semantics in projection', () => {
  const form = simpleForm([
    question('hidden_integer', {
      type: 'integer',
      hidden: true,
      defaultValue: '2',
      order: 1,
    }),
    question('hidden_select', {
      type: 'select_one',
      hidden: true,
      choiceList: 'list',
      defaultValue: 'a',
      order: 2,
    }),
    question('computed', {
      type: 'calculate',
      calculation: '${hidden_integer} + 1',
      order: 3,
    }),
    question('memo', { type: 'note', order: 4 }),
    question('long_text', { type: 'text_long', order: 5 }),
    question('signature', { type: 'signature', order: 6 }),
    question('datetime', { type: 'datetime', order: 7 }),
  ]);
  form.choiceLists = [
    { name: 'list', choices: [{ value: 'a', label: 'A', order: 1 }] },
  ];
  const exported = exportXlsFormTables(form, emptyMappings);
  assert.ok(exported.ok);
  const { tables } = exported;
  assert.equal(row(tables, 'hidden_integer').type, 'hidden');
  assert.equal(row(tables, 'hidden_integer')['bind::type'], 'int');
  assert.equal(row(tables, 'hidden_select')['bind::type'], 'select1');
  assert.equal(row(tables, 'computed').type, 'calculate');
  assert.equal(row(tables, 'computed').read_only, 'yes');
  assert.equal(row(tables, 'memo').read_only, 'yes');
  assert.equal(row(tables, 'long_text').appearance, 'multiline');
  assert.equal(row(tables, 'signature').type, 'image');
  assert.equal(row(tables, 'signature').appearance, 'signature');
  assert.equal(row(tables, 'datetime').type, 'dateTime');
  assert.ok(importXlsFormTables(tables).ok);
});

void test('author annotations and complete mapping configurations occur only in the source sheet', () => {
  const { tables, form, mappings } = fixture();
  const visible = JSON.stringify({
    ...tables.sheets,
    kusanya_source: undefined,
  });
  for (const sentinel of [
    'REVIEWER_ONLY_7285',
    'REGEX_EXAMPLE_7285',
    'Observation__c',
    'Collector__c',
  ])
    assert.ok(!visible.includes(sentinel));
  const source = tables.sheets.kusanya_source
    .slice(1)
    .map((entry) => entry[1])
    .join('');
  assert.ok(source.includes('REVIEWER_ONLY_7285'));
  assert.ok(source.includes('REGEX_EXAMPLE_7285'));
  const imported = importXlsFormTables(tables);
  assert.ok(imported.ok);
  const expected = exportAuthoringBundle(form, mappings);
  assert.ok(expected.ok);
  assert.deepEqual(imported.bundle.mappings, expected.bundle.mappings);
  const compiled = compileForm(imported.bundle.definition);
  assert.ok(compiled.ok);
  assert.ok(!compiled.xml.includes('REVIEWER_ONLY_7285'));
  assert.ok(!compiled.xml.includes('REGEX_EXAMPLE_7285'));
});

void test('keeps empty and configured namespace mapping names unchanged without prefix inference', () => {
  for (const prefix of ['', 'ksny__'] as const) {
    const names = createSalesforceNames(prefix);
    const { form, mappings } = reviewerFixture();
    mappings.mappings[1]!.targetObject = names.kusanyaObject('Question__c');
    mappings.mappings[1]!.fields[0]!.targetField =
      names.kusanyaField('Label__c');
    const exported = exportXlsFormTables(form, mappings);
    assert.ok(exported.ok);
    const imported = importXlsFormTables(exported.tables);
    assert.ok(imported.ok);
    const mapping = imported.bundle.mappings.mappings.find(
      (value) => value.key === mappings.mappings[1]!.key,
    )!;
    assert.equal(mapping.targetObject, `${prefix}Question__c`);
    assert.ok(
      mapping.fields.some((value) => value.targetField === `${prefix}Label__c`),
    );
    assert.equal(
      imported.bundle.mappings.mappings.find((value) => value.key === 'school')!
        .targetObject,
      'Account',
    );
  }
});

void test('keeps literal formulas, interpolation-looking text, whitespace and Unicode without interpretation', () => {
  const values = [
    '=HYPERLINK("https://invalid.example")',
    '+1',
    '-2',
    '@SUM(1)',
    '${answer}',
    ' \r\n\t😀e\u0301 ',
  ];
  for (const value of values) {
    const form = simpleForm([
      question('answer', {
        label: value,
        defaultValue: value,
        authorNotes: value,
        regexExample: value,
      }),
    ]);
    const exported = exportXlsFormTables(form, emptyMappings);
    assert.ok(exported.ok);
    assert.equal(row(exported.tables, 'answer').label, value);
    assert.equal(row(exported.tables, 'answer').default, value);
    const imported = importXlsFormTables(exported.tables);
    assert.ok(imported.ok);
    assert.equal(imported.bundle.definition.questions[0]!.defaultValue, value);
    assert.deepEqual(
      compileForm(imported.bundle.definition),
      compileForm(form),
    );
  }
});

void test('deterministic reordering does not mutate inputs or alias imported data to input tables', () => {
  const { form, mappings } = reviewerFixture();
  const before = JSON.stringify({ form, mappings });
  const exported = exportXlsFormTables(form, mappings);
  assert.ok(exported.ok);
  assert.equal(JSON.stringify({ form, mappings }), before);
  form.questions.reverse();
  form.choiceLists.reverse();
  for (const list of form.choiceLists) list.choices.reverse();
  form.skipRules.reverse();
  mappings.mappings.reverse();
  for (const mapping of mappings.mappings) mapping.fields.reverse();
  assert.deepEqual(exportXlsFormTables(form, mappings), exported);
  const tablesBefore = JSON.stringify(exported.tables);
  const imported = importXlsFormTables(exported.tables);
  assert.ok(imported.ok);
  imported.bundle.definition.form.title = 'Changed returned snapshot';
  assert.equal(JSON.stringify(exported.tables), tablesBefore);
});

void test('every visible cell, including headers, is checked against regenerated source', () => {
  const { tables } = fixture();
  for (const name of ['survey', 'choices', 'settings'] as const)
    for (let r = 0; r < tables.sheets[name].length; r++)
      for (let c = 0; c < tables.sheets[name][r]!.length; c++) {
        const mutated = structuredClone(tables);
        mutated.sheets[name][r]![c] += 'HOSTILE_SENTINEL';
        rejects(mutated);
      }
});

void test('deleted, added, reordered, truncated and malformed projection rows fail closed', () => {
  const { tables } = fixture();
  const mutations: ((value: XlsFormTables) => void)[] = [
    (value) => {
      value.sheets.survey.pop();
    },
    (value) => {
      value.sheets.survey.push([...value.sheets.survey[1]!]);
    },
    (value) => {
      value.sheets.survey[1]!.pop();
    },
    (value) => {
      value.sheets.survey[1]!.push('');
    },
    (value) => {
      value.sheets.choices.reverse();
    },
    (value) => {
      value.sheets.settings = [];
    },
    (value) => {
      value.sheets.kusanya_source = [];
    },
    (value) => {
      value.sheets.kusanya_source[0]![0] = 'part';
    },
    (value) => {
      value.sheets.kusanya_source[1]![0] = '01';
    },
    (value) => {
      value.sheets.kusanya_source[1]!.push('');
    },
  ];
  for (const mutate of mutations) {
    const mutated = structuredClone(tables);
    mutate(mutated);
    rejects(mutated);
  }
});

void test('source changes are not cryptographically sealed but must agree with the complete projection', () => {
  const { tables } = fixture();
  const source = JSON.parse(tables.sheets.kusanya_source[1]![1]!) as {
    definition: {
      form: { title: string };
      questions: { authorNotes?: string }[];
    };
  };
  source.definition.form.title = 'Changed title';
  tables.sheets.kusanya_source[1]![1] = JSON.stringify(source);
  rejects(tables);
  tables.sheets.settings[1]![0] = 'Changed title';
  assert.ok(importXlsFormTables(tables).ok);
  source.definition.questions.find((entry) => entry.authorNotes)!.authorNotes =
    'Changed author note';
  tables.sheets.kusanya_source[1]![1] = JSON.stringify(source);
  assert.ok(importXlsFormTables(tables).ok);
});

void test('source chunk order, boundaries, canonical JSON spelling and trailing rows are checked', () => {
  const { tables } = fixture();
  const original = tables.sheets.kusanya_source[1]![1]!;
  const variants = [
    [
      ['index', 'json'],
      ['1', original.slice(0, 50)],
      ['2', original.slice(50)],
    ],
    [
      ['index', 'json'],
      ['1', ` ${original}`],
    ],
    [
      ['index', 'json'],
      ['1', original],
      ['2', ''],
    ],
  ];
  for (const source of variants) {
    const mutated = structuredClone(tables);
    mutated.sheets.kusanya_source = source;
    rejects(mutated);
  }
});

void test('long source is chunked without splitting surrogate pairs and preserves large annotations', () => {
  const form = simpleForm([
    question('answer', { authorNotes: '😀'.repeat(16000) }),
  ]);
  const exported = exportXlsFormTables(form, emptyMappings);
  assert.ok(exported.ok);
  assert.ok(exported.tables.sheets.kusanya_source.length > 2);
  for (const [index, values] of exported.tables.sheets.kusanya_source
    .slice(1)
    .entries()) {
    assert.equal(values[0], String(index + 1));
    assert.ok(values[1]!.length <= 30000);
    assert.ok(validXmlText(values[1]!));
  }
  const imported = importXlsFormTables(exported.tables);
  assert.ok(imported.ok);
  assert.equal(
    imported.bundle.definition.questions[0]!.authorNotes,
    form.questions[0]!.authorNotes,
  );
});

void test('uses exact schema keys and rejects unknown metadata, missing sheets and wrong versions', () => {
  const { tables } = fixture();
  rejects({ ...tables, schemaVersion: 2 }, 'XLSFORM_SCHEMA_VERSION');
  rejects({ ...tables, kind: 'xlsform' }, 'XLSFORM_SCHEMA_VERSION');
  rejects({ ...tables, formula: 'HOSTILE_SENTINEL' }, 'XLSFORM_INPUT_SHAPE');
  rejects(
    { ...tables, sheets: { ...tables.sheets, hidden: [] } },
    'XLSFORM_INPUT_SHAPE',
  );
  const missing = structuredClone(tables) as unknown as {
    sheets: { settings?: string[][] };
  };
  delete missing.sheets.settings;
  rejects(missing, 'XLSFORM_INPUT_SHAPE');
});

void test('refuses getters, proxies, symbols, sparse/extended arrays and non-enumerable metadata without execution', () => {
  const { tables } = fixture();
  let invoked = 0;
  const getter = structuredClone(tables);
  Object.defineProperty(getter.sheets, 'survey', {
    enumerable: true,
    get() {
      invoked++;
      throw new Error('HOSTILE_SENTINEL');
    },
  });
  rejects(getter, 'XLSFORM_INPUT_SHAPE');
  const cellGetter = structuredClone(tables);
  Object.defineProperty(cellGetter.sheets.survey[1], '0', {
    enumerable: true,
    get() {
      invoked++;
      return 'HOSTILE_SENTINEL';
    },
  });
  rejects(cellGetter, 'XLSFORM_INPUT_SHAPE');
  const proxy = new Proxy(tables, {
    ownKeys() {
      invoked++;
      throw new Error('HOSTILE_SENTINEL');
    },
  });
  rejects(proxy, 'XLSFORM_INPUT_SHAPE');
  const revoked = Proxy.revocable(tables, {});
  revoked.revoke();
  rejects(revoked.proxy, 'XLSFORM_INPUT_SHAPE');
  const sparse = structuredClone(tables);
  Reflect.deleteProperty(sparse.sheets.survey[1]!, '0');
  rejects(sparse, 'XLSFORM_INPUT_SHAPE');
  const extended = structuredClone(tables);
  Object.assign(extended.sheets.survey, { extra: true });
  rejects(extended, 'XLSFORM_INPUT_SHAPE');
  const symbol = structuredClone(tables);
  Object.assign(symbol.sheets, { [Symbol('secret')]: 1 });
  rejects(symbol, 'XLSFORM_INPUT_SHAPE');
  const hidden = structuredClone(tables);
  Object.defineProperty(hidden, 'kind', {
    value: hidden.kind,
    enumerable: false,
  });
  rejects(hidden, 'XLSFORM_INPUT_SHAPE');
  assert.equal(invoked, 0);
});

void test('allows frozen ordinary data and prototype-free records', () => {
  const { tables } = fixture();
  const input = Object.assign(Object.create(null) as object, tables, {
    sheets: Object.assign(Object.create(null) as object, tables.sheets),
  });
  for (const sheet of Object.values(tables.sheets)) {
    for (const value of sheet) Object.freeze(value);
    Object.freeze(sheet);
  }
  Object.freeze(input);
  assert.ok(importXlsFormTables(input).ok);
});

void test('all cells must be literal XML-safe strings, never typed formulas, numbers or booleans', () => {
  const { tables } = fixture();
  for (const value of [
    null,
    undefined,
    1,
    true,
    { formula: 'HOSTILE_SENTINEL' },
    '\u0000',
    '\ud800',
  ]) {
    const mutated = structuredClone(tables);
    (mutated.sheets.survey[1] as unknown[])[2] = value;
    rejects(mutated, 'XLSFORM_INPUT_TEXT');
  }
});

void test('enforces cell, sheet-row, total-cell and total-text bounds before source parsing', () => {
  const { tables } = fixture();
  const cell = structuredClone(tables);
  cell.sheets.survey[1]![2] = 'a'.repeat(32768);
  rejects(cell, 'XLSFORM_CELL_LIMIT');
  const rows = structuredClone(tables);
  rows.sheets.survey = Array.from({ length: 6001 }, () => []);
  rejects(rows, 'XLSFORM_INPUT_LIMIT');
  const cells = structuredClone(tables);
  cells.sheets.survey = [Array<string>(100001).fill('')];
  rejects(cells, 'XLSFORM_INPUT_LIMIT');
  const totalCells = structuredClone(tables);
  totalCells.sheets.survey = [Array<string>(99999).fill('')];
  rejects(totalCells, 'XLSFORM_INPUT_LIMIT');
  const text = structuredClone(tables);
  text.sheets.survey = Array.from({ length: 260 }, () => ['a'.repeat(31000)]);
  rejects(text, 'XLSFORM_INPUT_LIMIT');
  const source = structuredClone(tables);
  source.sheets.kusanya_source = [
    ['index', 'json'],
    ...Array.from({ length: 134 }, (_, i) => [
      String(i + 1),
      'a'.repeat(30000),
    ]),
  ];
  rejects(source, 'XLSFORM_INPUT_LIMIT');
});

void test('export refuses an overlong visible cell but preserves the same text in chunked author annotations', () => {
  const atLimit = simpleForm([
    question('answer', { label: 'a'.repeat(32767) }),
  ]);
  const accepted = exportXlsFormTables(atLimit, emptyMappings);
  assert.ok(accepted.ok);
  const roundTrip = importXlsFormTables(accepted.tables);
  assert.ok(roundTrip.ok);
  assert.equal(
    roundTrip.bundle.definition.questions[0]!.label,
    atLimit.questions[0]!.label,
  );
  const visible = simpleForm([
    question('answer', { label: 'a'.repeat(32768) }),
  ]);
  assert.ok(compileForm(visible).ok);
  const exported = exportXlsFormTables(visible, emptyMappings);
  assert.equal(exported.ok, false);
  if (!exported.ok)
    assert.equal(exported.diagnostics[0]!.code, 'XLSFORM_CELL_LIMIT');
  assert.ok(
    exportXlsFormTables(
      simpleForm([question('answer', { authorNotes: 'a'.repeat(32768) })]),
      emptyMappings,
    ).ok,
  );
});

void test('unsupported compiler definitions and malformed mapping input propagate failure without partial tables', () => {
  const form = simpleForm([
    question('answer', { validationScript: 'HOSTILE_SENTINEL' }),
  ]);
  const exported = exportXlsFormTables(form, emptyMappings);
  assert.equal(exported.ok, false);
  assert.ok(!JSON.stringify(exported).includes('HOSTILE_SENTINEL'));
  assert.ok(!Object.hasOwn(exported, 'tables'));
  assert.equal(
    exportXlsFormTables(simpleForm(), {
      schemaVersion: 1,
      mappings: [{ key: 'bad' }],
    }).ok,
    false,
  );
});

void test('source JSON errors and deeply nested or cyclic table cells fail without partial output', () => {
  const { tables } = fixture();
  for (const source of ['{', '{"HOSTILE_SENTINEL":true}', 'null', '[]']) {
    const mutated = structuredClone(tables);
    mutated.sheets.kusanya_source[1]![1] = source;
    const imported = importXlsFormTables(mutated);
    assert.equal(imported.ok, false);
    assert.ok(!Object.hasOwn(imported, 'bundle'));
    assert.ok(!JSON.stringify(imported).includes('HOSTILE_SENTINEL'));
  }
  const nested = structuredClone(tables);
  const value: unknown[] = [];
  value.push(value);
  (nested.sheets.survey[1] as unknown[])[0] = value;
  rejects(nested, 'XLSFORM_INPUT_TEXT');
  const tooDeep = simpleForm([question('group0', { type: 'section' })]);
  for (let index = 1; index <= 33; index++)
    tooDeep.questions.push(
      question(`group${index}`, {
        type: index === 33 ? 'text' : 'section',
        parent: `group${index - 1}`,
      }),
    );
  const exported = exportXlsFormTables(tooDeep, emptyMappings);
  assert.equal(exported.ok, false);
  if (!exported.ok) assert.equal(exported.diagnostics[0]!.code, 'TREE_DEPTH');
});
