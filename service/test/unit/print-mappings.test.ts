import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildGraph } from '../../src/compiler/definition.js';
import { CompileError } from '../../src/compiler/types.js';
import {
  decodePrintMappings,
  type PrintFieldMapping,
  type PrintMapping,
  type PrintMappingBundle,
} from '../../src/print/mappings.js';
import { nestedRepeatForm, question } from '../fixtures/compiler.js';

const definition = nestedRepeatForm();
definition.questions.push(
  question('root_answer'),
  question('section', { type: 'section' }),
  question('note', { type: 'note' }),
  question('end', { type: 'end' }),
);
const graph = buildGraph(definition, () => {});

function field(extra: Partial<PrintFieldMapping> = {}): PrintFieldMapping {
  return {
    targetField: 'Customer__c',
    sourceKind: 'question',
    question: 'root_answer',
    ...extra,
  } as PrintFieldMapping;
}

function mapping(extra: Partial<PrintMapping> = {}): PrintMapping {
  return {
    key: 'synthetic_mapping',
    kind: 'main',
    order: 1,
    targetObject: 'Customer__c',
    fields: [field()],
    ...extra,
  };
}

function bundle(mappings = [mapping()]): PrintMappingBundle {
  return { schemaVersion: 1, mappings };
}

function decode(input: unknown): PrintMappingBundle {
  return decodePrintMappings(input, graph, () => {});
}

function reject(input: unknown, code: string, location?: string): void {
  const locations: string[] = [];
  assert.throws(
    () => decodePrintMappings(input, graph, (path) => locations.push(path)),
    (error: unknown) => {
      assert.ok(error instanceof CompileError);
      assert.equal(error.code, code);
      assert.equal(error.message, code);
      assert.match(error.code, /^PRINT_[A-Z_]+$/);
      assert.doesNotMatch(error.message, /PRIVATE_SENTINEL/);
      return true;
    },
  );
  for (const path of locations)
    assert.match(path, /^mappings(?:\[\d+\](?:\.fields\[\d+\])?)?$/);
  if (location !== undefined) assert.equal(locations.at(-1), location);
}

void test('requires an explicit bundle and accepts explicitly empty mappings', () => {
  assert.deepEqual(decode(bundle([])), bundle([]));
  for (const value of [undefined, null, [], 'PRIVATE_SENTINEL'])
    reject(value, 'PRINT_INPUT_SHAPE', 'mappings');
  reject({ mappings: [] }, 'PRINT_SCHEMA_VERSION');
  reject({ schemaVersion: 2, mappings: [] }, 'PRINT_SCHEMA_VERSION');
  reject({ schemaVersion: 1 }, 'PRINT_INPUT_SHAPE');
});

void test('preserves all portable summary values without mutation or normalization', () => {
  const input = bundle([
    mapping({
      key: 'reference',
      kind: 'reference',
      label: 'Synthetic <review> & display label',
      matchingField: 'Name',
      targetObject: 'Account__r',
      recordType: 'foreign__Customer',
      collectorField: 'OtherNs__Collector__c',
      submissionField: 'OtherNs__Submission__c',
      upsertExternalIdField: 'OtherNs__External_Id__c',
    }),
    mapping({
      key: 'repeat_one',
      kind: 'repeat',
      repeatQuestion: 'members',
      parentMapping: 'reference',
      parentLookupField: 'foreign__Account__c',
      fields: [
        field(),
        field({ targetField: 'Detail__c', question: 'member_name' }),
      ],
    }),
    mapping({
      key: 'repeat_two',
      kind: 'repeat',
      repeatQuestion: 'checks',
      parentMapping: 'reference',
      parentLookupField: 'Account__c',
    }),
  ]);
  const before = structuredClone(input);
  const output = decode(input);
  assert.deepEqual(input, before);
  assert.deepEqual(output, input);
  assert.notEqual(output, input);
  assert.notEqual(output.mappings[0], input.mappings[0]);
  assert.notEqual(output.mappings[0]!.fields[0], input.mappings[0]!.fields[0]);
});

