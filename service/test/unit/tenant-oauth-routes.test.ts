import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import type {
  TenantAuthorizationAuditInput,
  TenantConnectionStore,
} from '../../src/tenant/connection-store.js';
import {
  TenantOAuthTransactionStore,
  type TenantOAuthConfiguration,
} from '../../src/tenant/oauth-authorization.js';
import {
  registerTenantOAuthRoutes,
  tenantOAuthRoutePaths,
  type TenantOAuthRouteDependencies,
} from '../../src/tenant/oauth-routes.js';

const tenantId = '10000000-0000-4000-8000-000000000001';
const forgedTenantId = '20000000-0000-4000-8000-000000000002';
const orgId = '00D000000000001EAA';
const forgedOrgId = '00D000000000002EAA';
const userId = '005000000000001';
const forgedUserId = '005000000000002';
const csrfToken = 'c'.repeat(43);
const administratorSession = 's'.repeat(43);
const stateSecret = Buffer.alloc(32, 51);
const oauthConfiguration: TenantOAuthConfiguration = Object.freeze({
  clientId: 'synthetic-client-id',
  clientSecret: 'synthetic-client-secret',
  redirectUri: 'https://service.example/api/admin/salesforce/callback',
  stateSecret: stateSecret.toString('base64'),
  timeoutMs: 1_000,
  transactionTtlSeconds: 300,
});
const config = readConfig({
  DATABASE_URL: 'postgresql://kusanya@localhost:5432/kusanya',
});

interface StoredTransaction {
  state_digest: unknown;
  tenant_id: unknown;
  expected_salesforce_org_id: unknown;
  authorization_origin: unknown;
  namespace_prefix: unknown;
}

function memoryStore() {
  const rows = new Map<string, StoredTransaction>();
  const observed: { text: string; values: unknown[] }[] = [];
  const store = new TenantOAuthTransactionStore({
    async query<Row>(text: string, values: unknown[] = []) {
      observed.push({ text, values });
      if (/^\s*INSERT/.test(text)) {
        for (const [digest, row] of rows)
          if (row.tenant_id === values[1]) rows.delete(digest);
        rows.set(String(values[0]), {
          state_digest: values[0],
          tenant_id: values[1],
          expected_salesforce_org_id: values[2],
          authorization_origin: values[3],
          namespace_prefix: values[4],
        });
        return { rowCount: 1, rows: [] };
      }
      if (/DELETE FROM tenant_oauth_transactions/.test(text)) {
        const digest = String(values[0]);
        const row = rows.get(digest);
        if (row === undefined) return { rowCount: 0, rows: [] };
        rows.delete(digest);
        return { rowCount: 1, rows: [row as Row] };
      }
      throw new Error('unexpected query');
    },
  });
  return { store, rows, observed };
}

