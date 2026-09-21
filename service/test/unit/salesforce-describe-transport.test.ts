import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import {
  createSalesforceDescribeTransport,
  salesforceDescribeApiVersion,
  type SalesforceDescribeTransportConfiguration,
} from '../../src/publication/salesforce-describe-transport.js';
import { loadSalesforceTargetSchema } from '../../src/publication/salesforce-describe.js';

const configuration = (
  extra: Partial<SalesforceDescribeTransportConfiguration> = {},
): SalesforceDescribeTransportConfiguration => ({
  instanceOrigin: 'https://example.my.salesforce.com',
  getAccessToken: async () => 'PRIVATE_TOKEN!value',
  perRequestTimeoutMs: 100,
  overallTimeoutMs: 500,
  ...extra,
});

function rawObject(name: string): Record<string, unknown> {
  return {
    name,
    queryable: true,
    createable: true,
    updateable: true,
    fields: [],
    recordTypeInfos: [],
  };
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=UTF-8' },
    ...init,
  });
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

void test('uses the pinned REST path and a fresh bearer token without caching', async () => {
  assert.equal(salesforceDescribeApiVersion, '64.0');
  const calls: Array<{ input: string; init: RequestInit | undefined }> = [];
  let tokenCalls = 0;
  const describe = createSalesforceDescribeTransport(
    configuration({
      getAccessToken: async () => `token-${++tokenCalls}`,
    }),
    async (input, init) => {
      calls.push({ input: requestUrl(input), init });
      const name = calls.length === 1 ? 'Account' : 'Visit__c';
      return jsonResponse(rawObject(name));
    },
  );

  assert.deepEqual(await describe('Account'), rawObject('Account'));
  assert.deepEqual(await describe('Visit__c'), rawObject('Visit__c'));
  assert.equal(tokenCalls, 2);
  assert.deepEqual(
    calls.map(({ input }) => input),
    [
      'https://example.my.salesforce.com/services/data/v64.0/sobjects/Account/describe',
      'https://example.my.salesforce.com/services/data/v64.0/sobjects/Visit__c/describe',
    ],
  );
  assert.equal(calls[0]?.init?.method, 'GET');
  assert.equal(calls[0]?.init?.cache, 'no-store');
  assert.equal(calls[0]?.init?.credentials, 'omit');
  assert.equal(calls[0]?.init?.redirect, 'manual');
  assert.equal(
    (calls[0]?.init?.headers as Record<string, string>).authorization,
    'Bearer token-1',
  );
  assert.equal(
    (calls[1]?.init?.headers as Record<string, string>).authorization,
    'Bearer token-2',
  );
});

void test('hands real JSON to the strict normalizer with exact request counts', async () => {
  const requested: string[] = [];
  const describe = createSalesforceDescribeTransport(
    configuration(),
    async (input) => {
      const match = /\/sobjects\/([^/]+)\/describe$/u.exec(requestUrl(input));
      assert.ok(match);
      const name = decodeURIComponent(match[1]!);
      requested.push(name);
      return jsonResponse(rawObject(name));
    },
  );
  const result = await loadSalesforceTargetSchema(
    ['Visit__c', 'account', 'VISIT__C'],
    describe,
  );
  assert.equal(result.ok, true);
  assert.equal(result.requestCount, 2);
  assert.deepEqual(requested, ['account', 'Visit__c']);
});

void test('refuses malformed configuration without invoking accessors', () => {
  let getterCalls = 0;
  const accessor = configuration() as unknown as Record<string, unknown>;
  Object.defineProperty(accessor, 'instanceOrigin', {
    enumerable: true,
    get() {
      getterCalls++;
      return 'https://example.my.salesforce.com';
    },
  });
  const invalid = [
    null,
    new Proxy(configuration(), {}),
    accessor,
    configuration({ instanceOrigin: 'http://example.my.salesforce.com' }),
    configuration({ instanceOrigin: 'https://example.invalid' }),
    configuration({ instanceOrigin: 'https://example.my.salesforce.com/' }),
    configuration({ perRequestTimeoutMs: 0 }),
    configuration({ perRequestTimeoutMs: 30_001 }),
    configuration({ overallTimeoutMs: 120_001 }),
    configuration({ perRequestTimeoutMs: 100, overallTimeoutMs: 99 }),
    { ...configuration(), unexpected: true },
  ];
  for (const value of invalid)
    assert.throws(() =>
      createSalesforceDescribeTransport(
        value as SalesforceDescribeTransportConfiguration,
      ),
    );
  assert.equal(getterCalls, 0);
});