void test('keeps explicit null, empty, whitespace, zero and false constant spellings', () => {
  const values = [
    null,
    '',
    ' ',
    '0',
    'false',
    '\t leading \n interior  space \r trailing\t',
  ];
  const fields: PrintFieldMapping[] = values.map((constantValue, index) => ({
    targetField: `Value${index}__c`,
    sourceKind: 'constant',
    constantValue,
  }));
  const output = decode(bundle([mapping({ fields })]));
  assert.deepEqual(output.mappings[0]!.fields, fields);
  assert.ok(!Object.hasOwn(output.mappings[0]!.fields[0]!, 'transform'));
});

void test('accepts every C4 transform without evaluating or defaulting it', () => {
  const transforms = [
    'none',
    'picklist_match',
    'multi_select_join',
    'lookup_by_external_id',
    'date_only',
    'boolean_yes_no',
    'number',
    'text_truncate',
    'geopoint_lat',
    'geopoint_lng',
    'geopoint_accuracy',
    'file_url',
  ] as const;
  for (const transform of transforms) {
    const input = bundle([mapping({ fields: [field({ transform })] })]);
    assert.deepEqual(decode(input), input);
  }
  reject(
    bundle([
      mapping({
        fields: [
          {
            ...field(),
            transform: 'PRIVATE_SENTINEL',
          } as unknown as PrintFieldMapping,
        ],
      }),
    ]),
    'PRINT_INPUT_ENUM',
  );
});

void test('strictly rejects untrusted statuses and all unknown properties', () => {
  reject(
    { ...bundle(), PRIVATE_SENTINEL: 'secret' },
    'PRINT_INPUT_SHAPE',
    'mappings',
  );
  for (const property of [
    'matchStatus',
    'matchDetail',
    'authorNotes',
    'PRIVATE_SENTINEL',
  ]) {
    reject(
      bundle([{ ...mapping(), [property]: 'ok' }]),
      'PRINT_INPUT_SHAPE',
      'mappings[0]',
    );
    reject(
      bundle([mapping({ fields: [{ ...field(), [property]: 'ok' }] })]),
      'PRINT_INPUT_SHAPE',
      'mappings[0].fields[0]',
    );
  }
});

void test('rejects proxies at every structural level without invoking traps', () => {
  let invoked = 0;
  const poison = <T extends object>(value: T): T =>
    new Proxy(value, {
      get() {
        invoked++;
        throw new Error('PRIVATE_SENTINEL');
      },
      getPrototypeOf() {
        invoked++;
        throw new Error('PRIVATE_SENTINEL');
      },
      ownKeys() {
        invoked++;
        throw new Error('PRIVATE_SENTINEL');
      },
      getOwnPropertyDescriptor() {
        invoked++;
        throw new Error('PRIVATE_SENTINEL');
      },
    });
  for (const input of [
    poison(bundle()),
    { schemaVersion: 1, mappings: poison([mapping()]) },
    bundle([poison(mapping())]),
    bundle([mapping({ fields: poison([field()]) })]),
    bundle([mapping({ fields: [poison(field())] })]),
  ])
    reject(input, 'PRINT_INPUT_SHAPE');
  const revoked = Proxy.revocable(bundle(), {});
  revoked.revoke();
  reject(revoked.proxy, 'PRINT_INPUT_SHAPE');
  assert.equal(invoked, 0);
});

