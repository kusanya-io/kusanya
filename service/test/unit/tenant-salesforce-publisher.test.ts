import assert from 'node:assert/strict';
import { test } from 'node:test';
import { simpleForm } from '../fixtures/compiler.js';
import {
  normalizeSalesforceOrgId,
  type TenantConnection,
} from '../../src/tenant/connection-store.js';
import type { TenantConnectionSessionStore } from '../../src/tenant/salesforce-session.js';
import { publishTenantSalesforceDefinition } from '../../src/publication/tenant-salesforce-publisher.js';

const tenantId = '10000000-0000-4000-8000-000000000001';
const orgId = normalizeSalesforceOrgId('00D000000000001');
const formVersionId = 'a0B000000000001AAA';
const userId = '005000000000001';
const versionIds = ['068000000000001AAA', '068000000000002AAA'] as const;

const context = Object.freeze({
  actorId: 'oidc:synthetic-actor',
  tenantId,
  expectedSalesforceOrgId: orgId,
  authorizationOrigin: 'https://login.salesforce.com',
  namespacePrefix: 'ksny__',
  role: 'administrator' as const,
  csrfToken: 'a'.repeat(43),
});

const configuration = Object.freeze({
  clientId: 'synthetic-client',
  clientSecret: 'synthetic-secret',
  refreshTimeoutMs: 1_000,
  perRequestTimeoutMs: 1_000,
  overallTimeoutMs: 10_000,
});

function connection(overrides: Record<string, unknown> = {}): TenantConnection {
  const value = {
    tenantId,
    salesforceOrgId: orgId,
    authorizationOrigin: 'https://login.salesforce.com',
    instanceOrigin: 'https://tenant.my.salesforce.com',
    namespacePrefix: 'ksny__',
    credentialVersion: 1,
    needsEncryptionRotation: false,
    ...overrides,
  } as Record<string, unknown>;
  Object.defineProperty(value, 'getRefreshToken', {
    enumerable: false,
    value: () => 'synthetic-refresh-token',
  });
  return Object.freeze(value) as unknown as TenantConnection;
}

function store(selected?: TenantConnection): TenantConnectionSessionStore {
  return {
    async withRefreshLock(_selectedTenantId, operation) {
      if (selected === undefined) return undefined;
      const result = await operation(selected);
      return { value: result.value, connection: selected };
    },
  };
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=UTF-8' },
  });

function url(input: string | URL | Request): string {
  return typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}

