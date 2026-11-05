import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import {
  registerTenantConnectionLifecycleRoutes,
  tenantConnectionLifecycleRoutePaths,
  type TenantConnectionLifecycleRouteDependencies,
} from '../../src/tenant/connection-lifecycle-routes.js';
import { TenantConnectionError } from '../../src/tenant/connection-store.js';
import { AdministratorSessionError } from '../../src/tenant/administrator-session.js';

const config = readConfig({ DATABASE_URL: 'postgresql://localhost/kusanya' });
const session = 's'.repeat(43);
const csrf = 'c'.repeat(43);
const context = {
  actorId: 'oidc:administrator',
  tenantId: '10000000-0000-4000-8000-000000000001',
  expectedSalesforceOrgId: '00D000000000001EAA',
  authorizationOrigin: 'https://login.salesforce.com',
  namespacePrefix: 'ksny__',
  role: 'administrator' as const,
  csrfToken: csrf,
};

function headers(extra: Record<string, string> = {}) {
  return {
    origin: 'https://service.example',
    cookie: `__Host-kusanya_admin_session=${session}`,
    'x-csrf-token': csrf,
    ...extra,
  };
}

function dependencies(
  role: 'administrator' | 'publisher' | 'reviewer' = 'administrator',
): TenantConnectionLifecycleRouteDependencies & { events: unknown[] } {
  const events: unknown[] = [];
  return {
    events,
    externalOrigin: 'https://service.example',
    async authenticateAdministrator(value) {
      events.push(['authenticate', value]);
      return { ...context, role };
    },
    connectionStore: {
      async disconnect(value) {
        events.push(['disconnect', value]);
      },
      async rebind(value) {
        events.push(['rebind', value]);
      },
    },
  };
}

void test('disconnect is selector-free and uses only the live context', async (t) => {
  const setup = dependencies();
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  t.after(() => app.close());
  registerTenantConnectionLifecycleRoutes(app, setup);
  const response = await app.inject({
    method: 'POST',
    url: tenantConnectionLifecycleRoutePaths.disconnect,
    headers: headers({ 'x-tenant-id': 'forged' }),
  });
  assert.equal(response.statusCode, 204);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(setup.events, [
    ['authenticate', session],
    [
      'disconnect',
      {
        actorId: context.actorId,
        tenantId: context.tenantId,
        salesforceOrgId: context.expectedSalesforceOrgId,
        authorizationOrigin: context.authorizationOrigin,
        namespacePrefix: context.namespacePrefix,
      },
    ],
  ]);
});

void test('rebind accepts only the new public binding tuple', async (t) => {
  const setup = dependencies();
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  t.after(() => app.close());
  registerTenantConnectionLifecycleRoutes(app, setup);
  const response = await app.inject({
    method: 'POST',
    url: tenantConnectionLifecycleRoutePaths.rebind,
    headers: { ...headers(), 'content-type': 'application/json' },
    payload: {
      salesforceOrgId: '00D000000000002',
      authorizationOrigin: 'https://test.salesforce.com',
      namespacePrefix: '',
    },
  });
  assert.equal(response.statusCode, 204);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(setup.events[1], [
    'rebind',
    {
      actorId: context.actorId,
      tenantId: context.tenantId,
      salesforceOrgId: context.expectedSalesforceOrgId,
      authorizationOrigin: context.authorizationOrigin,
      namespacePrefix: context.namespacePrefix,
      newSalesforceOrgId: '00D000000000002EAA',
      newAuthorizationOrigin: 'https://test.salesforce.com',
      newNamespacePrefix: '',
    },
  ]);
  assert.doesNotMatch(JSON.stringify(setup.events), /token|instance/i);
});

void test('publisher and reviewer cannot reach either mutation', async (t) => {
  for (const role of ['publisher', 'reviewer'] as const) {
    for (const [url, payload] of [
      [tenantConnectionLifecycleRoutePaths.disconnect, undefined],
      [
        tenantConnectionLifecycleRoutePaths.rebind,
        {
          salesforceOrgId: '00D000000000002',
          authorizationOrigin: 'https://test.salesforce.com',
          namespacePrefix: '',
        },
      ],
    ] as const) {
      const setup = dependencies(role);
      const app = createApp(
        config,
        { async ping() {}, async close() {} },
        false,
      );
      t.after(() => app.close());
      registerTenantConnectionLifecycleRoutes(app, setup);
      const response =
        payload === undefined
          ? await app.inject({ method: 'POST', url, headers: headers() })
          : await app.inject({
              method: 'POST',
              url,
              headers: { ...headers(), 'content-type': 'application/json' },
              payload,
            });
      assert.equal(response.statusCode, 403);
      assert.equal(
        setup.events.some(
          (event) =>
            Array.isArray(event) &&
            typeof event[0] === 'string' &&
            ['disconnect', 'rebind'].includes(event[0]),
        ),
        false,
      );
    }
  }
});

