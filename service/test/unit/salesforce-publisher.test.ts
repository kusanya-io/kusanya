import assert from 'node:assert/strict';
import { test } from 'node:test';
import { simpleForm } from '../fixtures/compiler.js';
import type { PrintMappingBundle } from '../../src/print/mappings.js';
import {
  publishSalesforceDefinition,
  salesforcePublisherApiVersion,
  type SalesforcePublisherConfiguration,
} from '../../src/publication/salesforce-publisher.js';

const formVersionId = 'a0B000000000001AAA';
const versionIds = ['068000000000001AAA', '068000000000002AAA'] as const;
const documentIds = ['069000000000001AAA', '069000000000002AAA'] as const;

const mappings: PrintMappingBundle = {
  schemaVersion: 1,
  mappings: [
    {
      key: 'visit',
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
    },
  ],
};

const snapshot = (): Record<string, unknown> => ({
  schemaVersion: 1,
  definition: simpleForm(),
  mappingBundle: structuredClone(mappings),
});

const described = (): Record<string, unknown> => ({
  name: 'Visit__c',
  queryable: true,
  createable: true,
  updateable: true,
  fields: [
    {
      name: 'Answer__c',
      type: 'string',
      createable: true,
      updateable: true,
      nillable: true,
      externalId: false,
      unique: false,
      restrictedPicklist: false,
      picklistValues: [],
      referenceTo: [],
    },
  ],
  recordTypeInfos: [],
});

const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=UTF-8' },
  });

const configuration = (
  extra: Partial<SalesforcePublisherConfiguration> = {},
): SalesforcePublisherConfiguration => ({
  instanceOrigin: 'https://tenant.my.salesforce.com',
  getAccessToken: async () => 'PRIVATE_TOKEN',
  perRequestTimeoutMs: 1_000,
  overallTimeoutMs: 10_000,
  ...extra,
});

interface ObservedRequest {
  url: string;
  init: RequestInit;
}

function requestUrl(input: string | URL | Request): string {
  return typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}

function requestBody(init: RequestInit): string {
  assert.equal(typeof init.body, 'string');
  return init.body as string;
}

function successfulFetch(
  observed: ObservedRequest[],
  options: { commitStatus?: number; mismatch?: boolean } = {},
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  let uploaded: [Uint8Array, Uint8Array] | undefined;
  return async (input, init = {}) => {
    const url = requestUrl(input);
    observed.push({ url, init });
    if (url.endsWith('/services/apexrest/v1/publications/definition'))
      return jsonResponse(snapshot());
    if (url.endsWith('/sobjects/Visit__c/describe'))
      return jsonResponse(described());
    if (url.endsWith('/composite/sobjects') && init.method === 'POST') {
      const body = JSON.parse(requestBody(init)) as {
        records: { VersionData: string }[];
      };
      uploaded = [
        Buffer.from(body.records[0]!.VersionData, 'base64'),
        Buffer.from(body.records[1]!.VersionData, 'base64'),
      ];
      return jsonResponse([
        { id: versionIds[0], success: true, errors: [] },
        { id: versionIds[1], success: true, errors: [] },
      ]);
    }
    if (url.includes('/composite/sobjects/ContentVersion?'))
      return jsonResponse([
        {
          attributes: { type: 'ContentVersion' },
          Id: versionIds[0],
          ContentDocumentId: documentIds[0],
          IsLatest: true,
          FileExtension: 'xml',
        },
        {
          attributes: { type: 'ContentVersion' },
          Id: versionIds[1],
          ContentDocumentId: documentIds[1],
          IsLatest: true,
          FileExtension: 'xlsx',
        },
      ]);
    if (url.endsWith(`/${versionIds[0]}/VersionData`)) {
      assert.ok(uploaded);
      const bytes = new Uint8Array(uploaded[0]);
      if (options.mismatch) bytes[0] = (bytes[0]! + 1) % 256;
      return new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });
    }
    if (url.endsWith(`/${versionIds[1]}/VersionData`)) {
      assert.ok(uploaded);
      return new Response(Buffer.from(uploaded[1]), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });
    }
    if (url.includes('/sobjects/ContentDocument/') && init.method === 'DELETE')
      return new Response(null, { status: 204 });
    if (url.endsWith('/services/apexrest/v1/publications/commit')) {
      const body = JSON.parse(requestBody(init)) as {
        publicationDigest: string;
      };
      return jsonResponse(
        {
          schemaVersion: 1,
          alreadyCommitted: false,
          publicationDigest: body.publicationDigest,
        },
        options.commitStatus ?? 200,
      );
    }
    throw new Error(`Unexpected request: ${url}`);
  };
}

const acceptXForm = async (): Promise<{ readonly ok: true }> => ({ ok: true });

