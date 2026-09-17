import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  PrintMapping,
  PrintMappingBundle,
} from '../../src/print/mappings.js';
import {
  validatePublicationTargets,
  type TargetFieldSchema,
  type TargetObjectSchema,
  type TargetSchemaSnapshot,
} from '../../src/publication/target-schema.js';
import { question, simpleForm } from '../fixtures/compiler.js';

function field(
  apiName: string,
  extra: Partial<TargetFieldSchema> = {},
): TargetFieldSchema {
  return {
    apiName,
    type: extra.referenceTo?.length ? 'reference' : 'string',
    readable: true,
    createable: true,
    updateable: true,
    nillable: true,
    externalId: false,
    unique: false,
    restrictedPicklist: false,
    picklistValues: [],
    referenceTo: [],
    ...extra,
  };
}
function object(
  apiName: string,
  fields: TargetFieldSchema[],
  extra: Partial<TargetObjectSchema> = {},
): TargetObjectSchema {
  return {
    apiName,
    queryable: true,
    createable: true,
    updateable: true,
    fields,
    recordTypes: [],
    ...extra,
  };
}
function mapping(extra: Partial<PrintMapping> = {}): PrintMapping {
  return {
    key: 'main',
    order: 1,
    kind: 'main',
    targetObject: 'Visit__c',
    fields: [
      {
        targetField: 'Answer__c',
        sourceKind: 'question',
        question: 'answer',
      },
    ],
    ...extra,
  };
}
const bundle = (mappings: PrintMapping[]): PrintMappingBundle => ({
  schemaVersion: 1,
  mappings,
});
const snapshot = (objects: TargetObjectSchema[]): TargetSchemaSnapshot => ({
  schemaVersion: 1,
  objects,
});

void test('validates objects, fields, record types, references, stamps and external IDs', () => {
  const mappings = bundle([
    mapping({
      key: 'account',
      kind: 'reference',
      targetObject: 'Account',
      matchingField: 'Name',
      upsertExternalIdField: 'Source_Id__c',
      recordType: 'Customer',
      collectorField: 'Collector__c',
      submissionField: 'Submission__c',
      fields: [],
    }),
    mapping({
      key: 'visit',
      order: 2,
      parentMapping: 'account',
      parentLookupField: 'Account__c',
    }),
  ]);
  const schema = snapshot([
    object(
      'Account',
      [
        field('Name', { unique: true }),
        field('Source_Id__c', { externalId: true, unique: true }),
        field('Collector__c'),
        field('Submission__c'),
      ],
      {
        recordTypes: [
          { developerName: 'Customer', active: true, available: true },
        ],
      },
    ),
    object('Visit__c', [
      field('Answer__c'),
      field('Account__c', { referenceTo: ['Account'] }),
    ]),
  ]);
  const before = structuredClone({ mappings, schema });
  assert.deepEqual(validatePublicationTargets(simpleForm(), mappings, schema), {
    ok: true,
    validation: 'target-schema-only',
    warnings: [],
  });
  assert.deepEqual({ mappings, schema }, before);
});

void test('rejects lexical relationship names that do not exist in Describe', () => {
  const result = validatePublicationTargets(
    simpleForm(),
    bundle([mapping({ targetObject: 'Account__r' })]),
    snapshot([object('Account', [field('Answer__c')])]),
  );
  assert.deepEqual(result, {
    ok: false,
    diagnostics: [
      { code: 'PUBLISH_TARGET_OBJECT', location: 'mappings[0].targetObject' },
    ],
  });
});