void test('uses one bound tenant session as the sole credential path for publication', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  let uploaded: { VersionData: string }[] = [];
  const result = await publishTenantSalesforceDefinition(
    store(connection()),
    context,
    configuration,
    { formVersionId },
    async () => ({ ok: true }),
    async (input, init = {}) => {
      const requestUrl = url(input);
      requests.push({ url: requestUrl, init });
      if (requestUrl.endsWith('/services/oauth2/token'))
        return json({
          access_token: 'attempt-scoped-access-token',
          instance_url: 'https://tenant.my.salesforce.com',
          id: `https://login.salesforce.com/id/${orgId}/${userId}`,
          token_type: 'Bearer',
        });
      if (requestUrl.endsWith('/services/apexrest/v1/publications/definition'))
        return json({
          schemaVersion: 1,
          definition: simpleForm(),
          mappingBundle: {
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
          },
        });
      if (requestUrl.endsWith('/sobjects/Visit__c/describe'))
        return json({
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
      if (
        requestUrl.endsWith('/composite/sobjects') &&
        init.method === 'POST'
      ) {
        uploaded = (
          JSON.parse(init.body as string) as {
            records: { VersionData: string }[];
          }
        ).records;
        return json(
          versionIds.map((id) => ({ id, success: true, errors: [] })),
        );
      }
      if (requestUrl.includes('/composite/sobjects/ContentVersion?'))
        return json(
          versionIds.map((id, index) => ({
            attributes: { type: 'ContentVersion' },
            Id: id,
            ContentDocumentId: `06900000000000${index + 1}AAA`,
            IsLatest: true,
            FileExtension: index === 0 ? 'xml' : 'xlsx',
          })),
        );
      const versionIndex = versionIds.findIndex((id) =>
        requestUrl.endsWith(`/${id}/VersionData`),
      );
      if (versionIndex >= 0)
        return new Response(
          Buffer.from(uploaded[versionIndex]!.VersionData, 'base64'),
          {
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
          },
        );
      if (requestUrl.endsWith('/services/apexrest/v1/publications/commit')) {
        const body = JSON.parse(init.body as string) as {
          publicationDigest: string;
        };
        return json({
          schemaVersion: 1,
          alreadyCommitted: false,
          publicationDigest: body.publicationDigest,
        });
      }
      throw new Error('unexpected request');
    },
  );
  assert.equal(result.ok, true);
  assert.equal(
    requests.filter(({ url: value }) =>
      value.endsWith('/services/oauth2/token'),
    ).length,
    1,
  );
  const published = requests.slice(1);
  assert.equal(published.length, 7);
  for (const request of published)
    assert.equal(
      (request.init.headers as Record<string, string>).authorization,
      'Bearer attempt-scoped-access-token',
    );
});

void test('refuses absent and mismatched tenant bindings before Salesforce publication', async () => {
  const cases: [TenantConnection | undefined, string][] = [
    [undefined, 'TENANT_PUBLICATION_NOT_CONNECTED'],
    [connection({ namespacePrefix: '' }), 'TENANT_PUBLICATION_BINDING'],
    [
      connection({ authorizationOrigin: 'https://test.salesforce.com' }),
      'TENANT_PUBLICATION_BINDING',
    ],
    [
      connection({
        salesforceOrgId: normalizeSalesforceOrgId('00D000000000002'),
      }),
      'TENANT_PUBLICATION_BINDING',
    ],
  ];
  for (const [selected, code] of cases) {
    let requests = 0;
    const result = await publishTenantSalesforceDefinition(
      store(selected),
      context,
      configuration,
      { formVersionId },
      async () => ({ ok: true }),
      async () => {
        requests++;
        throw new Error('must not run');
      },
    );
    assert.deepEqual(result, {
      ok: false,
      diagnostics: [{ code, location: 'publisher' }],
      requestCount: 0,
    });
    assert.equal(requests, 0);
  }
});

void test('refuses hostile composition inputs without credential or network access', async () => {
  let getterCalls = 0;
  const hostile = Object.defineProperty({}, 'clientId', {
    enumerable: true,
    get() {
      getterCalls++;
      return 'synthetic-client';
    },
  });
  let storeCalls = 0;
  let requests = 0;
  const guardedStore: TenantConnectionSessionStore = {
    async withRefreshLock() {
      storeCalls++;
      return undefined;
    },
  };
  const invalid = [
    hostile,
    { ...configuration, getAccessToken: async () => 'forbidden' },
    { ...configuration, clientSecret: 'contains a space' },
    { ...configuration, refreshTimeoutMs: 0 },
    { ...configuration, perRequestTimeoutMs: 30_001 },
    { ...configuration, overallTimeoutMs: 999 },
  ];
  for (const value of invalid) {
    const result = await publishTenantSalesforceDefinition(
      guardedStore,
      context,
      value as never,
      { formVersionId },
      async () => ({ ok: true }),
      async () => {
        requests++;
        throw new Error('must not run');
      },
    );
    assert.deepEqual(result, {
      ok: false,
      diagnostics: [
        { code: 'TENANT_PUBLICATION_INPUT', location: 'publisher' },
      ],
      requestCount: 0,
    });
  }
  assert.equal(getterCalls, 0);
  assert.equal(storeCalls, 0);
  assert.equal(requests, 0);
});

void test('refuses malformed publication requests before selecting or refreshing a connection', async () => {
  const invalid = [
    null,
    {},
    { formVersionId: 'not-an-id' },
    { formVersionId, extra: true },
    new Proxy({ formVersionId }, {}),
  ];
  for (const request of invalid) {
    let storeCalls = 0;
    let requests = 0;
    const guardedStore: TenantConnectionSessionStore = {
      async withRefreshLock() {
        storeCalls++;
        return undefined;
      },
    };
    const result = await publishTenantSalesforceDefinition(
      guardedStore,
      context,
      configuration,
      request as never,
      async () => ({ ok: true }),
      async () => {
        requests++;
        throw new Error('must not run');
      },
    );
    assert.deepEqual(result, {
      ok: false,
      diagnostics: [
        { code: 'TENANT_PUBLICATION_INPUT', location: 'publisher' },
      ],
      requestCount: 0,
    });
    assert.equal(storeCalls, 0);
    assert.equal(requests, 0);
  }
});

void test('refuses forged administrator contexts before tenant selection', async () => {
  const invalid = [
    {
      ...context,
      tenantId: '20000000-0000-4000-8000-000000000002',
      extra: true,
    },
    new Proxy({ ...context }, {}),
    { ...context, expectedSalesforceOrgId: '00D000000000002BAD' },
  ];
  for (const candidate of invalid) {
    let storeCalls = 0;
    const result = await publishTenantSalesforceDefinition(
      {
        async withRefreshLock() {
          storeCalls++;
          return undefined;
        },
      },
      candidate,
      configuration,
      { formVersionId },
      async () => ({ ok: true }),
      async () => {
        throw new Error('must not run');
      },
    );
    assert.deepEqual(result, {
      ok: false,
      diagnostics: [
        { code: 'TENANT_PUBLICATION_INPUT', location: 'publisher' },
      ],
      requestCount: 0,
    });
    assert.equal(storeCalls, 0);
  }
});

void test('charges refresh exchange time to the shared publication deadline', async () => {
  const started = performance.now();
  const result = await publishTenantSalesforceDefinition(
    store(connection()),
    context,
    {
      ...configuration,
      refreshTimeoutMs: 25,
      perRequestTimeoutMs: 25,
      overallTimeoutMs: 40,
    },
    { formVersionId },
    async () => ({ ok: true }),
    async (input) => {
      if (url(input).endsWith('/services/oauth2/token'))
        return await new Promise<Response>(() => undefined);
      throw new Error('publication must not start');
    },
  );
  assert.deepEqual(result, {
    ok: false,
    diagnostics: [
      { code: 'TENANT_PUBLICATION_SESSION', location: 'publisher' },
    ],
    requestCount: 0,
  });
  assert.ok(performance.now() - started < 500);
});