function signedResponse(): Response {
  const identity = `https://login.salesforce.com/id/${orgId}/${userId}`;
  const issuedAt = '1790000000000';
  return new Response(
    JSON.stringify({
      access_token: 'synthetic-access-token',
      refresh_token: 'synthetic-refresh-token',
      signature: createHmac('sha256', oauthConfiguration.clientSecret)
        .update(identity + issuedAt)
        .digest('base64'),
      scope: 'api refresh_token',
      instance_url: 'https://tenant.my.salesforce.com',
      id: identity,
      token_type: 'Bearer',
      issued_at: issuedAt,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function connectionStore(
  onSave: (input: TenantAuthorizationAuditInput) => void,
) {
  return {
    async saveAuthorization(input: TenantAuthorizationAuditInput) {
      onSave(input);
      return Object.freeze({
        tenantId,
        salesforceOrgId: orgId,
        authorizationOrigin: 'https://login.salesforce.com',
        instanceOrigin: 'https://tenant.my.salesforce.com',
        namespacePrefix: 'ksny__',
        credentialVersion: 1,
        needsEncryptionRotation: false,
        getRefreshToken: () => 'synthetic-refresh-token',
      });
    },
  } satisfies Pick<TenantConnectionStore, 'saveAuthorization'>;
}

function createRouteApp(
  overrides: Partial<TenantOAuthRouteDependencies> = {},
  onSave: (input: TenantAuthorizationAuditInput) => void = () => {},
) {
  const memory = memoryStore();
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  const dependencies: TenantOAuthRouteDependencies = {
    authenticateAdministrator: async () => ({
      actorId: 'administrator:synthetic',
      tenantId,
      expectedSalesforceOrgId: orgId,
      authorizationOrigin: 'https://login.salesforce.com',
      namespacePrefix: 'ksny__',
      role: 'administrator',
      csrfToken,
    }),
    transactionStore: memory.store,
    connectionStore: connectionStore(onSave),
    oauthConfiguration,
    externalOrigin: 'https://service.example',
    fetchImplementation: async () => signedResponse(),
    ...overrides,
  };
  registerTenantOAuthRoutes(app, dependencies);
  return { app, memory };
}

function startHeaders(extra: Record<string, string> = {}) {
  return {
    cookie: '__Host-kusanya_admin_session=' + administratorSession,
    origin: 'https://service.example',
    'x-csrf-token': csrfToken,
    ...extra,
  };
}

function callbackCookie(
  bindingCookieValue: string,
  session = administratorSession,
) {
  return `${bindingCookieValue}; __Host-kusanya_admin_session=${session}`;
}

void test('starts from only the verified session binding and ignores forged tenant headers', async (context) => {
  const sessions: string[] = [];
  const { app, memory } = createRouteApp({
    authenticateAdministrator: async (session) => {
      sessions.push(session);
      return {
        actorId: 'administrator:synthetic',
        tenantId,
        expectedSalesforceOrgId: orgId,
        authorizationOrigin: 'https://login.salesforce.com',
        namespacePrefix: 'ksny__',
        role: 'administrator',
        csrfToken,
      };
    },
  });
  context.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: tenantOAuthRoutePaths.start,
    headers: startHeaders({
      'x-tenant-id': forgedTenantId,
      'x-salesforce-org-id': forgedOrgId,
      'x-salesforce-user-id': forgedUserId,
      'x-administrator-actor': 'administrator:forged',
    }),
  });
  assert.equal(response.statusCode, 303);
  assert.deepEqual(sessions, [administratorSession]);
  assert.equal(memory.rows.size, 1);
  const row = [...memory.rows.values()][0]!;
  assert.equal(row.tenant_id, tenantId);
  assert.equal(row.expected_salesforce_org_id, orgId);
  assert.doesNotMatch(JSON.stringify(row), new RegExp(forgedTenantId));
  assert.doesNotMatch(JSON.stringify(row), new RegExp(forgedOrgId));
  const location = response.headers.location;
  assert.equal(typeof location, 'string');
  const authorization = new URL(location!);
  assert.equal(authorization.origin, 'https://login.salesforce.com');
  assert.match(
    String(response.headers['set-cookie']),
    /Secure; HttpOnly; SameSite=Lax/,
  );
});

void test('requires a verified session, exact same-origin CSRF and an empty start request', async (context) => {
  let authentications = 0;
  const { app, memory } = createRouteApp({
    authenticateAdministrator: async () => {
      authentications++;
      return {
        actorId: 'administrator:synthetic',
        tenantId,
        expectedSalesforceOrgId: orgId,
        authorizationOrigin: 'https://login.salesforce.com',
        namespacePrefix: 'ksny__',
        role: 'administrator',
        csrfToken,
      };
    },
  });
  context.after(() => app.close());
  const cases = [
    { headers: {}, expected: 401 },
    {
      headers: startHeaders({ origin: 'https://evil.example' }),
      expected: 403,
    },
    {
      headers: startHeaders({ 'x-csrf-token': 'x'.repeat(43) }),
      expected: 403,
    },
  ];
  for (const item of cases) {
    const response = await app.inject({
      method: 'POST',
      url: tenantOAuthRoutePaths.start,
      headers: item.headers,
    });
    assert.equal(response.statusCode, item.expected);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  const query = await app.inject({
    method: 'POST',
    url: `${tenantOAuthRoutePaths.start}?tenant=${forgedTenantId}`,
    headers: startHeaders(),
  });
  assert.equal(query.statusCode, 400);
  const body = await app.inject({
    method: 'POST',
    url: tenantOAuthRoutePaths.start,
    headers: {
      ...startHeaders(),
      'content-type': 'application/json',
    },
    payload: JSON.stringify({ tenantId: forgedTenantId, orgId: forgedOrgId }),
  });
  assert.equal(body.statusCode, 400);
  assert.equal(memory.rows.size, 0);
  assert.equal(authentications, 2);
});

void test('requires full administrator authority at both OAuth boundaries', async (context) => {
  let role: 'administrator' | 'publisher' | 'reviewer' = 'administrator';
  let fetches = 0;
  const { app, memory } = createRouteApp({
    authenticateAdministrator: async () => ({
      actorId: 'administrator:synthetic',
      tenantId,
      expectedSalesforceOrgId: orgId,
      authorizationOrigin: 'https://login.salesforce.com',
      namespacePrefix: 'ksny__',
      role,
      csrfToken,
    }),
    fetchImplementation: async () => {
      fetches++;
      return signedResponse();
    },
  });
  context.after(() => app.close());

  role = 'publisher';
  const deniedStart = await app.inject({
    method: 'POST',
    url: tenantOAuthRoutePaths.start,
    headers: startHeaders(),
  });
  assert.equal(deniedStart.statusCode, 403);
  assert.deepEqual(deniedStart.json(), { error: 'Request rejected' });
  assert.equal(memory.rows.size, 0);

  role = 'administrator';
  const start = await app.inject({
    method: 'POST',
    url: tenantOAuthRoutePaths.start,
    headers: startHeaders(),
  });
  const state = new URL(start.headers.location!).searchParams.get('state')!;
  const binding = String(start.headers['set-cookie']).split(';', 1)[0]!;
  assert.equal(memory.rows.size, 1);

  role = 'reviewer';
  const deniedCallback = await app.inject({
    method: 'GET',
    url: `${tenantOAuthRoutePaths.callback}?state=${state}&code=synthetic-code`,
    headers: { cookie: callbackCookie(binding) },
  });
  assert.equal(deniedCallback.statusCode, 403);
  assert.deepEqual(deniedCallback.json(), { error: 'Request rejected' });
  assert.equal(fetches, 0);
  assert.equal(memory.rows.size, 1);
});

void test('binds the callback to the initiating browser and stores no callback material in the response', async (context) => {
  const saved: TenantAuthorizationAuditInput[] = [];
  const { app } = createRouteApp({}, (input) => saved.push(input));
  context.after(() => app.close());
  const start = await app.inject({
    method: 'POST',
    url: tenantOAuthRoutePaths.start,
    headers: startHeaders(),
  });
  const state = new URL(start.headers.location!).searchParams.get('state')!;
  const cookie = String(start.headers['set-cookie']).split(';', 1)[0]!;
  const wrongBrowser = await app.inject({
    method: 'GET',
    url: `${tenantOAuthRoutePaths.callback}?state=${state}&code=synthetic-code`,
    headers: {
      cookie: callbackCookie(`__Host-kusanya_oauth_binding=${'0'.repeat(64)}`),
    },
  });
  assert.equal(wrongBrowser.statusCode, 400);
  assert.equal(saved.length, 0);
  const response = await app.inject({
    method: 'GET',
    url: `${tenantOAuthRoutePaths.callback}?state=${state}&code=synthetic-code`,
    headers: {
      cookie: callbackCookie(cookie),
      'x-tenant-id': forgedTenantId,
      'x-salesforce-org-id': forgedOrgId,
      'x-salesforce-user-id': forgedUserId,
      'x-administrator-actor': 'administrator:forged',
    },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'connected' });
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.tenantId, tenantId);
  assert.equal(saved[0]?.salesforceOrgId, orgId);
  assert.equal(saved[0]?.actorId, 'administrator:synthetic');
  assert.equal(saved[0]?.salesforceUserId, userId);
  assert.equal(
    response.headers['set-cookie'],
    '__Host-kusanya_oauth_binding=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax',
  );
  assert.doesNotMatch(response.body, /synthetic-code|token|secret|005/);
});

void test('requires the exact initiating administrator session at callback time', async (context) => {
  let fetches = 0;
  const { app, memory } = createRouteApp({
    fetchImplementation: async () => {
      fetches++;
      return signedResponse();
    },
  });
  context.after(() => app.close());
  const start = await app.inject({
    method: 'POST',
    url: tenantOAuthRoutePaths.start,
    headers: startHeaders(),
  });
  const state = new URL(start.headers.location!).searchParams.get('state')!;
  const binding = String(start.headers['set-cookie']).split(';', 1)[0]!;
  const replacementSession = 'r'.repeat(43);
  const response = await app.inject({
    method: 'GET',
    url: `${tenantOAuthRoutePaths.callback}?state=${state}&code=synthetic-code`,
    headers: { cookie: callbackCookie(binding, replacementSession) },
  });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { error: 'Authorization failed' });
  assert.equal(fetches, 0);
  assert.equal(memory.rows.size, 1);
});

void test('revocation between start and callback immediately prevents completion', async (context) => {
  let active = true;
  let fetches = 0;
  const { app, memory } = createRouteApp({
    authenticateAdministrator: async () => {
      if (!active) return undefined;
      return {
        actorId: 'administrator:synthetic',
        tenantId,
        expectedSalesforceOrgId: orgId,
        authorizationOrigin: 'https://login.salesforce.com',
        namespacePrefix: 'ksny__',
        role: 'administrator',
        csrfToken,
      };
    },
    fetchImplementation: async () => {
      fetches++;
      return signedResponse();
    },
  });
  context.after(() => app.close());
  const start = await app.inject({
    method: 'POST',
    url: tenantOAuthRoutePaths.start,
    headers: startHeaders(),
  });
  const state = new URL(start.headers.location!).searchParams.get('state')!;
  const binding = String(start.headers['set-cookie']).split(';', 1)[0]!;
  active = false;
  const response = await app.inject({
    method: 'GET',
    url: `${tenantOAuthRoutePaths.callback}?state=${state}&code=synthetic-code`,
    headers: { cookie: callbackCookie(binding) },
  });
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), { error: 'Authentication required' });
  assert.equal(fetches, 0);
  assert.equal(memory.rows.size, 1);
});