void test('reports bounded structural locations for access and compatibility failures', () => {
  const mappings = bundle([
    mapping({
      key: 'parent',
      targetObject: 'Parent__c',
      fields: [],
    }),
    mapping({
      key: 'child',
      order: 2,
      parentMapping: 'parent',
      parentLookupField: 'Parent__c',
      recordType: 'Disabled',
      collectorField: 'Locked__c',
      fields: [
        {
          targetField: 'Missing__c',
          sourceKind: 'question',
          question: 'answer',
        },
      ],
    }),
  ]);
  const schema = snapshot([
    object('Parent__c', [], { createable: false }),
    object(
      'Visit__c',
      [
        field('Parent__c', { referenceTo: ['Wrong__c'] }),
        field('Locked__c', { createable: false }),
      ],
      {
        recordTypes: [
          { developerName: 'Disabled', active: false, available: true },
        ],
      },
    ),
  ]);
  assert.deepEqual(validatePublicationTargets(simpleForm(), mappings, schema), {
    ok: false,
    diagnostics: [
      {
        code: 'PUBLISH_TARGET_OBJECT_ACCESS',
        location: 'mappings[0].targetObject',
      },
      { code: 'PUBLISH_RECORD_TYPE', location: 'mappings[1].recordType' },
      {
        code: 'PUBLISH_TARGET_FIELD',
        location: 'mappings[1].fields[0].targetField',
      },
      {
        code: 'PUBLISH_TARGET_FIELD_WRITE',
        location: 'mappings[1].collectorField',
      },
      {
        code: 'PUBLISH_PARENT_LOOKUP',
        location: 'mappings[1].parentLookupField',
      },
    ],
  });
});

void test('requires readable matching and a writable unique external ID', () => {
  const mappings = bundle([
    mapping({
      kind: 'reference',
      matchingField: 'Name',
      upsertExternalIdField: 'Source_Id__c',
      fields: [],
    }),
  ]);
  const schema = snapshot([
    object('Visit__c', [
      field('Name', { readable: false }),
      field('Source_Id__c', {
        externalId: true,
        unique: false,
        updateable: false,
      }),
    ]),
  ]);
  assert.deepEqual(validatePublicationTargets(simpleForm(), mappings, schema), {
    ok: false,
    diagnostics: [
      {
        code: 'PUBLISH_TARGET_FIELD_READ',
        location: 'mappings[0].matchingField',
      },
      {
        code: 'PUBLISH_EXTERNAL_ID',
        location: 'mappings[0].upsertExternalIdField',
      },
    ],
  });
});

void test('requires update access for assignment and stamp fields on reference upsert', () => {
  const mappings = bundle([
    mapping({
      kind: 'reference',
      matchingField: 'Name',
      upsertExternalIdField: 'Source_Id__c',
      collectorField: 'Collector__c',
    }),
  ]);
  const schema = snapshot([
    object('Visit__c', [
      field('Name', { unique: true }),
      field('Source_Id__c', { externalId: true, unique: true }),
      field('Answer__c', { updateable: false }),
      field('Collector__c', { updateable: false }),
    ]),
  ]);
  assert.deepEqual(validatePublicationTargets(simpleForm(), mappings, schema), {
    ok: false,
    diagnostics: [
      {
        code: 'PUBLISH_TARGET_FIELD_WRITE',
        location: 'mappings[0].fields[0].targetField',
      },
      {
        code: 'PUBLISH_TARGET_FIELD_WRITE',
        location: 'mappings[0].collectorField',
      },
    ],
  });
});

