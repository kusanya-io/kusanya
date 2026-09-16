import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileForm } from '../../src/compiler/compile.js';
import type { FormDefinition } from '../../src/compiler/types.js';
import {
  exportAuthoringBundle,
  importAuthoringBundle,
  type AuthoringBundleResult,
} from '../../src/interchange/bundle.js';
import type { PrintMappingBundle } from '../../src/print/mappings.js';
import { createSalesforceNames } from '../../src/salesforce-names.js';
import { odkFixtures, question, simpleForm } from '../fixtures/compiler.js';
import { largeReviewerFixture, reviewerFixture } from '../fixtures/print.js';

const emptyMappings: PrintMappingBundle = { schemaVersion: 1, mappings: [] };
function success(result: AuthoringBundleResult) {
  assert.ok(result.ok, JSON.stringify(result));
  return result;
}
function rejected(result: AuthoringBundleResult, code?: string) {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('Expected refusal');
  assert.equal(result.diagnostics.length, 1);
  if (code) assert.equal(result.diagnostics[0]!.code, code);
  assert.deepEqual(Object.keys(result).sort(), ['diagnostics', 'ok']);
  return result.diagnostics[0]!;
}

void test('round trips each shared compiler fixture with identical XML and canonical warnings', () => {
  for (const fixture of Object.values(odkFixtures)) {
    const definition = fixture();
    const before = compileForm(definition);
    const exported = success(exportAuthoringBundle(definition, emptyMappings));
    const imported = success(importAuthoringBundle(exported.json));
    assert.equal(exported.audience, 'authoring-only');
    assert.equal(exported.validation, 'structural-only');
    assert.equal(imported.json, exported.json);
    assert.deepEqual(JSON.parse(imported.json), JSON.parse(exported.json));
    assert.deepEqual(compileForm(imported.bundle.definition), before);
    const canonical = compileForm(imported.bundle.definition);
    assert.ok(canonical.ok);
    assert.deepEqual(imported.warnings, canonical.warnings);
  }
});

void test('round trips complete mapping and 144-node synthetic fixtures without mutating inputs', () => {
  for (const fixture of [reviewerFixture, largeReviewerFixture]) {
    const { form, mappings } = fixture();
    const before = JSON.stringify({ form, mappings });
    const result = success(exportAuthoringBundle(form, mappings));
    const imported = success(importAuthoringBundle(result.json));
    assert.equal(imported.json, result.json);
    assert.equal(JSON.stringify({ form, mappings }), before);
    assert.equal(
      result.bundle.definition.questions.length,
      form.questions.length,
    );
    assert.equal(
      result.bundle.mappings.mappings.length,
      mappings.mappings.length,
    );
    const originalXml = compileForm(form);
    const roundTripXml = compileForm(imported.bundle.definition);
    assert.ok(originalXml.ok && roundTripXml.ok);
    assert.equal(roundTripXml.xml, originalXml.xml);
  }
});

void test('canonicalizes record order without renumbering author order or changing XML', () => {
  const { form, mappings } = reviewerFixture();
  form.choiceLists.push({
    name: 'another',
    choices: [{ value: 'z', label: 'Z', order: 7 }],
  });
  form.skipRules.push({
    question: 'reason',
    sourceQuestion: 'age',
    operator: 'in_range',
    value: '0.00',
    valueTo: '100.000',
    join: 'all',
    action: 'show',
  });
  const before = success(exportAuthoringBundle(form, mappings));
  const original = compileForm(form);
  form.questions.reverse();
  form.choiceLists.reverse();
  for (const list of form.choiceLists) list.choices.reverse();
  form.skipRules.reverse();
  mappings.mappings.reverse();
  for (const mapping of mappings.mappings) mapping.fields.reverse();
  const after = success(exportAuthoringBundle(form, mappings));
  assert.equal(after.json, before.json);
  assert.deepEqual(after.warnings, before.warnings);
  const recompiled = compileForm(after.bundle.definition);
  assert.ok(original.ok && recompiled.ok);
  assert.equal(recompiled.xml, original.xml);
  assert.deepEqual(
    after.bundle.definition.questions.map((q) => q.name),
    [
      'visit',
      'site',
      'student_count',
      'students',
      'age',
      'handwashing',
      'reason',
      'samples',
      'observation',
      'closing',
      'visit_time',
    ],
  );
  assert.equal(after.bundle.definition.choiceLists[0]!.choices[0]!.order, 7);
  assert.ok(after.json.startsWith('{"definition":'));
});