void test('normalizes provider descriptions at the edge and consumes their one-time state', async (context) => {
  let fetches = 0;
  const { app, memory } = createRouteApp({
    fetchImplementation: async () => {
      fetches++;
      return signedResponse();
    },
  });
  context.after(() => app.close());
  const start = await app.inject({
    method: 'POST',
    url: tenantOAuthRoutePaths.start,
    headers: startHeaders(),
  });
  const state = new URL(start.headers.location!).searchParams.get('state')!;
  const cookie = String(start.headers['set-cookie']).split(';', 1)[0]!;
  const secretDescription = 'private provider detail';
  const response = await app.inject({
    method: 'GET',
    url:
      `${tenantOAuthRoutePaths.callback}?state=${state}` +
      `&error=access_denied&error_description=${encodeURIComponent(secretDescription)}`,
    headers: { cookie: callbackCookie(cookie) },
  });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { error: 'Authorization failed' });
  assert.doesNotMatch(response.body, /private|provider detail|access_denied/);
  assert.equal(fetches, 0);
  assert.equal(memory.rows.size, 0);
});

void test('rejects duplicate cookies and hostile authenticated contexts without executing getters', async (context) => {
  let getters = 0;
  const hostile = Object.defineProperty({}, 'tenantId', {
    enumerable: true,
    get() {
      getters++;
      return forgedTenantId;
    },
  });
  const { app, memory } = createRouteApp({
    authenticateAdministrator: async () => hostile,
  });
  context.after(() => app.close());
  const hostileResponse = await app.inject({
    method: 'POST',
    url: tenantOAuthRoutePaths.start,
    headers: startHeaders(),
  });
  assert.equal(hostileResponse.statusCode, 401);
  assert.equal(getters, 0);
  const duplicate = await app.inject({
    method: 'POST',
    url: tenantOAuthRoutePaths.start,
    headers: {
      ...startHeaders(),
      cookie:
        `__Host-kusanya_admin_session=${'s'.repeat(43)}; ` +
        `__Host-kusanya_admin_session=${'t'.repeat(43)}`,
    },
  });
  assert.equal(duplicate.statusCode, 400);
  assert.equal(memory.rows.size, 0);
});