void test('composes definition, Describe, package, attestation and commit in order', async () => {
  const observed: ObservedRequest[] = [];
  let tokens = 0;
  const result = await publishSalesforceDefinition(
    configuration({ getAccessToken: async () => `token-${++tokens}` }),
    { formVersionId },
    acceptXForm,
    successfulFetch(observed),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.requestCount, 7);
  assert.equal(tokens, 7);
  assert.equal(result.alreadyCommitted, false);
  assert.match(result.publicationDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    observed.map(({ url }) => new URL(url).pathname),
    [
      '/services/apexrest/v1/publications/definition',
      `/services/data/v${salesforcePublisherApiVersion}/sobjects/Visit__c/describe`,
      `/services/data/v${salesforcePublisherApiVersion}/composite/sobjects`,
      `/services/data/v${salesforcePublisherApiVersion}/composite/sobjects/ContentVersion`,
      `/services/data/v${salesforcePublisherApiVersion}/sobjects/ContentVersion/${versionIds[0]}/VersionData`,
      `/services/data/v${salesforcePublisherApiVersion}/sobjects/ContentVersion/${versionIds[1]}/VersionData`,
      '/services/apexrest/v1/publications/commit',
    ],
  );
  for (const [index, request] of observed.entries()) {
    assert.equal(request.init.cache, 'no-store');
    assert.equal(request.init.credentials, 'omit');
    assert.equal(request.init.redirect, 'manual');
    assert.equal(
      (request.init.headers as Record<string, string>).authorization,
      `Bearer token-${index + 1}`,
    );
  }
  const definitionBody = JSON.parse(requestBody(observed[0]!.init)) as unknown;
  assert.deepEqual(definitionBody, { schemaVersion: 1, formVersionId });
  const commitBody = JSON.parse(requestBody(observed[6]!.init)) as unknown;
  assert.deepEqual(commitBody, {
    schemaVersion: 1,
    formVersionId,
    publicationDigest: result.publicationDigest,
    xformVersionId: versionIds[0],
    xlsformVersionId: versionIds[1],
    compileWarnings: null,
  });
  assert.ok(Object.isFrozen(result));
});

void test('refuses hostile inputs before token acquisition or network I/O', async () => {
  const proxy = new Proxy({ formVersionId }, {});
  const lyingProxy = new Proxy(
    { formVersionId },
    { getPrototypeOf: () => Object.prototype },
  );
  const accessor = {};
  Object.defineProperty(accessor, 'formVersionId', {
    get: () => formVersionId,
  });
  const invalid = [
    null,
    [],
    proxy,
    lyingProxy,
    accessor,
    { formVersionId, extra: true },
    {},
    { formVersionId: '' },
    { formVersionId: 'not-an-id' },
  ];
  for (const request of invalid) {
    let tokens = 0;
    let requests = 0;
    const result = await publishSalesforceDefinition(
      configuration({
        getAccessToken: async () => {
          tokens++;
          return 'PRIVATE_TOKEN';
        },
      }),
      request as { formVersionId: string },
      acceptXForm,
      async () => {
        requests++;
        throw new Error('must not run');
      },
    );
    assert.deepEqual(result, {
      ok: false,
      diagnostics: [
        { code: 'PUBLICATION_PUBLISHER_INPUT', location: 'publisher' },
      ],
      requestCount: 0,
    });
    assert.equal(tokens, 0);
    assert.equal(requests, 0);
  }
});

void test('strictly refuses hostile connection configuration without invoking accessors', async () => {
  let getterCalls = 0;
  const accessor = {
    instanceOrigin: 'https://tenant.my.salesforce.com',
    get perRequestTimeoutMs() {
      getterCalls++;
      return 1_000;
    },
    getAccessToken: async () => 'PRIVATE_TOKEN',
    overallTimeoutMs: 10_000,
  };
  const invalid = [
    null,
    [],
    new Proxy(configuration(), {}),
    accessor,
    { ...configuration(), extra: true },
    { ...configuration(), instanceOrigin: 'http://tenant.my.salesforce.com' },
    { ...configuration(), instanceOrigin: 'https://example.com' },
    { ...configuration(), perRequestTimeoutMs: 0 },
    { ...configuration(), overallTimeoutMs: 120_001 },
    { ...configuration(), overallTimeoutMs: 999 },
  ];
  for (const value of invalid) {
    let requests = 0;
    const result = await publishSalesforceDefinition(
      value as SalesforcePublisherConfiguration,
      { formVersionId },
      acceptXForm,
      async () => {
        requests++;
        throw new Error('must not run');
      },
    );
    assert.deepEqual(result, {
      ok: false,
      diagnostics: [
        { code: 'PUBLICATION_PUBLISHER_INPUT', location: 'publisher' },
      ],
      requestCount: 0,
    });
    assert.equal(requests, 0);
  }
  assert.equal(getterCalls, 0);
});

void test('refuses malformed definition responses before Describe or artifact I/O', async () => {
  const malformed = [
    null,
    [],
    {},
    { ...snapshot(), schemaVersion: 2 },
    { ...snapshot(), extra: true },
  ];
  for (const body of malformed) {
    let requests = 0;
    const result = await publishSalesforceDefinition(
      configuration(),
      { formVersionId },
      acceptXForm,
      async () => {
        requests++;
        return jsonResponse(body);
      },
    );
    assert.deepEqual(result, {
      ok: false,
      diagnostics: [
        { code: 'PUBLICATION_PUBLISHER_DEFINITION', location: 'publisher' },
      ],
      requestCount: 1,
    });
    assert.equal(requests, 1);
  }
});

