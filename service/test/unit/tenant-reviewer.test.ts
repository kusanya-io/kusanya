import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mixedRepeatForm } from '../fixtures/compiler.js';
import {
  normalizeSalesforceOrgId,
  type TenantConnection,
} from '../../src/tenant/connection-store.js';
import type { TenantConnectionSessionStore } from '../../src/tenant/salesforce-session.js';
import { reviewTenantSalesforceDefinition } from '../../src/print/tenant-reviewer.js';

const tenantId = '10000000-0000-4000-8000-000000000001';
const orgId = normalizeSalesforceOrgId('00D000000000001');
const formVersionId = 'a0B000000000001AAA';
const context = Object.freeze({
  actorId: 'oidc:synthetic-reviewer',
  tenantId,
  expectedSalesforceOrgId: orgId,
  authorizationOrigin: 'https://login.salesforce.com',
  namespacePrefix: 'ksny__',
  role: 'reviewer' as const,
  csrfToken: 'c'.repeat(43),
});
const configuration = Object.freeze({
  clientId: 'synthetic-client',
  clientSecret: 'synthetic-secret',
  refreshTimeoutMs: 500,
  perRequestTimeoutMs: 500,
  overallTimeoutMs: 2_000,
});
const mappingBundle = Object.freeze({ schemaVersion: 1, mappings: [] });

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
    async withRefreshLock(selectedTenantId, operation) {
      assert.equal(selectedTenantId, tenantId);
      if (selected === undefined) return undefined;
      const result = await operation(selected);
      return { value: result.value, connection: selected };
    },
  };
}

const json = (value: unknown, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=UTF-8', ...headers },
  });
const requestUrl = (input: string | URL | Request): string =>
  typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;

void test('renders one tenant-bound snapshot without a publication mutation', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const result = await reviewTenantSalesforceDefinition(
    store(connection()),
    context,
    configuration,
    { formVersionId },
    async (input, init = {}) => {
      const url = requestUrl(input);
      requests.push({ url, init });
      if (url.endsWith('/services/oauth2/token'))
        return json({
          access_token: 'attempt-scoped-access-token',
          instance_url: 'https://tenant.my.salesforce.com',
          id: `https://login.salesforce.com/id/${orgId}/005000000000001`,
          token_type: 'Bearer',
        });
      assert.equal(
        url,
        'https://tenant.my.salesforce.com/services/apexrest/ksny/v1/publications/definition',
      );
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'manual');
      assert.equal(init.credentials, 'omit');
      if (typeof init.body !== 'string') assert.fail('expected string body');
      assert.deepEqual(JSON.parse(init.body), {
        schemaVersion: 1,
        formVersionId,
      });
      assert.equal(
        (init.headers as Record<string, string>).authorization,
        'Bearer attempt-scoped-access-token',
      );
      return json({
        schemaVersion: 1,
        definition: mixedRepeatForm(),
        mappingBundle,
      });
    },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.requestCount, 1);
  assert.match(result.html, /AUTHOR_ONLY_SENTINEL_4197/);
  assert.doesNotMatch(
    result.html,
    /attempt-scoped-access-token|synthetic-refresh-token/,
  );
  assert.equal(requests.length, 2);
});

void test('keeps empty-prefix reviewer delivery compatibility', async () => {
  let definitionRequests = 0;
  const result = await reviewTenantSalesforceDefinition(
    store(connection({ namespacePrefix: '' })),
    { ...context, namespacePrefix: '' },
    configuration,
    { formVersionId },
    async (input) => {
      const selected = requestUrl(input);
      if (selected.endsWith('/services/oauth2/token'))
        return json({
          access_token: 'attempt-scoped-access-token',
          instance_url: 'https://tenant.my.salesforce.com',
          id: `https://login.salesforce.com/id/${orgId}/005000000000001`,
          token_type: 'Bearer',
        });
      definitionRequests++;
      assert.equal(
        selected,
        'https://tenant.my.salesforce.com/services/apexrest/v1/publications/definition',
      );
      return json({
        schemaVersion: 1,
        definition: mixedRepeatForm(),
        mappingBundle,
      });
    },
  );
  assert.equal(result.ok, true);
  assert.equal(definitionRequests, 1);
});