void test('origin session CSRF query and hostile bodies fail before storage', async (t) => {
  const setup = dependencies();
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  t.after(() => app.close());
  registerTenantConnectionLifecycleRoutes(app, setup);
  const requests = [
    {
      url: tenantConnectionLifecycleRoutePaths.disconnect,
      headers: headers({ origin: 'https://attacker.example' }),
    },
    {
      url: tenantConnectionLifecycleRoutePaths.disconnect,
      headers: { ...headers(), cookie: '' },
    },
    {
      url: tenantConnectionLifecycleRoutePaths.disconnect,
      headers: headers({ 'x-csrf-token': 'x'.repeat(43) }),
    },
    {
      url: `${tenantConnectionLifecycleRoutePaths.disconnect}?tenant=forged`,
      headers: headers(),
    },
    {
      url: tenantConnectionLifecycleRoutePaths.disconnect,
      headers: { ...headers(), 'content-type': 'application/json' },
      payload: {},
    },
    {
      url: tenantConnectionLifecycleRoutePaths.rebind,
      headers: { ...headers(), 'content-type': 'application/json' },
      payload: {
        salesforceOrgId: context.expectedSalesforceOrgId,
        authorizationOrigin: context.authorizationOrigin,
        namespacePrefix: context.namespacePrefix,
        refreshToken: 'must-not-be-accepted',
      },
    },
    {
      url: tenantConnectionLifecycleRoutePaths.rebind,
      headers: { ...headers(), 'content-type': 'application/json' },
      payload: {
        salesforceOrgId: '00D000000000002',
        authorizationOrigin: 'https://example.com',
        namespacePrefix: 'KSNY__',
      },
    },
  ];
  for (const request of requests) {
    const response = await app.inject({ method: 'POST', ...request });
    assert.ok([400, 401, 403].includes(response.statusCode));
    assert.doesNotMatch(response.body, /forged|token|salesforce|ksny/i);
  }
  assert.equal(
    setup.events.some(
      (event) =>
        Array.isArray(event) &&
        typeof event[0] === 'string' &&
        ['disconnect', 'rebind'].includes(event[0]),
    ),
    false,
  );
});

void test('conflict and infrastructure failures are fixed and secret-free', async (t) => {
  for (const [error, expected, message] of [
    [
      new TenantConnectionError('TENANT_CONNECTION_CONFLICT'),
      409,
      'Connection change refused',
    ],
    [
      new TenantConnectionError('TENANT_CONNECTION_STORAGE'),
      503,
      'Connection change unavailable',
    ],
  ] as const) {
    const base = dependencies();
    const app = createApp(config, { async ping() {}, async close() {} }, false);
    t.after(() => app.close());
    registerTenantConnectionLifecycleRoutes(app, {
      ...base,
      connectionStore: {
        async disconnect(): Promise<never> {
          throw error;
        },
        async rebind(): Promise<never> {
          throw error;
        },
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: tenantConnectionLifecycleRoutePaths.disconnect,
      headers: headers(),
    });
    assert.equal(response.statusCode, expected);
    assert.deepEqual(response.json(), { error: message });
    assert.doesNotMatch(response.body, /tenant|actor|org|token/i);
  }

  const unavailable = {
    ...dependencies(),
    async authenticateAdministrator(): Promise<never> {
      throw new AdministratorSessionError('ADMINISTRATOR_SESSION_STORAGE');
    },
  };
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  t.after(() => app.close());
  registerTenantConnectionLifecycleRoutes(app, unavailable);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: tenantConnectionLifecycleRoutePaths.disconnect,
        headers: headers(),
      })
    ).statusCode,
    503,
  );
});

void test('refuses unhardened logging and malformed service origin', async () => {
  const unsafe = Fastify({ logger: true });
  await unsafe.ready();
  assert.throws(
    () => registerTenantConnectionLifecycleRoutes(unsafe, dependencies()),
    /HTTP_LOGGING_CONFIGURATION/,
  );
  await unsafe.close();
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  assert.throws(
    () =>
      registerTenantConnectionLifecycleRoutes(app, {
        ...dependencies(),
        externalOrigin: 'http://service.example',
      }),
    /TENANT_CONNECTION_LIFECYCLE_CONFIGURATION/,
  );
  await app.close();
});
