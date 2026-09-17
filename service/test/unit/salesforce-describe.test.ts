import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  loadSalesforceTargetSchema,
  type DescribeObject,
} from '../../src/publication/salesforce-describe.js';
import { validatePublicationTargets } from '../../src/publication/target-schema.js';
import { simpleForm } from '../fixtures/compiler.js';

function rawField(
  name: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name,
    type: 'string',
    createable: true,
    updateable: true,
    nillable: true,
    externalId: false,
    unique: false,
    restrictedPicklist: false,
    picklistValues: [],
    referenceTo: [],
    label: 'ignored wire metadata',
    ...extra,
  };
}

function rawObject(
  name: string,
  fields: unknown[] = [rawField('Answer__c')],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name,
    queryable: true,
    createable: true,
    updateable: true,
    fields,
    recordTypeInfos: [],
    urls: { ignored: true },
    ...extra,
  };
}

void test('normalizes integration-user Describe metadata without mutating it', async () => {
  const response = rawObject(
    'Visit__c',
    [
      rawField('Status__c', {
        type: 'picklist',
        restrictedPicklist: true,
        picklistValues: [
          { value: 'closed', active: false, label: 'Closed' },
          { value: 'open', active: true, label: 'Open' },
        ],
      }),
      rawField('Account__c', {
        type: 'reference',
        referenceTo: ['User', 'Account'],
      }),
    ],
    {
      recordTypeInfos: [
        {
          developerName: 'Special',
          active: true,
          available: false,
          recordTypeId: '012000000000001AAA',
        },
      ],
    },
  );
  const before = structuredClone(response);
  const result = await loadSalesforceTargetSchema(
    ['Visit__c'],
    async () => response,
  );
  assert.deepEqual(result, {
    ok: true,
    requestCount: 1,
    snapshot: {
      schemaVersion: 1,
      objects: [
        {
          apiName: 'Visit__c',
          queryable: true,
          createable: true,
          updateable: true,
          fields: [
            {
              apiName: 'Account__c',
              type: 'reference',
              readable: true,
              createable: true,
              updateable: true,
              nillable: true,
              externalId: false,
              unique: false,
              restrictedPicklist: false,
              picklistValues: [],
              referenceTo: ['Account', 'User'],
            },
            {
              apiName: 'Status__c',
              type: 'picklist',
              readable: true,
              createable: true,
              updateable: true,
              nillable: true,
              externalId: false,
              unique: false,
              restrictedPicklist: true,
              picklistValues: [
                { value: 'closed', active: false },
                { value: 'open', active: true },
              ],
              referenceTo: [],
            },
          ],
          recordTypes: [
            { developerName: 'Special', active: true, available: false },
          ],
        },
      ],
    },
  });
  assert.deepEqual(response, before);
});

void test('deduplicates object names case-insensitively and requests fresh data every time', async () => {
  const calls: string[] = [];
  const describe: DescribeObject = async (name) => {
    calls.push(name);
    return rawObject(name);
  };
  const names = ['visit__c', 'Account', 'VISIT__C'];
  const first = await loadSalesforceTargetSchema(names, describe);
  const second = await loadSalesforceTargetSchema(names, describe);
  assert.equal(first.ok && first.requestCount, 2);
  assert.equal(second.ok && second.requestCount, 2);
  assert.deepEqual(calls, ['Account', 'visit__c', 'Account', 'visit__c']);
  assert.deepEqual(names, ['visit__c', 'Account', 'VISIT__C']);
});

void test('turns request failures and identity mismatches into non-disclosing diagnostics', async () => {
  const request = await loadSalesforceTargetSchema(
    ['PRIVATE_SENTINEL__c'],
    async () => {
      throw new Error('PRIVATE_PROVIDER_MESSAGE');
    },
  );
  assert.deepEqual(request, {
    ok: false,
    diagnostics: [{ code: 'PUBLISH_DESCRIBE_REQUEST', location: 'objects[0]' }],
    requestCount: 1,
  });
  const identity = await loadSalesforceTargetSchema(['Expected__c'], async () =>
    rawObject('PRIVATE_SENTINEL__c'),
  );
  assert.deepEqual(identity, {
    ok: false,
    diagnostics: [
      { code: 'PUBLISH_DESCRIBE_IDENTITY', location: 'objects[0].name' },
    ],
    requestCount: 1,
  });
  assert.doesNotMatch(
    JSON.stringify([request, identity]),
    /PRIVATE_SENTINEL|PRIVATE_PROVIDER/,
  );
});