void test('preserves author-only annotations, Unicode, whitespace, false, empty and null distinctly', () => {
  const definition = simpleForm([
    question('answer', {
      label: '  Shule / 学校 / 💧\r\n\t ',
      hint: '',
      authorNotes: '  author notes  ',
      regexExample: '00:00',
      required: false,
      readOnly: false,
      hidden: false,
      samePage: false,
      repeatAsTable: false,
      requireLivePhoto: false,
      defaultValue: '',
      calculation: '',
      constraint: '',
      constraintMessage: '',
      relevant: '',
      regex: '',
      appearance: '',
      prefillSource: '',
      validationScript: '',
    }),
  ]);
  const mappings: PrintMappingBundle = {
    schemaVersion: 1,
    mappings: [
      {
        key: 'main',
        label: '',
        order: 7,
        kind: 'main',
        targetObject: 'Account',
        fields: [
          null,
          '',
          ' ',
          '\r\n\t',
          '0',
          'false',
          '0001',
          '-0',
          '0.0000000000001',
        ].map((constantValue, index) => ({
          sourceKind: 'constant',
          constantValue,
          targetField: `Field${index}__c`,
          transform: 'none',
        })),
      },
    ],
  };
  const result = success(exportAuthoringBundle(definition, mappings));
  const imported = success(importAuthoringBundle(result.json));
  const parsed = JSON.parse(imported.json) as Record<string, unknown>;
  assert.deepEqual(parsed.definition, definition);
  assert.deepEqual(parsed.mappings, mappings);
  assert.ok(result.json.includes('author notes'));
  const collector = compileForm(imported.bundle.definition);
  assert.ok(collector.ok);
  assert.ok(!collector.xml.includes('author notes'));
  const withoutDefaults = success(
    exportAuthoringBundle(simpleForm(), emptyMappings),
  );
  assert.equal(
    Object.hasOwn(withoutDefaults.bundle.definition.questions[0]!, 'required'),
    false,
  );
});

void test('normalizes numeric negative zero only, preserving decimal string spelling', () => {
  const definition = simpleForm([
    question('number', {
      type: 'decimal',
      minimum: -0,
      maximum: 1,
      defaultValue: '-0.000',
    }),
  ]);
  const result = success(exportAuthoringBundle(definition, emptyMappings));
  assert.equal(
    Object.is(result.bundle.definition.questions[0]!.minimum, -0),
    false,
  );
  assert.equal(Object.is(definition.questions[0]!.minimum, -0), true);
  assert.equal(result.bundle.definition.questions[0]!.defaultValue, '-0.000');
  const imported = success(
    importAuthoringBundle(result.json.replace('"minimum":0', '"minimum":-0')),
  );
  assert.equal(imported.json, result.json);
  assert.deepEqual(
    compileForm(result.bundle.definition),
    compileForm(definition),
  );
});

void test('keeps supplied empty and ksny namespace mapping fixtures exact', () => {
  for (const prefix of ['', 'ksny__'] as const) {
    const names = createSalesforceNames(prefix);
    const mappings: PrintMappingBundle = {
      schemaVersion: 1,
      mappings: [
        {
          key: 'main',
          order: 1,
          kind: 'main',
          targetObject: names.kusanyaObject('Form__c'),
          fields: [
            {
              sourceKind: 'question',
              question: 'answer',
              targetField: names.kusanyaField('External_Id__c'),
            },
          ],
        },
      ],
    };
    const result = success(exportAuthoringBundle(simpleForm(), mappings));
    const imported = success(importAuthoringBundle(result.json));
    assert.deepEqual(
      (JSON.parse(imported.json) as Record<string, unknown>).mappings,
      mappings,
    );
  }
});

void test('takes detached snapshots and accepts null-prototype records without losing data', () => {
  const { form, mappings } = reviewerFixture();
  Object.setPrototypeOf(form, null);
  Object.setPrototypeOf(form.questions[0]!, null);
  const before = JSON.stringify({ form, mappings });
  const result = success(exportAuthoringBundle(form, mappings));
  result.bundle.definition.questions[0]!.label = 'changed output';
  result.bundle.mappings.mappings[0]!.fields.length = 0;
  assert.equal(JSON.stringify({ form, mappings }), before);
  assert.ok(!result.json.includes('changed output'));
  const second = success(exportAuthoringBundle(form, mappings));
  form.questions[0]!.label = 'changed input';
  assert.notEqual(
    second.bundle.definition.questions[0]!.label,
    'changed input',
  );
});