void test('accepts explicit source, transform and Salesforce field type combinations', () => {
  const form = simpleForm([
    question('text_value'),
    question('whole_value', { type: 'integer', order: 2 }),
    question('decimal_value', { type: 'decimal', order: 3 }),
    question('choice_value', {
      type: 'select_one',
      choiceList: 'status',
      order: 4,
    }),
    question('many_values', {
      type: 'select_multiple',
      choiceList: 'status',
      order: 5,
    }),
    question('date_value', { type: 'datetime', order: 6 }),
    question('point_value', { type: 'geopoint', order: 7 }),
    question('photo_value', { type: 'photo', order: 8 }),
  ]);
  form.choiceLists = [
    {
      name: 'status',
      choices: [
        { value: 'open', label: 'Open', order: 1 },
        { value: 'closed', label: 'Closed', order: 2 },
      ],
    },
  ];
  const fields: PrintMapping['fields'] = [
    { targetField: 'Text__c', sourceKind: 'question', question: 'text_value' },
    {
      targetField: 'Whole__c',
      sourceKind: 'question',
      question: 'whole_value',
    },
    {
      targetField: 'Amount__c',
      sourceKind: 'question',
      question: 'decimal_value',
    },
    {
      targetField: 'Status__c',
      sourceKind: 'question',
      question: 'choice_value',
      transform: 'picklist_match',
    },
    {
      targetField: 'Statuses__c',
      sourceKind: 'question',
      question: 'many_values',
      transform: 'multi_select_join',
    },
    {
      targetField: 'Day__c',
      sourceKind: 'question',
      question: 'date_value',
      transform: 'date_only',
    },
    {
      targetField: 'Account__c',
      sourceKind: 'question',
      question: 'text_value',
      transform: 'lookup_by_external_id',
    },
    {
      targetField: 'Confirmed__c',
      sourceKind: 'question',
      question: 'choice_value',
      transform: 'boolean_yes_no',
    },
    {
      targetField: 'Parsed_Number__c',
      sourceKind: 'question',
      question: 'text_value',
      transform: 'number',
    },
    {
      targetField: 'Short_Text__c',
      sourceKind: 'question',
      question: 'text_value',
      transform: 'text_truncate',
    },
    {
      targetField: 'Latitude__c',
      sourceKind: 'question',
      question: 'point_value',
      transform: 'geopoint_lat',
    },
    {
      targetField: 'Longitude__c',
      sourceKind: 'question',
      question: 'point_value',
      transform: 'geopoint_lng',
    },
    {
      targetField: 'Accuracy__c',
      sourceKind: 'question',
      question: 'point_value',
      transform: 'geopoint_accuracy',
    },
    {
      targetField: 'Photo_Url__c',
      sourceKind: 'question',
      question: 'photo_value',
      transform: 'file_url',
    },
  ];
  const picklist = {
    restrictedPicklist: true,
    picklistValues: [
      { value: 'open', active: true },
      { value: 'closed', active: true },
    ],
  };
  const schema = snapshot([
    object('Visit__c', [
      field('Text__c'),
      field('Whole__c', { type: 'integer' }),
      field('Amount__c', { type: 'currency' }),
      field('Status__c', { type: 'picklist', ...picklist }),
      field('Statuses__c', { type: 'multipicklist', ...picklist }),
      field('Day__c', { type: 'date' }),
      field('Account__c', { type: 'reference', referenceTo: ['Account'] }),
      field('Confirmed__c', { type: 'boolean' }),
      field('Parsed_Number__c', { type: 'double' }),
      field('Short_Text__c'),
      field('Latitude__c', { type: 'double' }),
      field('Longitude__c', { type: 'double' }),
      field('Accuracy__c', { type: 'double' }),
      field('Photo_Url__c', { type: 'url' }),
    ]),
  ]);
  assert.deepEqual(
    validatePublicationTargets(form, bundle([mapping({ fields })]), schema),
    {
      ok: true,
      validation: 'target-schema-only',
      warnings: [],
    },
  );
});

void test('fails closed for incompatible transforms, sources and target types', () => {
  const form = simpleForm([
    question('text_value'),
    question('whole_value', { type: 'integer', order: 2 }),
    question('many_values', {
      type: 'select_multiple',
      choiceList: 'status',
      order: 3,
    }),
  ]);
  form.choiceLists = [
    {
      name: 'status',
      choices: [{ value: 'open', label: 'Open', order: 1 }],
    },
  ];
  const fields: PrintMapping['fields'] = [
    { targetField: 'Flag__c', sourceKind: 'question', question: 'text_value' },
    {
      targetField: 'Text__c',
      sourceKind: 'question',
      question: 'whole_value',
    },
    {
      targetField: 'Many__c',
      sourceKind: 'question',
      question: 'many_values',
    },
    {
      targetField: 'Latitude__c',
      sourceKind: 'question',
      question: 'text_value',
      transform: 'geopoint_lat',
    },
  ];
  const result = validatePublicationTargets(
    form,
    bundle([mapping({ fields })]),
    snapshot([
      object('Visit__c', [
        field('Flag__c', { type: 'boolean' }),
        field('Text__c'),
        field('Many__c', { type: 'multipicklist' }),
        field('Latitude__c', { type: 'double' }),
      ]),
    ]),
  );
  assert.deepEqual(result, {
    ok: false,
    diagnostics: fields.map((_, index) => ({
      code: 'PUBLISH_TARGET_FIELD_TYPE',
      location: `mappings[0].fields[${index}].targetField`,
    })),
  });
});