void test('rejects getters, symbols, exotic prototypes and non-JSON executable data', () => {
  let invoked = 0;
  const getter = {
    get() {
      invoked++;
      throw new Error('PRIVATE_SENTINEL');
    },
    enumerable: true,
  };
  for (const key of ['schemaVersion', 'mappings']) {
    const input = bundle();
    Object.defineProperty(input, key, getter);
    reject(input, 'PRINT_INPUT_SHAPE');
  }
  for (const key of ['key', 'label', 'fields']) {
    const input = mapping();
    Object.defineProperty(input, key, getter);
    reject(bundle([input]), 'PRINT_INPUT_SHAPE');
  }
  const source = field();
  Object.defineProperty(source, 'question', getter);
  reject(bundle([mapping({ fields: [source] })]), 'PRINT_INPUT_SHAPE');
  for (const value of [
    new Date(),
    Object.assign(Object.create({}), bundle()),
    { ...bundle(), [Symbol('PRIVATE_SENTINEL')]: true },
  ])
    reject(value, 'PRINT_INPUT_SHAPE');
  const input = {
    ...bundle(),
    toJSON() {
      invoked++;
      return bundle();
    },
  };
  reject(input, 'PRINT_INPUT_SHAPE');
  reject(
    bundle([
      mapping({
        label: (() => {
          invoked++;
        }) as unknown as string,
      }),
    ]),
    'PRINT_INPUT_TEXT',
  );
  assert.equal(invoked, 0);
});

void test('accepts safe null-prototype records and frozen input', () => {
  const input = Object.assign(
    Object.create(null) as Record<string, unknown>,
    bundle(),
  );
  assert.deepEqual(decode(input), bundle());
  const frozen = bundle();
  Object.freeze(frozen.mappings[0]!.fields[0]);
  Object.freeze(frozen.mappings[0]!.fields);
  Object.freeze(frozen.mappings[0]);
  Object.freeze(frozen.mappings);
  Object.freeze(frozen);
  assert.deepEqual(decode(frozen), frozen);
});

void test('rejects sparse, extended, accessor and exotic arrays without reading elements', () => {
  let invoked = 0;
  const sparse: PrintMapping[] = Array<PrintMapping>(1);
  const extended = Object.assign([mapping()], { PRIVATE_SENTINEL: 'secret' });
  const symbol = Object.assign([mapping()], { [Symbol('secret')]: true });
  const accessor = [mapping()];
  Object.defineProperty(accessor, '0', {
    get() {
      invoked++;
      return mapping();
    },
  });
  const exotic = [mapping()];
  Object.setPrototypeOf(exotic, null);
  for (const mappings of [sparse, extended, symbol, accessor, exotic])
    reject({ schemaVersion: 1, mappings }, 'PRINT_INPUT_SHAPE');
  const sparseFields: PrintFieldMapping[] = Array<PrintFieldMapping>(1);
  reject(bundle([mapping({ fields: sparseFields })]), 'PRINT_INPUT_SHAPE');
  assert.equal(invoked, 0);
});

void test('rejects invalid API tokens while preserving namespace and relation spellings', () => {
  for (const value of [
    'Account',
    'foreign__Object__c',
    'Account__r',
    'Account__R',
    'A_B',
    'A1__B2',
  ])
    assert.equal(
      decode(bundle([mapping({ targetObject: value })])).mappings[0]!
        .targetObject,
      value,
    );
  for (const value of [
    '',
    ' Account',
    'Account ',
    '_Account',
    'Account.Name',
    'A___B',
    'A_',
    'https://PRIVATE_SENTINEL',
    'SELECT Id',
    'Åccount',
  ]) {
    reject(bundle([mapping({ targetObject: value })]), 'PRINT_TARGET_NAME');
    reject(
      bundle([mapping({ fields: [field({ targetField: value })] })]),
      'PRINT_TARGET_NAME',
    );
  }
});

void test('rejects duplicate keys and case-insensitive target fields within one mapping', () => {
  reject(
    bundle([mapping(), mapping()]),
    'PRINT_DUPLICATE_MAPPING',
    'mappings[1]',
  );
  reject(
    bundle([
      mapping({ fields: [field(), field({ targetField: 'customer__C' })] }),
    ]),
    'PRINT_DUPLICATE_TARGET',
    'mappings[0].fields[1]',
  );
  assert.equal(
    decode(bundle([mapping(), mapping({ key: 'second' })])).mappings.length,
    2,
  );
});