void test('never invokes accessors, proxies, custom toJSON, iterators or primitive coercion', () => {
  let invoked = 0;
  const trap = () => {
    invoked++;
    throw new Error('SECRET_SENTINEL');
  };
  const accessor = Object.defineProperty({}, 'questions', {
    enumerable: true,
    get: trap,
  });
  const proxy = new Proxy(
    {},
    { get: trap, getPrototypeOf: trap, ownKeys: trap },
  );
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const withJson = { ...simpleForm(), toJSON: trap };
  const withSymbol = Object.assign(simpleForm(), { [Symbol.iterator]: trap });
  const withCoercion = Object.assign(simpleForm(), {
    [Symbol.toPrimitive]: trap,
  });
  for (const input of [
    accessor,
    proxy,
    revoked.proxy,
    withJson,
    withSymbol,
    withCoercion,
  ]) {
    const result = exportAuthoringBundle(input, emptyMappings);
    rejected(result, 'BUNDLE_INPUT_SHAPE');
    assert.ok(!JSON.stringify(result).includes('SECRET_SENTINEL'));
  }
  const mappingAccessor = Object.defineProperty({}, 'mappings', {
    enumerable: true,
    get: trap,
  });
  rejected(
    exportAuthoringBundle(simpleForm(), mappingAccessor),
    'BUNDLE_INPUT_SHAPE',
  );
  rejected(importAuthoringBundle({ toString: trap }), 'BUNDLE_JSON_TYPE');
  assert.equal(invoked, 0);
});

void test('rejects optional undefined, sparse or extended arrays, symbols, cycles and exotic prototypes', () => {
  const optionalUndefined = {
    ...simpleForm(),
    questions: [{ ...question('answer'), hint: undefined }],
  };
  const sparse = { ...simpleForm(), questions: Array(1) as unknown[] };
  const extended = simpleForm();
  Object.assign(extended.questions, { extra: 1 });
  const symbolArray = simpleForm();
  Object.assign(symbolArray.questions, { [Symbol('x')]: 1 });
  const hidden = simpleForm();
  Object.defineProperty(hidden.questions[0]!, 'hint', {
    value: 'lost',
    enumerable: false,
  });
  const cycle = simpleForm() as unknown as Record<string, unknown>;
  cycle.extra = cycle;
  const weird = Object.assign(
    Object.create({ inherited: true }) as Record<string, unknown>,
    simpleForm(),
  );
  for (const input of [
    optionalUndefined,
    sparse,
    extended,
    symbolArray,
    hidden,
    cycle,
    weird,
    new Date(),
    undefined,
    1n,
  ])
    rejected(exportAuthoringBundle(input, emptyMappings), 'BUNDLE_INPUT_SHAPE');
});

void test('refuses forbidden structural keys, while their ordinary string values are harmless', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const input = simpleForm();
    Object.defineProperty(input.questions[0]!, key, {
      value: 'bad',
      enumerable: true,
    });
    rejected(exportAuthoringBundle(input, emptyMappings), 'BUNDLE_INPUT_SHAPE');
    rejected(importAuthoringBundle(`{"${key}":{}}`), 'BUNDLE_INPUT_SHAPE');
    const safe = success(
      exportAuthoringBundle(
        simpleForm([question('answer', { hint: key, authorNotes: key })]),
        emptyMappings,
      ),
    );
    assert.ok(safe.json.includes(key));
  }
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
});

void test('rejects duplicate decoded JSON keys at every level including escaped equivalents', () => {
  const encoded = success(
    exportAuthoringBundle(simpleForm(), emptyMappings),
  ).json;
  for (const bad of [
    '{"kind":"x","kind":"y"}',
    '{"kind":"x","\\u006bind":"y"}',
    '{"nested":{"label":"a","label":"b"}}',
    '{"nested":[{"a":1,"\\u0061":2}]}',
    encoded.replace('"label":"answer"', '"label":"answer","label":"answer"'),
  ])
    rejected(importAuthoringBundle(bad), 'BUNDLE_DUPLICATE_KEY');
});

void test('strict JSON grammar rejects invalid syntax without disclosing input', () => {
  for (const source of [
    '',
    ' ',
    '{',
    '[',
    '{"a":}',
    '[1,]',
    '{"a":1,}',
    '{a:1}',
    'undefined',
    'NaN',
    'Infinity',
    '-Infinity',
    '01',
    '-01',
    '+1',
    '.1',
    '1.',
    '1e',
    '1e+',
    'true false',
    'nullx',
    '/*SECRET_SENTINEL*/{}',
    '"\\x00"',
    '"\\uZZZZ"',
    '"\\u000"',
    '"unterminated',
    '"bad\nstring"',
    '\ufeff{}',
    '{} trailing_SECRET_SENTINEL',
  ]) {
    const result = importAuthoringBundle(source);
    rejected(result, 'BUNDLE_JSON_SYNTAX');
    assert.ok(!JSON.stringify(result).includes('SECRET_SENTINEL'));
  }
});