void test('fails closed for hostile records and arrays without invoking supplied code', async () => {
  let invoked = false;
  const accessor = rawObject('Visit__c');
  Object.defineProperty(accessor, 'hostile', {
    enumerable: true,
    get() {
      invoked = true;
      return 'PRIVATE_SENTINEL';
    },
  });
  const accessorResult = await loadSalesforceTargetSchema(
    ['Visit__c'],
    async () => accessor,
  );
  assert.equal(accessorResult.ok, false);
  assert.equal(invoked, false);

  const proxy = new Proxy(rawObject('Visit__c'), {
    ownKeys() {
      invoked = true;
      return [];
    },
  });
  const proxyResult = await loadSalesforceTargetSchema(
    ['Visit__c'],
    async () => proxy,
  );
  assert.equal(proxyResult.ok, false);
  assert.equal(invoked, false);

  const sparse = rawObject('Visit__c');
  sparse.fields = new Array(1);
  const sparseResult = await loadSalesforceTargetSchema(
    ['Visit__c'],
    async () => sparse,
  );
  assert.equal(sparseResult.ok, false);
});

void test('rejects unknown types, duplicate metadata and misplaced metadata', async () => {
  const cases = [
    rawObject('Visit__c', [rawField('Bad__c', { type: 'String' })]),
    rawObject('Visit__c', [rawField('A__c'), rawField('a__c')]),
    rawObject('Visit__c', [
      rawField('Bad__c', {
        picklistValues: [{ value: 'x', active: true }],
      }),
    ]),
    rawObject('Visit__c', [rawField('Bad__c', { referenceTo: ['Account'] })]),
    rawObject('Visit__c', [
      rawField('Status__c', {
        type: 'picklist',
        picklistValues: [
          { value: 'x', active: true },
          { value: 'x', active: false },
        ],
      }),
    ]),
  ];
  for (const response of cases) {
    const result = await loadSalesforceTargetSchema(
      ['Visit__c'],
      async () => response,
    );
    assert.equal(result.ok, false);
  }
});

void test('enforces request and response bounds before further calls', async () => {
  let calls = 0;
  const tooManyNames = Array.from(
    { length: 101 },
    (_, index) => `Object_${index}__c`,
  );
  const namesResult = await loadSalesforceTargetSchema(
    tooManyNames,
    async () => {
      calls++;
      return rawObject('Unused__c');
    },
  );
  assert.deepEqual(namesResult, {
    ok: false,
    diagnostics: [{ code: 'PUBLISH_DESCRIBE_LIMIT', location: 'objects' }],
    requestCount: 0,
  });
  assert.equal(calls, 0);

  const tooManyFields = Array.from({ length: 5001 }, (_, index) =>
    rawField(`Field_${index}__c`),
  );
  const fieldsResult = await loadSalesforceTargetSchema(
    ['Visit__c'],
    async () => rawObject('Visit__c', tooManyFields),
  );
  assert.deepEqual(fieldsResult, {
    ok: false,
    diagnostics: [
      { code: 'PUBLISH_DESCRIBE_LIMIT', location: 'objects[0].fields' },
    ],
    requestCount: 1,
  });

  const aggregateFields = await loadSalesforceTargetSchema(
    ['First__c', 'Second__c'],
    async (objectName) =>
      rawObject(
        objectName,
        Array.from({ length: 2501 }, (_, index) =>
          rawField(`Field_${index}__c`),
        ),
      ),
  );
  assert.deepEqual(aggregateFields, {
    ok: false,
    diagnostics: [
      { code: 'PUBLISH_DESCRIBE_LIMIT', location: 'objects[1].fields' },
    ],
    requestCount: 2,
  });

  const aggregatePicklists = await loadSalesforceTargetSchema(
    ['Visit__c'],
    async () =>
      rawObject(
        'Visit__c',
        Array.from({ length: 6 }, (_, fieldIndex) =>
          rawField(`Picklist_${fieldIndex}__c`, {
            type: 'picklist',
            picklistValues: Array.from({ length: 2000 }, (_, valueIndex) => ({
              value: `value_${valueIndex}`,
              active: true,
            })),
          }),
        ),
      ),
  );
  assert.deepEqual(aggregatePicklists, {
    ok: false,
    diagnostics: [
      {
        code: 'PUBLISH_DESCRIBE_LIMIT',
        location: 'objects[0].fields[5].picklistValues',
      },
    ],
    requestCount: 1,
  });
});

void test('omitted FLS-inaccessible fields remain absent and downstream validation refuses them', async () => {
  const loaded = await loadSalesforceTargetSchema(['Visit__c'], async () =>
    rawObject('Visit__c', []),
  );
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  const result = validatePublicationTargets(
    simpleForm(),
    {
      schemaVersion: 1,
      mappings: [
        {
          key: 'main',
          order: 1,
          kind: 'main',
          targetObject: 'Visit__c',
          fields: [
            {
              targetField: 'Hidden__c',
              sourceKind: 'question',
              question: 'answer',
            },
          ],
        },
      ],
    },
    loaded.snapshot,
  );
  assert.deepEqual(result, {
    ok: false,
    diagnostics: [
      {
        code: 'PUBLISH_TARGET_FIELD',
        location: 'mappings[0].fields[0].targetField',
      },
    ],
  });
});