void test('refuses hostile object names before acquiring a token or making a request', async () => {
  let tokenCalls = 0;
  let fetchCalls = 0;
  const describe = createSalesforceDescribeTransport(
    configuration({
      getAccessToken: async () => {
        tokenCalls++;
        return 'token';
      },
    }),
    async () => {
      fetchCalls++;
      return jsonResponse(rawObject('unused'));
    },
  );
  for (const name of ['', '../Account', 'Account?secret=true', ' Account'])
    await assert.rejects(describe(name));
  assert.equal(tokenCalls, 0);
  assert.equal(fetchCalls, 0);
});

void test('fails closed on status, redirect, media type, JSON and UTF-8 failures', async () => {
  const responses = [
    new Response('PRIVATE_PROVIDER_MESSAGE', {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }),
    new Response('', {
      status: 302,
      headers: { location: 'https://PRIVATE_SENTINEL.invalid' },
    }),
    new Response('{}', {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }),
    new Response('{}', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }),
    new Response('{PRIVATE_INVALID_JSON', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    new Response(Uint8Array.from([0xc3, 0x28]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ];
  for (const response of responses) {
    const describe = createSalesforceDescribeTransport(
      configuration(),
      async () => response,
    );
    await assert.rejects(describe('Account'), (error: Error) => {
      assert.equal(error.message, 'SALESFORCE_DESCRIBE_TRANSPORT');
      assert.doesNotMatch(error.message, /PRIVATE/iu);
      return true;
    });
  }
});

void test('enforces declared and streamed response byte limits', async () => {
  const exactJson = `"${'a'.repeat(8 * 1024 * 1024 - 2)}"`;
  const exact = createSalesforceDescribeTransport(
    configuration({ perRequestTimeoutMs: 500, overallTimeoutMs: 1000 }),
    async () =>
      new Response(exactJson, {
        headers: { 'content-type': 'application/json' },
      }),
  );
  assert.equal(await exact('Account'), exactJson.slice(1, -1));

  const declared = createSalesforceDescribeTransport(
    configuration(),
    async () =>
      new Response('{}', {
        headers: {
          'content-type': 'application/json',
          'content-length': String(8 * 1024 * 1024 + 1),
        },
      }),
  );
  await assert.rejects(declared('Account'));

  const streamed = createSalesforceDescribeTransport(
    configuration({ perRequestTimeoutMs: 500, overallTimeoutMs: 1000 }),
    async () =>
      new Response(new Uint8Array(8 * 1024 * 1024 + 1), {
        headers: { 'content-type': 'application/json' },
      }),
  );
  await assert.rejects(streamed('Account'));
});

void test('bounds token acquisition, fetch and body reading', async () => {
  const hangingToken = createSalesforceDescribeTransport(
    configuration({
      getAccessToken: async () => await new Promise<never>(() => undefined),
      perRequestTimeoutMs: 15,
      overallTimeoutMs: 30,
    }),
  );
  await assert.rejects(hangingToken('Account'));

  const hangingFetch = createSalesforceDescribeTransport(
    configuration({ perRequestTimeoutMs: 15, overallTimeoutMs: 30 }),
    async () => await new Promise<Response>(() => undefined),
  );
  await assert.rejects(hangingFetch('Account'));

  let bodyCancelled = false;
  const hangingBody = createSalesforceDescribeTransport(
    configuration({ perRequestTimeoutMs: 15, overallTimeoutMs: 30 }),
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            bodyCancelled = true;
          },
        }),
        {
          headers: { 'content-type': 'application/json' },
        },
      ),
  );
  await assert.rejects(hangingBody('Account'));
  assert.equal(bodyCancelled, true);
});

void test('shares one overall deadline across sequential Describe calls', async () => {
  let tokenCalls = 0;
  const describe = createSalesforceDescribeTransport(
    configuration({
      getAccessToken: async () => {
        tokenCalls++;
        return 'token';
      },
      perRequestTimeoutMs: 20,
      overallTimeoutMs: 25,
    }),
    async () => jsonResponse(rawObject('Account')),
  );
  await describe('Account');
  await delay(35);
  await assert.rejects(describe('Contact'));
  assert.equal(tokenCalls, 1);
});

void test('does not disclose token-provider or transport failures', async () => {
  const secrets = [
    createSalesforceDescribeTransport(
      configuration({
        getAccessToken: async () => {
          throw new Error('PRIVATE_TOKEN_PROVIDER');
        },
      }),
    ),
    createSalesforceDescribeTransport(configuration(), async () => {
      throw new Error('PRIVATE_FETCH_FAILURE');
    }),
    createSalesforceDescribeTransport(
      configuration({ getAccessToken: async () => 'bad token' }),
    ),
  ];
  for (const describe of secrets) {
    const result = await loadSalesforceTargetSchema(['Account'], describe);
    assert.deepEqual(result, {
      ok: false,
      diagnostics: [
        { code: 'PUBLISH_DESCRIBE_REQUEST', location: 'objects[0]' },
      ],
      requestCount: 1,
    });
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|bad token/iu);
  }
});
