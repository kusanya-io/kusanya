import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeSalesforceOrgId,
  type TenantConnection,
} from '../../src/tenant/connection-store.js';
import {
  createTenantSalesforceSession,
  type TenantConnectionSessionStore,
} from '../../src/tenant/salesforce-session.js';

const tenantId = '10000000-0000-4000-8000-000000000001';
const orgId = normalizeSalesforceOrgId('00D000000000001');
const userId = '005000000000001';
const client = Object.freeze({
  clientId: 'synthetic-client-id',
  clientSecret: 'synthetic-client-secret',
  timeoutMs: 1_000,
});

function connection(
  refreshToken = 'synthetic-refresh-token',
  credentialVersion = 4,
) {
  const value = {
    tenantId,
    salesforceOrgId: orgId,
    authorizationOrigin: 'https://login.salesforce.com',
    instanceOrigin: 'https://tenant.my.salesforce.com',
    namespacePrefix: 'ksny__',
    credentialVersion,
    needsEncryptionRotation: false,
  } as Record<string, unknown>;
  Object.defineProperty(value, 'getRefreshToken', {
    configurable: false,
    enumerable: false,
    value: () => refreshToken,
    writable: false,
  });
  return Object.freeze(value) as unknown as TenantConnection;
}

function response(
  overrides: Record<string, unknown> = {},
  status = 200,
): Response {
  return new Response(
    JSON.stringify({
      access_token: 'synthetic-access-token',
      instance_url: 'https://tenant.my.salesforce.com',
      id: `https://login.salesforce.com/id/${orgId}/${userId}`,
      token_type: 'Bearer',
      issued_at: '1',
      signature: 'synthetic-signature',
      ...overrides,
    }),
    { status, headers: { 'content-type': 'application/json; charset=UTF-8' } },
  );
}

function store(selected = connection()): TenantConnectionSessionStore {
  return {
    async withRefreshLock(_tenantId, operation) {
      const result = await operation(selected);
      if (result.rotatedRefreshToken !== undefined)
        throw new Error('unexpected rotation');
      return { value: result.value, connection: selected };
    },
  };
}

void test('selects one tenant and exchanges its refresh token through a bounded form POST', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const session = await createTenantSalesforceSession(
    store(),
    tenantId,
    client,
    async (input, init = {}) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      requests.push({ url, init });
      return response();
    },
  );
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0]?.url,
    'https://login.salesforce.com/services/oauth2/token',
  );
  const init = requests[0].init;
  assert.equal(init.method, 'POST');
  assert.equal(init.cache, 'no-store');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.redirect, 'manual');
  assert.equal(
    (init.headers as Record<string, string>)['content-type'],
    'application/x-www-form-urlencoded; charset=UTF-8',
  );
  assert.deepEqual(
    Object.fromEntries(new URLSearchParams(init.body as string)),
    {
      grant_type: 'refresh_token',
      client_id: 'synthetic-client-id',
      client_secret: 'synthetic-client-secret',
      refresh_token: 'synthetic-refresh-token',
    },
  );
  assert.equal(await session.getAccessToken(), 'synthetic-access-token');
  assert.equal(await session.getAccessToken(), 'synthetic-access-token');
  assert.equal(session.instanceOrigin, 'https://tenant.my.salesforce.com');
  assert.equal(session.namespacePrefix, 'ksny__');
  assert.equal(session.credentialVersion, 4);
  assert.equal(Object.keys(session).includes('getAccessToken'), false);
  assert.doesNotMatch(JSON.stringify(session), /token|secret/i);
  assert.ok(Object.isFrozen(session));
});

void test('persists a rotated refresh token conditionally before exposing access', async () => {
  const calls: unknown[][] = [];
  const selected = connection();
  const replacement = connection('rotated-refresh-token', 5);
  const rotatingStore: TenantConnectionSessionStore = {
    async withRefreshLock(selectedTenantId, operation) {
      const result = await operation(selected);
      calls.push([
        selectedTenantId,
        selected.salesforceOrgId,
        selected.credentialVersion,
        result.rotatedRefreshToken,
      ]);
      return { value: result.value, connection: replacement };
    },
  };
  const session = await createTenantSalesforceSession(
    rotatingStore,
    tenantId,
    client,
    async () => response({ refresh_token: 'rotated-refresh-token' }),
  );
  assert.deepEqual(calls, [[tenantId, orgId, 4, 'rotated-refresh-token']]);
  assert.equal(session.credentialVersion, 5);
  assert.equal(await session.getAccessToken(), 'synthetic-access-token');
});