void test('rejects missing or inactive values for restricted picklists', () => {
  const form = simpleForm([
    question('status', { type: 'select_one', choiceList: 'status' }),
  ]);
  form.choiceLists = [
    {
      name: 'status',
      choices: [
        { value: 'open', label: 'Open', order: 1 },
        { value: 'PRIVATE_SENTINEL', label: 'Closed', order: 2 },
      ],
    },
  ];
  const result = validatePublicationTargets(
    form,
    bundle([
      mapping({
        fields: [
          {
            targetField: 'Status__c',
            sourceKind: 'question',
            question: 'status',
            transform: 'picklist_match',
          },
        ],
      }),
    ]),
    snapshot([
      object('Visit__c', [
        field('Status__c', {
          type: 'picklist',
          restrictedPicklist: true,
          picklistValues: [
            { value: 'open', active: true },
            { value: 'PRIVATE_SENTINEL', active: false },
          ],
        }),
      ]),
    ]),
  );
  assert.deepEqual(result, {
    ok: false,
    diagnostics: [
      {
        code: 'PUBLISH_PICKLIST_VALUE',
        location: 'mappings[0].fields[0].targetField',
      },
    ],
  });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL/);
});

void test('allows null, empty and whitespace constants only for nillable fields without a transform', () => {
  const mappings = bundle([
    mapping({
      fields: [
        {
          targetField: 'Optional_Number__c',
          sourceKind: 'constant',
          constantValue: null,
        },
        {
          targetField: 'Required_Number__c',
          sourceKind: 'constant',
          constantValue: null,
        },
        {
          targetField: 'Transformed__c',
          sourceKind: 'constant',
          constantValue: null,
          transform: 'number',
        },
        {
          targetField: 'Required_Empty__c',
          sourceKind: 'constant',
          constantValue: '',
        },
        {
          targetField: 'Required_Whitespace__c',
          sourceKind: 'constant',
          constantValue: ' \t ',
        },
        {
          targetField: 'Transformed_Empty__c',
          sourceKind: 'constant',
          constantValue: '',
          transform: 'text_truncate',
        },
        {
          targetField: 'Transformed_Whitespace__c',
          sourceKind: 'constant',
          constantValue: '   ',
          transform: 'text_truncate',
        },
      ],
    }),
  ]);
  assert.deepEqual(
    validatePublicationTargets(
      simpleForm(),
      mappings,
      snapshot([
        object('Visit__c', [
          field('Optional_Number__c', { type: 'double' }),
          field('Required_Number__c', { type: 'double', nillable: false }),
          field('Transformed__c', { type: 'double' }),
          field('Required_Empty__c', { nillable: false }),
          field('Required_Whitespace__c', { nillable: false }),
          field('Transformed_Empty__c'),
          field('Transformed_Whitespace__c'),
        ]),
      ]),
    ),
    {
      ok: false,
      diagnostics: [
        {
          code: 'PUBLISH_TARGET_FIELD_REQUIRED',
          location: 'mappings[0].fields[1].targetField',
        },
        {
          code: 'PUBLISH_TARGET_FIELD_TYPE',
          location: 'mappings[0].fields[2].targetField',
        },
        {
          code: 'PUBLISH_TARGET_FIELD_REQUIRED',
          location: 'mappings[0].fields[3].targetField',
        },
        {
          code: 'PUBLISH_TARGET_FIELD_REQUIRED',
          location: 'mappings[0].fields[4].targetField',
        },
        {
          code: 'PUBLISH_TARGET_FIELD_TYPE',
          location: 'mappings[0].fields[5].targetField',
        },
        {
          code: 'PUBLISH_TARGET_FIELD_TYPE',
          location: 'mappings[0].fields[6].targetField',
        },
      ],
    },
  );
});

void test('accepts a nonblank constant without a transform for a combobox', () => {
  assert.deepEqual(
    validatePublicationTargets(
      simpleForm(),
      bundle([
        mapping({
          fields: [
            {
              targetField: 'Status__c',
              sourceKind: 'constant',
              constantValue: 'open',
            },
          ],
        }),
      ]),
      snapshot([
        object('Visit__c', [
          field('Status__c', {
            type: 'combobox',
            restrictedPicklist: true,
            picklistValues: [{ value: 'open', active: true }],
          }),
        ]),
      ]),
    ),
    { ok: true, validation: 'target-schema-only', warnings: [] },
  );
});

void test('warns for readable non-unique reference matching', () => {
  const result = validatePublicationTargets(
    simpleForm(),
    bundle([mapping({ kind: 'reference', matchingField: 'Name', fields: [] })]),
    snapshot([object('Visit__c', [field('Name')])]),
  );
  assert.deepEqual(result, {
    ok: true,
    validation: 'target-schema-only',
    warnings: [
      {
        code: 'PUBLISH_MATCH_NOT_UNIQUE',
        location: 'mappings[0].matchingField',
      },
    ],
  });
});