void test('requires exact source discrimination and valid answerable question references', () => {
  for (const name of ['PRIVATE_SENTINEL', 'families', 'section', 'note', 'end'])
    reject(
      bundle([mapping({ fields: [field({ question: name })] })]),
      'PRINT_FIELD_QUESTION',
      'mappings[0].fields[0]',
    );
  for (const invalid of [
    {
      targetField: 'Name',
      sourceKind: 'question',
      question: 'root_answer',
      constantValue: null,
    },
    {
      targetField: 'Name',
      sourceKind: 'question',
      question: 'root_answer',
      constantValue: undefined,
    },
    {
      targetField: 'Name',
      sourceKind: 'constant',
      constantValue: '',
      question: undefined,
    },
    { targetField: 'Name', sourceKind: 'constant' },
  ])
    reject(
      bundle([mapping({ fields: [invalid as PrintFieldMapping] })]),
      'PRINT_FIELD_SOURCE',
    );
  for (const constantValue of [undefined, 0, false, {}, []])
    reject(
      bundle([
        mapping({
          fields: [
            {
              targetField: 'Name',
              sourceKind: 'constant',
              constantValue,
            } as PrintFieldMapping,
          ],
        }),
      ]),
      'PRINT_INPUT_TEXT',
    );
});

void test('checks repeat and reference shapes without claiming execution compatibility', () => {
  for (const repeatQuestion of ['root_answer', 'PRIVATE_SENTINEL'])
    reject(
      bundle([mapping({ kind: 'repeat', repeatQuestion })]),
      'PRINT_REPEAT_QUESTION',
    );
  reject(
    bundle([mapping({ repeatQuestion: 'families' })]),
    'PRINT_REPEAT_QUESTION',
  );
  reject(bundle([mapping({ kind: 'reference' })]), 'PRINT_MATCHING_FIELD');
  reject(bundle([mapping({ matchingField: 'Id' })]), 'PRINT_MATCHING_FIELD');
  // A sibling-repeat source and a stamp/manual-target collision are printable
  // review facts; publisher checks must still decide their executable validity.
  const input = bundle([
    mapping({
      kind: 'repeat',
      repeatQuestion: 'checks',
      collectorField: 'Customer__c',
      fields: [field({ question: 'member_name' })],
    }),
  ]);
  assert.deepEqual(decode(input), input);
});

void test('requires paired, known parent keys and rejects self and longer cycles', () => {
  reject(
    bundle([mapping({ parentMapping: 'missing' })]),
    'PRINT_PARENT_MAPPING',
  );
  reject(
    bundle([mapping({ parentLookupField: 'Parent__c' })]),
    'PRINT_PARENT_MAPPING',
  );
  reject(
    bundle([
      mapping({
        parentMapping: 'PRIVATE_SENTINEL',
        parentLookupField: 'Parent__c',
      }),
    ]),
    'PRINT_PARENT_MAPPING',
    'mappings[0]',
  );
  reject(
    bundle([
      mapping({
        parentMapping: 'synthetic_mapping',
        parentLookupField: 'Parent__c',
      }),
    ]),
    'PRINT_PARENT_CYCLE',
  );
  const cycle = ['a', 'b', 'c'].map((key, index, keys) =>
    mapping({
      key,
      parentMapping: keys[(index + 1) % keys.length]!,
      parentLookupField: 'Parent__c',
    }),
  );
  reject(bundle(cycle), 'PRINT_PARENT_CYCLE');
  const forward = bundle([
    mapping({
      key: 'child',
      parentMapping: 'parent',
      parentLookupField: 'Parent__c',
    }),
    mapping({ key: 'parent' }),
  ]);
  assert.deepEqual(decode(forward), forward);
});

void test('enforces positive integral bounded order and primitive optional values', () => {
  for (const order of [0, -1, 1.5, NaN, Infinity, 1e12 + 1])
    reject(bundle([mapping({ order })]), 'PRINT_INPUT_NUMBER');
  assert.equal(
    decode(bundle([mapping({ order: 1e12 })])).mappings[0]!.order,
    1e12,
  );
  reject(
    bundle([mapping({ label: undefined } as unknown as PrintMapping)]),
    'PRINT_INPUT_TEXT',
  );
  reject(
    bundle([mapping({ recordType: undefined } as unknown as PrintMapping)]),
    'PRINT_INPUT_TEXT',
  );
});