void test('requires exact envelope keys, version, kind and string input', () => {
  const bundle = success(
    exportAuthoringBundle(simpleForm(), emptyMappings),
  ).bundle;
  for (const value of [null, undefined, 42, bundle, [], new String('{}')])
    rejected(importAuthoringBundle(value), 'BUNDLE_JSON_TYPE');
  for (const value of [
    null,
    [],
    42,
    {},
    { ...bundle, extra: 1 },
    { kind: bundle.kind },
  ])
    rejected(
      importAuthoringBundle(JSON.stringify(value)),
      'BUNDLE_INPUT_SHAPE',
    );
  for (const patch of [
    { schemaVersion: 2 },
    { schemaVersion: '1' },
    { kind: 'collector' },
  ])
    rejected(
      importAuthoringBundle(JSON.stringify({ ...bundle, ...patch })),
      'BUNDLE_SCHEMA_VERSION',
    );
});

void test('enforces depth, cell, text and JSON size budgets before unbounded copying or parsing', () => {
  let nested: unknown = null;
  for (let index = 0; index < 66; index++) nested = [nested];
  rejected(exportAuthoringBundle(nested, emptyMappings), 'BUNDLE_INPUT_LIMIT');
  rejected(
    importAuthoringBundle('['.repeat(66) + 'null' + ']'.repeat(66)),
    'BUNDLE_INPUT_LIMIT',
  );
  rejected(
    exportAuthoringBundle(Array(100_001).fill(null), emptyMappings),
    'BUNDLE_INPUT_LIMIT',
  );
  rejected(
    importAuthoringBundle('[' + 'null,'.repeat(100_000) + 'null]'),
    'BUNDLE_INPUT_LIMIT',
  );
  rejected(
    exportAuthoringBundle('x'.repeat(2_000_001), emptyMappings),
    'BUNDLE_INPUT_LIMIT',
  );
  rejected(
    importAuthoringBundle('"' + 'x'.repeat(2_000_001) + '"'),
    'BUNDLE_INPUT_LIMIT',
  );
  rejected(importAuthoringBundle(' '.repeat(4_000_001)), 'BUNDLE_INPUT_LIMIT');
});

void test('the exact 100,000-node envelope exports and imports; two more nodes refuse both paths', () => {
  // Boundary fixture from an independent review: every key and every value is
  // charged, including the envelope's schemaVersion and kind fields.
  const questions = Array.from({ length: 500 }, (_, index) =>
    question(`q${index}`, {
      type: 'decimal',
      order: index + 1,
      label: 'X',
      hint: '',
      authorNotes: '',
      defaultValue: '',
      calculation: '',
      constraint: '',
      constraintMessage: '',
      regex: '',
      regexExample: '',
      relevant: '',
      appearance: '',
      prefillSource: '',
      validationScript: '',
      required: false,
      readOnly: false,
      hidden: false,
      samePage: false,
      repeatAsTable: false,
      requireLivePhoto: false,
      minimum: 0,
      maximum: 1,
    }),
  );
  const first = questions[0]!;
  first.type = 'text';
  delete first.minimum;
  delete first.maximum;
  const definition: FormDefinition = {
    schemaVersion: 1,
    form: { key: 'big', title: 'Big', version: 1 },
    questions,
    choiceLists: [
      {
        name: 'unused',
        choices: Array.from({ length: 5000 }, (_, index) => ({
          value: `c${index}`,
          label: 'C',
          order: index + 1,
          filterValue: '',
        })),
      },
    ],
    skipRules: Array.from({ length: 2000 }, () => ({
      question: 'q1',
      sourceQuestion: 'q0',
      operator: 'is',
      value: 'x',
      join: 'all',
      action: 'show',
    })),
  };
  const mappings: PrintMappingBundle = {
    schemaVersion: 1,
    mappings: [
      {
        key: 'main',
        order: 1,
        kind: 'main',
        targetObject: 'Account',
        fields: Array.from({ length: 637 }, (_, index) => ({
          sourceKind: 'constant',
          constantValue: 'x',
          targetField: `Field${index}__c`,
        })),
      },
    ],
  };
  const countNodes = (input: unknown): number => {
    if (input === null || typeof input !== 'object') return 1;
    if (Array.isArray(input))
      return (
        1 +
        input.reduce<number>(
          (count, child: unknown) => count + countNodes(child),
          0,
        )
      );
    return (
      1 +
      Object.entries(input).reduce(
        (count, [key, child]: [string, unknown]) =>
          count + countNodes(key) + countNodes(child),
        0,
      )
    );
  };
  const envelope = {
    schemaVersion: 1,
    kind: 'kusanya-authoring',
    definition,
    mappings,
  };
  assert.equal(countNodes(envelope), 100_000);
  const exported = success(exportAuthoringBundle(definition, mappings));
  assert.equal(
    success(importAuthoringBundle(exported.json)).json,
    exported.json,
  );
  mappings.mappings[0]!.label = '';
  assert.equal(countNodes(envelope), 100_002);
  rejected(exportAuthoringBundle(definition, mappings), 'BUNDLE_INPUT_LIMIT');
  rejected(
    importAuthoringBundle(JSON.stringify(envelope)),
    'BUNDLE_INPUT_LIMIT',
  );
});