void test('allows a read-only reference object but requires it to be queryable', () => {
  const mappings = bundle([
    mapping({ kind: 'reference', matchingField: 'Id', fields: [] }),
  ]);
  const readOnly = object('Visit__c', [field('Id', { unique: true })], {
    createable: false,
    updateable: false,
  });
  assert.equal(
    validatePublicationTargets(simpleForm(), mappings, snapshot([readOnly])).ok,
    true,
  );
  readOnly.queryable = false;
  assert.deepEqual(
    validatePublicationTargets(simpleForm(), mappings, snapshot([readOnly])),
    {
      ok: false,
      diagnostics: [
        {
          code: 'PUBLISH_TARGET_OBJECT_ACCESS',
          location: 'mappings[0].targetObject',
        },
      ],
    },
  );
});

void test('rejects stamp collisions with assignments and one another', () => {
  const schema = snapshot([
    object('Visit__c', [field('Answer__c'), field('Submission__c')]),
  ]);
  const result = validatePublicationTargets(
    simpleForm(),
    bundle([
      mapping({
        collectorField: 'Answer__c',
        submissionField: 'ANSWER__C',
      }),
    ]),
    schema,
  );
  assert.deepEqual(result, {
    ok: false,
    diagnostics: [
      {
        code: 'PUBLISH_STAMP_CONFLICT',
        location: 'mappings[0].collectorField',
      },
      {
        code: 'PUBLISH_STAMP_CONFLICT',
        location: 'mappings[0].submissionField',
      },
    ],
  });
});

void test('strictly rejects duplicate names, accessors, proxies, sparse arrays and limits', () => {
  const valid = snapshot([object('Visit__c', [field('Answer__c')])]);
  const reject = (schema: unknown, code: string): void => {
    const result = validatePublicationTargets(
      simpleForm(),
      bundle([mapping()]),
      schema,
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.diagnostics.length, 1);
      assert.equal(result.diagnostics[0]!.code, code);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL/);
    }
  };
  reject(
    snapshot([object('Visit__c', []), object('VISIT__C', [])]),
    'PUBLISH_SCHEMA_DUPLICATE',
  );
  reject({ ...valid, privateSentinel: true }, 'PUBLISH_SCHEMA_SHAPE');
  reject({ schemaVersion: 2, objects: [] }, 'PUBLISH_SCHEMA_VERSION');
  const unsupportedType = structuredClone(valid) as unknown as {
    objects: { fields: { type: string }[] }[];
  };
  unsupportedType.objects[0]!.fields[0]!.type = 'PRIVATE_SENTINEL';
  reject(unsupportedType, 'PUBLISH_SCHEMA_SHAPE');
  reject(
    snapshot(
      Array.from({ length: 101 }, (_, index) => object(`O${index}__c`, [])),
    ),
    'PUBLISH_SCHEMA_LIMIT',
  );
  const sparse = new Array(1);
  reject({ schemaVersion: 1, objects: sparse }, 'PUBLISH_SCHEMA_SHAPE');
  let invoked = 0;
  const poison = new Proxy(valid, {
    getPrototypeOf() {
      invoked++;
      throw new Error('PRIVATE_SENTINEL');
    },
  });
  reject(poison, 'PUBLISH_SCHEMA_SHAPE');
  reject(
    {
      schemaVersion: 1,
      get objects() {
        invoked++;
        throw new Error('PRIVATE_SENTINEL');
      },
    },
    'PUBLISH_SCHEMA_SHAPE',
  );
  assert.equal(invoked, 0);
});

void test('schema order and API-name case do not change validation', () => {
  const mappings = bundle([mapping()]);
  const a = snapshot([
    object('Unused__c', []),
    object('Visit__c', [field('Unused__c'), field('Answer__c')]),
  ]);
  const b = snapshot([
    object('visit__c', [field('answer__c'), field('unused__c')]),
    object('unused__c', []),
  ]);
  assert.deepEqual(
    validatePublicationTargets(simpleForm(), mappings, a),
    validatePublicationTargets(simpleForm(), mappings, b),
  );
});