void test('bounds and strictly classifies the direct definition response', async () => {
  const responses = [
    new Response('{}', {
      status: 500,
      headers: { 'content-type': 'application/json' },
    }),
    new Response('{}', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }),
    new Response(new Uint8Array([0xff]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    new Response('{}', {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'content-length': '5000001',
      },
    }),
  ];
  for (const response of responses) {
    const result = await publishSalesforceDefinition(
      configuration(),
      { formVersionId },
      acceptXForm,
      async () => response,
    );
    assert.deepEqual(result, {
      ok: false,
      diagnostics: [
        { code: 'PUBLICATION_PUBLISHER_DEFINITION', location: 'publisher' },
      ],
      requestCount: 1,
    });
  }
});

void test('stops before artifact upload when fresh Describe refuses a target', async () => {
  const observed: ObservedRequest[] = [];
  const fetcher = successfulFetch(observed);
  const result = await publishSalesforceDefinition(
    configuration(),
    { formVersionId },
    acceptXForm,
    async (input, init) => {
      if (requestUrl(input).endsWith('/sobjects/Visit__c/describe'))
        return jsonResponse({ error: 'private provider value' }, 403);
      return await fetcher(input, init);
    },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.requestCount, 2);
  assert.equal(observed.length, 1);
  assert.equal(
    JSON.stringify(result).includes('private provider value'),
    false,
  );
});

void test('never commits artifacts that fail exact-byte attestation', async () => {
  const observed: ObservedRequest[] = [];
  const result = await publishSalesforceDefinition(
    configuration(),
    { formVersionId },
    acceptXForm,
    successfulFetch(observed, { mismatch: true }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.diagnostics, [
    { code: 'PUBLICATION_ARTIFACT_MISMATCH', location: 'artifacts' },
  ]);
  assert.equal(
    observed.some(({ url }) => url.endsWith('/v1/publications/commit')),
    false,
  );
  assert.equal(
    observed.filter(({ init }) => init.method === 'DELETE').length,
    2,
  );
});

void test('fails closed on commit refusal without claiming publication', async () => {
  const observed: ObservedRequest[] = [];
  const result = await publishSalesforceDefinition(
    configuration(),
    { formVersionId },
    acceptXForm,
    successfulFetch(observed, { commitStatus: 400 }),
  );
  assert.deepEqual(result, {
    ok: false,
    diagnostics: [
      { code: 'PUBLICATION_PUBLISHER_COMMIT', location: 'publisher' },
    ],
    requestCount: 7,
  });
  assert.equal(
    observed.filter(({ init }) => init.method === 'DELETE').length,
    0,
  );
});

void test('refuses a commit response that does not repeat the package digest', async () => {
  const observed: ObservedRequest[] = [];
  const fetcher = successfulFetch(observed);
  const result = await publishSalesforceDefinition(
    configuration(),
    { formVersionId },
    acceptXForm,
    async (input, init) => {
      if (requestUrl(input).endsWith('/v1/publications/commit'))
        return jsonResponse({
          schemaVersion: 1,
          alreadyCommitted: false,
          publicationDigest: '0'.repeat(64),
        });
      return await fetcher(input, init);
    },
  );
  assert.deepEqual(result, {
    ok: false,
    diagnostics: [
      { code: 'PUBLICATION_PUBLISHER_COMMIT', location: 'publisher' },
    ],
    requestCount: 7,
  });
});

void test('bounds token acquisition inside the shared publication deadline', async () => {
  const started = performance.now();
  const result = await publishSalesforceDefinition(
    configuration({
      getAccessToken: async () => await new Promise<never>(() => undefined),
      perRequestTimeoutMs: 30,
      overallTimeoutMs: 60,
    }),
    { formVersionId },
    acceptXForm,
    async () => {
      throw new Error('must not run');
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.requestCount, 0);
  assert.ok(performance.now() - started < 500);
});

void test('bounds the supplied validator inside the shared publication deadline', async () => {
  const observed: ObservedRequest[] = [];
  const started = performance.now();
  const result = await publishSalesforceDefinition(
    configuration({ perRequestTimeoutMs: 30, overallTimeoutMs: 60 }),
    { formVersionId },
    async () => await new Promise<never>(() => undefined),
    successfulFetch(observed),
  );
  assert.deepEqual(result, {
    ok: false,
    diagnostics: [
      { code: 'PUBLICATION_PUBLISHER_DEFINITION', location: 'publisher' },
    ],
    requestCount: 2,
  });
  assert.equal(
    observed.some(({ url }) => url.endsWith('/composite/sobjects')),
    false,
  );
  assert.ok(performance.now() - started < 500);
});