void test('refuses nonfinite numbers and overflowing JSON numeric tokens', () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    const definition = simpleForm();
    definition.form.version = value;
    rejected(
      exportAuthoringBundle(definition, emptyMappings),
      'BUNDLE_INPUT_NUMBER',
    );
  }
  for (const value of ['1e9999', '-1e9999'])
    rejected(importAuthoringBundle(value), 'BUNDLE_INPUT_NUMBER');
});

void test('refuses JSON numeric rounding and underflow instead of changing authored bounds', () => {
  const template = success(
    exportAuthoringBundle(
      simpleForm([question('answer', { type: 'decimal', minimum: 0 })]),
      emptyMappings,
    ),
  ).json;
  for (const token of [
    '1e-999',
    '-1e-999',
    '0.00000099999999999999999999999999999',
    '1.0000000000000001',
    '9007199254740993',
    '123456789012.00000000001',
    '4.9406564584124654e-324',
    `0.1${'0'.repeat(100_000)}1`,
  ]) {
    const result = importAuthoringBundle(
      template.replace('"minimum":0', `"minimum":${token}`),
    );
    rejected(result, 'BUNDLE_INPUT_NUMBER');
    assert.ok(!JSON.stringify(result).includes(token));
  }
});

void test('accepts equivalent decimal spellings and canonicalizes numeric zero without string coercion', () => {
  const template = success(
    exportAuthoringBundle(
      simpleForm([question('answer', { type: 'decimal', minimum: 0 })]),
      emptyMappings,
    ),
  ).json;
  for (const token of [
    '1.00e0',
    '1',
    '0.10',
    '100e-3',
    '0.0000010',
    '-0',
    '-0.0000',
    '0e999999999999999999999999999999999999',
    '0.00e-999999999999999999999999999999999999',
  ]) {
    const result = success(
      importAuthoringBundle(
        template.replace('"minimum":0', `"minimum":${token}`),
      ),
    );
    assert.equal(
      result.bundle.definition.questions[0]!.minimum,
      Number(token) || 0,
    );
    assert.equal(success(importAuthoringBundle(result.json)).json, result.json);
  }
  const version = success(
    importAuthoringBundle(template.replace('"version":1', '"version":1e12')),
  );
  assert.equal(version.bundle.definition.form.version, 1_000_000_000_000);
});

void test('propagates compiler and mapping refusals with structural locations and no partial bundle', () => {
  const definition = simpleForm([
    question('answer', { type: 'end', authorNotes: 'SECRET_SENTINEL' }),
  ]);
  assert.deepEqual(
    exportAuthoringBundle(definition, emptyMappings),
    compileForm(definition),
  );
  const mapping = {
    schemaVersion: 1,
    mappings: [
      {
        key: 'x',
        order: 1,
        kind: 'main',
        targetObject: 'Account',
        fields: [
          {
            sourceKind: 'question',
            targetField: 'Name',
            question: 'unknown_SECRET_SENTINEL',
          },
        ],
      },
    ],
  };
  const failure = rejected(
    exportAuthoringBundle(simpleForm(), mapping),
    'PRINT_FIELD_QUESTION',
  );
  assert.equal(failure.location, 'mappings[0].fields[0]');
  assert.ok(!JSON.stringify(failure).includes('SECRET_SENTINEL'));
  rejected(
    exportAuthoringBundle({ ...simpleForm(), extra: '' }, emptyMappings),
    'INPUT_SHAPE',
  );
});
