import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type {
  PrintMapping,
  PrintMappingBundle,
} from '../../src/print/mappings.js';
import { preflightPublication } from '../../src/publication/preflight.js';
import { simpleForm } from '../fixtures/compiler.js';

function mapping(
  key: string,
  targetObject: string,
  order: number,
): PrintMapping {
  return {
    key,
    order,
    kind: 'main',
    targetObject,
    fields: [
      {
        targetField: 'Answer__c',
        sourceKind: 'question',
        question: 'answer',
      },
    ],
  };
}

function bundle(mappings: PrintMapping[]): PrintMappingBundle {
  return { schemaVersion: 1, mappings };
}

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
    ...extra,
  };
}

function rawObject(
  name: string,
  fields: unknown[] = [rawField('Answer__c')],
): Record<string, unknown> {
  return {
    name,
    queryable: true,
    createable: true,
    updateable: true,
    fields,
    recordTypeInfos: [],
  };
}

void test('preflights compiled XML against one fresh Describe per distinct target', async () => {
  const requested: string[] = [];
  const mappings = bundle([
    mapping('visit-lower', 'visit__c', 3),
    mapping('account', 'Account', 2),
    mapping('visit', 'Visit__c', 1),
  ]);
  const form = simpleForm();
  const before = structuredClone({ form, mappings });
  const result = await preflightPublication(form, mappings, async (name) => {
    requested.push(name);
    return rawObject(name);
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(requested, ['Account', 'Visit__c']);
  assert.deepEqual(result.targetObjects, ['Account', 'Visit__c']);
  assert.equal(result.requestCount, 2);
  assert.equal(result.validation, 'publication-preflight-only');
  assert.match(result.xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.equal(
    result.xformSha256,
    createHash('sha256').update(result.xml).digest('hex'),
  );
  assert.deepEqual(result.warnings, []);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.targetObjects));
  assert.ok(Object.isFrozen(result.warnings));
  assert.deepEqual({ form, mappings }, before);
});

void test('is deterministic under mapping reordering and target-name casing', async () => {
  const left = bundle([
    mapping('visit-lower', 'visit__c', 2),
    mapping('account', 'Account', 1),
    mapping('visit', 'Visit__c', 3),
  ]);
  const right = bundle([
    mapping('visit', 'Visit__c', 3),
    mapping('visit-lower', 'visit__c', 2),
    mapping('account', 'Account', 1),
  ]);
  const requestOrders: string[][] = [[], []];
  const first = await preflightPublication(simpleForm(), left, async (name) => {
    requestOrders[0]!.push(name);
    return rawObject(name);
  });
  const second = await preflightPublication(
    simpleForm(),
    right,
    async (name) => {
      requestOrders[1]!.push(name);
      return rawObject(name);
    },
  );
  assert.deepEqual(first, second);
  assert.deepEqual(requestOrders, [
    ['Account', 'Visit__c'],
    ['Account', 'Visit__c'],
  ]);
});

void test('performs all local definition and mapping checks before Describe I/O', async () => {
  let calls = 0;
  const describe = async (name: string): Promise<unknown> => {
    calls++;
    return rawObject(name);
  };
  const invalidForm = { ...simpleForm(), schemaVersion: 2 };
  const formResult = await preflightPublication(
    invalidForm,
    bundle([mapping('visit', 'Visit__c', 1)]),
    describe,
  );
  assert.equal(formResult.ok, false);
  assert.equal(formResult.requestCount, 0);

  const mappingResult = await preflightPublication(
    simpleForm(),
    bundle([mapping('visit', 'not an api name', 1)]),
    describe,
  );
  assert.deepEqual(mappingResult, {
    ok: false,
    diagnostics: [{ code: 'PRINT_TARGET_NAME', location: 'mappings[0]' }],
    requestCount: 0,
  });
  assert.equal(calls, 0);
});

void test('uses detached inputs when caller data changes during Describe', async () => {
  const form = simpleForm();
  const mappings = bundle([mapping('visit', 'Visit__c', 1)]);
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = preflightPublication(form, mappings, async (name) => {
    await gate;
    return rawObject(name);
  });
  form.questions[0]!.name = 'changed_after_request';
  mappings.mappings[0]!.targetObject = 'Other__c';
  mappings.mappings[0]!.fields[0]!.targetField = 'Missing__c';
  release!();
  const result = await pending;
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.targetObjects, ['Visit__c']);
  assert.match(result.xml, /answer/);
  assert.doesNotMatch(result.xml, /changed_after_request/);
});

void test('fails closed without returning partial artifacts after Describe or target refusal', async () => {
  const mappings = bundle([mapping('visit', 'Visit__c', 1)]);
  const requestFailure = await preflightPublication(
    simpleForm(),
    mappings,
    async () => {
      throw new Error('PROVIDER_SECRET');
    },
  );
  assert.deepEqual(requestFailure, {
    ok: false,
    diagnostics: [{ code: 'PUBLISH_DESCRIBE_REQUEST', location: 'objects[0]' }],
    requestCount: 1,
  });
  assert.equal('xml' in requestFailure, false);
  assert.equal(
    JSON.stringify(requestFailure).includes('PROVIDER_SECRET'),
    false,
  );

  const targetFailure = await preflightPublication(
    simpleForm(),
    mappings,
    async (name) => rawObject(name, []),
  );
  assert.deepEqual(targetFailure, {
    ok: false,
    diagnostics: [
      {
        code: 'PUBLISH_TARGET_FIELD',
        location: 'mappings[0].fields[0].targetField',
      },
    ],
    requestCount: 1,
  });
  assert.equal('xml' in targetFailure, false);
});

void test('allows an empty mapping bundle without issuing Describe requests', async () => {
  let calls = 0;
  const result = await preflightPublication(
    simpleForm(),
    bundle([]),
    async (name) => {
      calls++;
      return rawObject(name);
    },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.targetObjects, []);
  assert.equal(result.requestCount, 0);
  assert.equal(calls, 0);
});

void test('carries target warnings in a detached immutable result', async () => {
  const mappings = bundle([
    {
      key: 'account',
      order: 1,
      kind: 'reference',
      targetObject: 'Account',
      matchingField: 'Name',
      fields: [],
    },
  ]);
  const result = await preflightPublication(
    simpleForm(),
    mappings,
    async (name) => rawObject(name, [rawField('Name')]),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.warnings, [
    { code: 'PUBLISH_MATCH_NOT_UNIQUE', location: 'mappings[0].matchingField' },
  ]);
  assert.ok(Object.isFrozen(result.warnings[0]));
});
