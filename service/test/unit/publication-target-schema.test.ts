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
import { simpleForm } from '../fixtures/compiler.js';

function field(
  apiName: string,
  extra: Partial<TargetFieldSchema> = {},
): TargetFieldSchema {
  return {
    apiName,
    readable: true,
    createable: true,
    updateable: true,
    externalId: false,
    unique: false,
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