void test('rejects noncanonical provisioned namespaces at the route boundary', async (context) => {
  for (const namespacePrefix of ['MyNs__', 'my_ns__', 'Evil__']) {
    const { app, memory } = createRouteApp({
      authenticateAdministrator: async () => ({
        actorId: 'administrator:synthetic',
        tenantId,
        expectedSalesforceOrgId: orgId,
        authorizationOrigin: 'https://login.salesforce.com',
        namespacePrefix,
        csrfToken,
      }),
    });
    context.after(() => app.close());
    const response = await app.inject({
      method: 'POST',
      url: tenantOAuthRoutePaths.start,
      headers: startHeaders(),
    });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: 'Authentication required' });
    assert.equal(memory.rows.size, 0);
  }
});

void test('never reflects authentication failures and rejects duplicate callback values', async (context) => {
  const privateDetail = 'private-session-signature';
  const { app } = createRouteApp({
    authenticateAdministrator: async () => {
      throw new Error(privateDetail);
    },
  });
  context.after(() => app.close());
  const denied = await app.inject({
    method: 'POST',
    url: tenantOAuthRoutePaths.start,
    headers: startHeaders(),
  });
  assert.equal(denied.statusCode, 401);
  assert.doesNotMatch(denied.body, new RegExp(privateDetail));
  const duplicate = await app.inject({
    method: 'GET',
    url:
      `${tenantOAuthRoutePaths.callback}?state=${'a'.repeat(43)}` +
      `&state=${'b'.repeat(43)}&code=synthetic-code`,
    headers: {
      cookie: `__Host-kusanya_oauth_binding=${'0'.repeat(64)}`,
    },
  });
  assert.equal(duplicate.statusCode, 400);
  assert.deepEqual(duplicate.json(), { error: 'Authorization failed' });
  assert.equal(
    duplicate.headers['set-cookie'],
    '__Host-kusanya_oauth_binding=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax',
  );
});

void test('refuses route registration unless callback and public origin are exact', () => {
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  assert.throws(
    () =>
      registerTenantOAuthRoutes(app, {
        authenticateAdministrator: async () => undefined,
        transactionStore: memoryStore().store,
        connectionStore: connectionStore(() => {}),
        oauthConfiguration: {
          ...oauthConfiguration,
          redirectUri: 'https://other.example/api/admin/salesforce/callback',
        },
        externalOrigin: 'https://service.example',
      }),
    { message: 'ADMIN_ROUTE_CONFIGURATION' },
  );
});

void test('refuses OAuth registration on a host with automatic request logging', async () => {
  const app = Fastify({ logger: false });
  assert.throws(
    () =>
      registerTenantOAuthRoutes(app, {
        authenticateAdministrator: async () => undefined,
        transactionStore: memoryStore().store,
        connectionStore: connectionStore(() => {}),
        oauthConfiguration,
        externalOrigin: 'https://service.example',
      }),
    { message: 'HTTP_LOGGING_CONFIGURATION' },
  );
  await app.close();
});