void test('does not expose an access token when rotated-token persistence fails', async () => {
  const rotatingStore: TenantConnectionSessionStore = {
    async withRefreshLock(_tenantId, operation) {
      await operation(connection());
      throw new Error('private database detail');
    },
  };
  await assert.rejects(
    createTenantSalesforceSession(rotatingStore, tenantId, client, async () =>
      response({ refresh_token: 'rotated-refresh-token' }),
    ),
    { message: 'TENANT_SALESFORCE_SESSION_ROTATION' },
  );
});

void test('returns a fixed absence without making a token request', async () => {
  let requests = 0;
  const absent: TenantConnectionSessionStore = {
    async withRefreshLock() {
      return undefined;
    },
  };
  await assert.rejects(
    createTenantSalesforceSession(absent, tenantId, client, async () => {
      requests++;
      return response();
    }),
    { message: 'TENANT_SALESFORCE_SESSION_NOT_CONNECTED' },
  );
  assert.equal(requests, 0);
});

void test('binds the response to the selected org, instance and Bearer type', async () => {
  const normalized = await createTenantSalesforceSession(
    store(),
    tenantId,
    client,
    async () =>
      response({
        instance_url: 'https://tenant.my.salesforce.com/',
        token_format: 'jwt',
      }),
  );
  assert.equal(normalized.instanceOrigin, 'https://tenant.my.salesforce.com');
  const invalid = [
    { instance_url: 'https://other.my.salesforce.com' },
    {
      id: `https://login.salesforce.com/id/${normalizeSalesforceOrgId('00D000000000002')}/${userId}`,
    },
    { id: `https://example.com/id/${orgId}/${userId}` },
    { id: `https://login.salesforce.com/id/${orgId}/006000000000001` },
    { token_type: 'bearer' },
    { token_format: 'opaque' },
    { access_token: 'has a space' },
    { unexpected: true },
  ];
  for (const body of invalid)
    await assert.rejects(
      createTenantSalesforceSession(store(), tenantId, client, async () =>
        response(body),
      ),
      { message: 'TENANT_SALESFORCE_SESSION_REFRESH' },
    );
});

void test('refuses provider failures, redirects and oversized bodies without leaking values', async () => {
  const failures = [
    async () => response({ error: 'synthetic-refresh-token' }, 400),
    async () =>
      new Response('x', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': '65537',
        },
      }),
    async () =>
      new Response('not json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    async () => {
      throw new Error('synthetic-client-secret synthetic-refresh-token');
    },
  ];
  for (const implementation of failures) {
    const error = await createTenantSalesforceSession(
      store(),
      tenantId,
      client,
      implementation,
    ).catch((value: unknown) => value);
    assert.equal((error as Error).message, 'TENANT_SALESFORCE_SESSION_REFRESH');
    assert.doesNotMatch(
      `${(error as Error).message}\n${(error as Error).stack ?? ''}`,
      /synthetic-(?:client-secret|refresh-token)/,
    );
  }
});

void test('refuses hostile configuration and connection shapes without invoking accessors', async () => {
  let getters = 0;
  const hostileClient = Object.defineProperty({}, 'clientId', {
    enumerable: true,
    get() {
      getters++;
      return 'synthetic-client-id';
    },
  });
  await assert.rejects(
    createTenantSalesforceSession(store(), tenantId, hostileClient as never),
    { message: 'TENANT_SALESFORCE_SESSION_INPUT' },
  );
  assert.equal(getters, 0);
  await assert.rejects(
    createTenantSalesforceSession(store(), `${tenantId}x`, client),
    { message: 'TENANT_SALESFORCE_SESSION_INPUT' },
  );
  const proxy = new Proxy(connection(), {});
  await assert.rejects(
    createTenantSalesforceSession(store(proxy), tenantId, client),
    { message: 'TENANT_SALESFORCE_SESSION_REFRESH' },
  );
});

void test('enforces the refresh deadline', async () => {
  await assert.rejects(
    createTenantSalesforceSession(
      store(),
      tenantId,
      { ...client, timeoutMs: 10 },
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new Error('private timeout detail')),
            { once: true },
          );
        }),
    ),
    { message: 'TENANT_SALESFORCE_SESSION_REFRESH' },
  );
});