void test('enforces mapping, field and per-string boundaries', () => {
  const manyMappings = Array.from({ length: 100 }, (_, index) =>
    mapping({ key: `m${index}`, fields: [] }),
  );
  assert.equal(decode(bundle(manyMappings)).mappings.length, 100);
  reject(bundle([...manyMappings, mapping()]), 'PRINT_INPUT_LIMIT');
  const fields: PrintFieldMapping[] = Array.from({ length: 2000 }, (_, index) =>
    field({ targetField: `Field${index}` }),
  );
  assert.equal(
    decode(bundle([mapping({ fields })])).mappings[0]!.fields.length,
    2000,
  );
  reject(
    bundle([mapping({ fields: [...fields, field({ targetField: 'Extra' })] })]),
    'PRINT_INPUT_LIMIT',
  );
  reject(
    bundle([
      mapping({ fields: fields.slice(0, 1000) }),
      mapping({ key: 'second', fields: fields.slice(0, 1001) }),
    ]),
    'PRINT_INPUT_LIMIT',
  );
  const input = bundle([
    mapping({
      key: 'k'.repeat(80),
      label: 'l'.repeat(255),
      targetObject: 'A'.repeat(255),
      fields: [
        {
          targetField: 'Value',
          sourceKind: 'constant',
          constantValue: 'c'.repeat(32768),
        },
      ],
    }),
  ]);
  assert.deepEqual(decode(input), input);
  reject(bundle([mapping({ key: 'k'.repeat(81) })]), 'PRINT_INPUT_TEXT');
  reject(bundle([mapping({ label: 'l'.repeat(256) })]), 'PRINT_INPUT_TEXT');
  reject(
    bundle([mapping({ targetObject: 'A'.repeat(256) })]),
    'PRINT_INPUT_TEXT',
  );
  reject(
    bundle([
      mapping({
        fields: [
          {
            targetField: 'Value',
            sourceKind: 'constant',
            constantValue: 'c'.repeat(32769),
          },
        ],
      }),
    ]),
    'PRINT_INPUT_TEXT',
  );
});

void test('enforces exactly 500000 aggregate string units, including enumerations', () => {
  const fields: PrintFieldMapping[] = Array.from(
    { length: 16 },
    (_, index) => ({
      targetField: `Field${index}`,
      sourceKind: 'constant',
      constantValue: '',
    }),
  );
  const input = bundle([mapping({ fields })]);
  function units(value: unknown): number {
    if (typeof value === 'string') return value.length;
    if (value && typeof value === 'object')
      return Object.values(value).reduce<number>(
        (sum, item: unknown) => sum + units(item),
        0,
      );
    return 0;
  }
  let remaining = 500_000 - units(input);
  for (const entry of fields) {
    assert.equal(entry.sourceKind, 'constant');
    if (entry.sourceKind !== 'constant') throw new Error('Synthetic fixture');
    const length = Math.min(32768, remaining);
    entry.constantValue = 'x'.repeat(length);
    remaining -= length;
  }
  assert.equal(remaining, 0);
  assert.equal(units(input), 500_000);
  assert.deepEqual(decode(input), input);
  const finalField = fields.at(-1)!;
  if (finalField.sourceKind !== 'constant')
    throw new Error('Synthetic fixture');
  finalField.constantValue += 'x';
  reject(input, 'PRINT_INPUT_LIMIT');
});

void test('rejects malformed Unicode or control text with safe diagnostics', () => {
  for (const value of ['PRIVATE_SENTINEL\u0000', '\ud800', '\ufffe'])
    reject(
      bundle([mapping({ label: value })]),
      'PRINT_INPUT_TEXT',
      'mappings[0]',
    );
});