void test('refuses absent and mismatched bindings before retrieving a definition', async () => {
  const cases: Array<[TenantConnection | undefined, string]> = [
    [undefined, 'TENANT_REVIEW_NOT_CONNECTED'],
    [connection({ namespacePrefix: '' }), 'TENANT_REVIEW_BINDING'],
    [
      connection({ authorizationOrigin: 'https://test.salesforce.com' }),
      'TENANT_REVIEW_BINDING',
    ],
    [
      connection({
        salesforceOrgId: normalizeSalesforceOrgId('00D000000000002'),
      }),
      'TENANT_REVIEW_BINDING',
    ],
  ];
  for (const [selected, code] of cases) {
    let calls = 0;
    const result = await reviewTenantSalesforceDefinition(
      store(selected),
      context,
      configuration,
      { formVersionId },
      async () => {
        calls++;
        throw new Error('must not run');
      },
    );
    assert.deepEqual(result, { ok: false, code, requestCount: 0 });
    assert.equal(calls, 0);
  }
});

void test('strictly refuses hostile composition inputs before store or network access', async () => {
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, 'formVersionId', {
    enumerable: true,
    get() {
      getterCalls++;
      return formVersionId;
    },
  });
  const invalid: unknown[] = [
    accessor,
    { formVersionId, extra: true },
    { formVersionId: 'bad' },
    new Proxy({ formVersionId }, {}),
  ];
  for (const request of invalid) {
    let storeCalls = 0;
    let fetchCalls = 0;
    const result = await reviewTenantSalesforceDefinition(
      {
        async withRefreshLock() {
          storeCalls++;
          return undefined;
        },
      },
      context,
      configuration,
      request as { formVersionId: string },
      async () => {
        fetchCalls++;
        throw new Error('must not run');
      },
    );
    assert.deepEqual(result, {
      ok: false,
      code: 'TENANT_REVIEW_INPUT',
      requestCount: 0,
    });
    assert.equal(storeCalls, 0);
    assert.equal(fetchCalls, 0);
  }
  assert.equal(getterCalls, 0);
});

void test('refuses malformed, redirected, oversized and render-invalid snapshots with fixed codes', async () => {
  const cases: Array<[Response, string]> = [
    [
      new Response('{', { headers: { 'content-type': 'application/json' } }),
      'TENANT_REVIEW_DEFINITION',
    ],
    [
      json({ schemaVersion: 2, definition: {}, mappingBundle: {} }),
      'TENANT_REVIEW_DEFINITION',
    ],
    [
      json({
        schemaVersion: 1,
        definition: {},
        mappingBundle: {},
        extra: true,
      }),
      'TENANT_REVIEW_DEFINITION',
    ],
    [
      json({}, 200, { 'content-length': '5000001' }),
      'TENANT_REVIEW_DEFINITION',
    ],
  ];
  for (const [definitionResponse, code] of cases) {
    let index = 0;
    const result = await reviewTenantSalesforceDefinition(
      store(connection()),
      context,
      configuration,
      { formVersionId },
      async () =>
        index++ === 0
          ? json({
              access_token: 'token',
              instance_url: 'https://tenant.my.salesforce.com',
              id: `https://login.salesforce.com/id/${orgId}/005000000000001`,
              token_type: 'Bearer',
            })
          : definitionResponse,
    );
    assert.deepEqual(result, { ok: false, code, requestCount: 1 });
  }
  let index = 0;
  const invalidRender = await reviewTenantSalesforceDefinition(
    store(connection()),
    context,
    configuration,
    { formVersionId },
    async () =>
      index++ === 0
        ? json({
            access_token: 'token',
            instance_url: 'https://tenant.my.salesforce.com',
            id: `https://login.salesforce.com/id/${orgId}/005000000000001`,
            token_type: 'Bearer',
          })
        : json({ schemaVersion: 1, definition: {}, mappingBundle: {} }),
    () =>
      ({
        ok: true,
        html: '<p>wrong audience</p>',
        audience: 'reviewer-only',
        validation: 'structural-only',
        warnings: [],
        extra: true,
      }) as never,
  );
  assert.deepEqual(invalidRender, {
    ok: false,
    code: 'TENANT_REVIEW_RENDER',
    requestCount: 1,
  });
});

void test('deadline does not depend on a definition transport honouring abort', async () => {
  let index = 0;
  const started = performance.now();
  const result = await reviewTenantSalesforceDefinition(
    store(connection()),
    context,
    { ...configuration, perRequestTimeoutMs: 40, overallTimeoutMs: 100 },
    { formVersionId },
    async () => {
      if (index++ === 0)
        return json({
          access_token: 'token',
          instance_url: 'https://tenant.my.salesforce.com',
          id: `https://login.salesforce.com/id/${orgId}/005000000000001`,
          token_type: 'Bearer',
        });
      return new Promise<Response>(() => undefined);
    },
  );
  assert.deepEqual(result, {
    ok: false,
    code: 'TENANT_REVIEW_DEFINITION',
    requestCount: 1,
  });
  assert.ok(performance.now() - started < 250);
});
