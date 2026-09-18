import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { importAuthoringBundle } from '../../src/interchange/bundle.js';
import { importXlsFormWorkbook } from '../../src/interchange/xlsx-workbook.js';
import type {
  PrintMapping,
  PrintMappingBundle,
} from '../../src/print/mappings.js';
import {
  createPublicationPackage,
  verifyPublicationPackageDigest,
} from '../../src/publication/package.js';
import { question, simpleForm } from '../fixtures/compiler.js';

interface PackageShape {
  audience: string;
  authoring: { json: string; sha256: string };
  kind: string;
  schemaVersion: number;
  targetObjects: string[];
  targetSchema: { json: string; sha256: string };
  warnings: { code: string; location: string }[];
  xform: { xml: string; sha256: string };
  xlsform: { base64: string; sha256: string };
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function field(
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

function describedObject(
  name: string,
  fields: unknown[] = [field('Answer__c')],
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

void test('builds a self-contained content-addressed package using canonical Describe names', async () => {
  const form = simpleForm();
  const mappings = bundle([mapping('visit', 'visit__c', 1)]);
  const before = structuredClone({ form, mappings });
  const requested: string[] = [];
  const result = await createPublicationPackage(
    form,
    mappings,
    async (name) => {
      requested.push(name);
      return describedObject('Visit__c');
    },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(requested, ['visit__c']);
  assert.deepEqual(result.targetObjects, ['Visit__c']);
  assert.equal(result.requestCount, 1);
  assert.equal(result.validation, 'publication-package-only');
  assert.equal(result.audience, 'publisher-only');
  assert.equal(result.packageSha256, sha256(result.packageJson));
  assert.ok(
    verifyPublicationPackageDigest(result.packageJson, result.packageSha256),
  );

  const packaged = JSON.parse(result.packageJson) as PackageShape;
  assert.deepEqual(Object.keys(packaged).sort(), [
    'audience',
    'authoring',
    'kind',
    'schemaVersion',
    'targetObjects',
    'targetSchema',
    'warnings',
    'xform',
    'xlsform',
  ]);
  assert.equal(packaged.schemaVersion, 1);
  assert.equal(packaged.kind, 'kusanya-publication-package');
  assert.equal(packaged.audience, 'publisher-only');
  assert.deepEqual(packaged.targetObjects, ['Visit__c']);
  assert.equal(packaged.authoring.sha256, sha256(packaged.authoring.json));
  assert.equal(packaged.xform.sha256, sha256(packaged.xform.xml));
  const workbook = Buffer.from(packaged.xlsform.base64, 'base64');
  assert.equal(packaged.xlsform.sha256, sha256(workbook));
  assert.equal(
    packaged.targetSchema.sha256,
    sha256(packaged.targetSchema.json),
  );
  assert.equal(result.authoringSha256, packaged.authoring.sha256);
  assert.equal(result.xformSha256, packaged.xform.sha256);
  assert.equal(result.xlsformSha256, packaged.xlsform.sha256);
  assert.equal(result.targetSchemaSha256, packaged.targetSchema.sha256);
  const authoring = importAuthoringBundle(packaged.authoring.json);
  assert.equal(authoring.ok, true);
  const xlsform = importXlsFormWorkbook(workbook);
  assert.equal(xlsform.ok, true);
  const targetSchema = JSON.parse(packaged.targetSchema.json) as {
    objects: { apiName: string }[];
  };
  assert.deepEqual(
    targetSchema.objects.map(({ apiName }) => apiName),
    ['Visit__c'],
  );
  assert.match(packaged.authoring.json, /visit__c/);
  assert.deepEqual({ form, mappings }, before);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.targetObjects));
  assert.ok(Object.isFrozen(result.warnings));
});

void test('packages an explicitly empty mapping bundle with no Describe request', async () => {
  let calls = 0;
  const result = await createPublicationPackage(
    simpleForm(),
    bundle([]),
    async (name) => {
      calls++;
      return describedObject(name);
    },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(calls, 0);
  assert.equal(result.requestCount, 0);
  assert.deepEqual(result.targetObjects, []);
  const packaged = JSON.parse(result.packageJson) as PackageShape;
  assert.deepEqual(packaged.targetObjects, []);
});

void test('is byte-deterministic under definition, mapping and Describe reordering', async () => {
  const formA = simpleForm([
    question('second', { order: 2 }),
    question('answer', { order: 1 }),
  ]);
  const formB = simpleForm([
    question('answer', { order: 1 }),
    question('second', { order: 2 }),
  ]);
  const account = mapping('account', 'Account', 2);
  const visit = mapping('visit', 'Visit__c', 1);
  const makeDescribe =
    (reverse: boolean) =>
    async (name: string): Promise<unknown> =>
      describedObject(name, [
        ...(reverse ? [field('Unused__c')] : []),
        field('Answer__c'),
        ...(!reverse ? [field('Unused__c')] : []),
      ]);
  const first = await createPublicationPackage(
    formA,
    bundle([account, visit]),
    makeDescribe(false),
  );
  const second = await createPublicationPackage(
    formB,
    bundle([visit, account]),
    makeDescribe(true),
  );
  assert.deepEqual(first, second);
});

void test('finishes from detached canonical inputs when callers mutate during Describe', async () => {
  const form = simpleForm();
  const mappings = bundle([mapping('visit', 'Visit__c', 1)]);
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = createPublicationPackage(form, mappings, async (name) => {
    await gate;
    return describedObject(name);
  });
  form.questions[0]!.name = 'changed_after_request';
  mappings.mappings[0]!.targetObject = 'Other__c';
  mappings.mappings[0]!.fields[0]!.targetField = 'Missing__c';
  release!();
  const result = await pending;
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.targetObjects, ['Visit__c']);
  assert.doesNotMatch(
    result.packageJson,
    /changed_after_request|Other__c|Missing__c/,
  );
});

void test('performs authoring and workbook refusal before Describe I/O', async () => {
  let calls = 0;
  const result = await createPublicationPackage(
    simpleForm(),
    bundle([mapping('visit', 'not an api name', 1)]),
    async (name) => {
      calls++;
      return describedObject(name);
    },
  );
  assert.deepEqual(result, {
    ok: false,
    diagnostics: [{ code: 'PRINT_TARGET_NAME', location: 'mappings[0]' }],
    requestCount: 0,
  });
  assert.equal(calls, 0);
});

void test('returns no partial package after provider or target refusal', async () => {
  const mappings = bundle([mapping('visit', 'Visit__c', 1)]);
  const provider = await createPublicationPackage(
    simpleForm(),
    mappings,
    async () => {
      throw new Error('PROVIDER_SECRET');
    },
  );
  assert.equal(provider.ok, false);
  assert.equal(provider.requestCount, 1);
  assert.equal('packageJson' in provider, false);
  assert.equal(JSON.stringify(provider).includes('PROVIDER_SECRET'), false);

  const target = await createPublicationPackage(
    simpleForm(),
    mappings,
    async (name) => describedObject(name, []),
  );
  assert.deepEqual(target, {
    ok: false,
    diagnostics: [
      {
        code: 'PUBLISH_TARGET_FIELD',
        location: 'mappings[0].fields[0].targetField',
      },
    ],
    requestCount: 1,
  });
  assert.equal('packageJson' in target, false);
});

void test('seals warnings and detects package or digest tampering', async () => {
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
  const result = await createPublicationPackage(
    simpleForm(),
    mappings,
    async (name) => describedObject(name, [field('Name')]),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.warnings, [
    { code: 'PUBLISH_MATCH_NOT_UNIQUE', location: 'mappings[0].matchingField' },
  ]);
  assert.ok(Object.isFrozen(result.warnings[0]));
  assert.equal(
    verifyPublicationPackageDigest(
      `${result.packageJson} `,
      result.packageSha256,
    ),
    false,
  );
  assert.equal(
    verifyPublicationPackageDigest(
      result.packageJson,
      `0${result.packageSha256.slice(1)}`,
    ),
    false,
  );
  assert.equal(
    verifyPublicationPackageDigest(result.packageJson, 'A'.repeat(64)),
    false,
  );
  assert.equal(verifyPublicationPackageDigest({}, result.packageSha256), false);
  assert.equal(
    verifyPublicationPackageDigest('x'.repeat(8_000_001), result.packageSha256),
    false,
  );
});
