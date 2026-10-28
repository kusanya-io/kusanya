import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import {
  publicationAttemptRetentionRoutePaths,
  registerPublicationAttemptRetentionRoutes,
  type PublicationAttemptRetentionRouteDependencies,
} from '../../src/publication/publication-attempt-retention-routes.js';
import { PublicationAttemptError } from '../../src/publication/publication-attempt-store.js';
import { AdministratorSessionError } from '../../src/tenant/administrator-session.js';

const session = 's'.repeat(43);
const csrf = 'c'.repeat(43);
const config = readConfig({ DATABASE_URL: 'postgresql://localhost/kusanya' });

function context(role: 'administrator' | 'publisher' | 'reviewer') {
  return {
    actorId: 'oidc:operator',
    tenantId: '10000000-0000-4000-8000-000000000001',
    expectedSalesforceOrgId: '00D000000000001EAA',
    authorizationOrigin: 'https://login.salesforce.com',
    namespacePrefix: 'ksny__',
    role,
    csrfToken: csrf,
  } as const;
}

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
): PublicationAttemptRetentionRouteDependencies & { events: unknown[] } {
  const events: unknown[] = [];
  return {
    events,
    externalOrigin: 'https://service.example',
    async authenticateAdministrator(value) {
      events.push(['authenticate', value]);
      return context(role);
    },
    attemptStore: {
      async applyRetention(value) {
        events.push(['retain', value]);
        return { deletedCount: 3, secret: 'must-not-serialize' } as never;
      },
    },
  };
}

void test('applies the server-owned policy without a selector', async (t) => {
  const setup = dependencies();
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  t.after(() => app.close());
  registerPublicationAttemptRetentionRoutes(app, setup);
  const response = await app.inject({
    method: 'POST',
    url: publicationAttemptRetentionRoutePaths.retention,
    headers: headers({ 'x-tenant-id': 'forged' }),
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { deletedCount: 3 });
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(setup.events[0], ['authenticate', session]);
  assert.equal((setup.events[1] as unknown[])[0], 'retain');
  assert.equal(
    ((setup.events[1] as unknown[])[1] as { tenantId: string }).tenantId,
    context('administrator').tenantId,
  );
});

void test('denies publisher and reviewer before retention storage', async (t) => {
  for (const role of ['publisher', 'reviewer'] as const) {
    const setup = dependencies(role);
    const app = createApp(config, { async ping() {}, async close() {} }, false);
    t.after(() => app.close());
    registerPublicationAttemptRetentionRoutes(app, setup);
    const response = await app.inject({
      method: 'POST',
      url: publicationAttemptRetentionRoutePaths.retention,
      headers: headers(),
    });
    assert.equal(response.statusCode, 403);
    assert.equal(
      setup.events.some(
        (event) => Array.isArray(event) && event[0] === 'retain',
      ),
      false,
    );
  }
});

void test('rejects origin, session, CSRF, query and body before deletion', async (t) => {
  const setup = dependencies();
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  t.after(() => app.close());
  registerPublicationAttemptRetentionRoutes(app, setup);
  const requests = [
    { headers: headers({ origin: 'https://attacker.example' }) },
    { headers: headers({ 'x-csrf-token': 'x'.repeat(43) }) },
    { headers: { ...headers(), cookie: '' } },
    {
      headers: {
        ...headers(),
        cookie: `__Host-kusanya_admin_session=${session}; __Host-kusanya_admin_session=${session}`,
      },
    },
    {
      headers: headers(),
      url: `${publicationAttemptRetentionRoutePaths.retention}?days=1`,
    },
    {
      headers: { ...headers(), 'content-type': 'application/json' },
      payload: { attemptId: '10000000-0000-4000-8000-000000000001' },
    },
  ];
  for (const request of requests) {
    const response = await app.inject({
      method: 'POST',
      url: publicationAttemptRetentionRoutePaths.retention,
      ...request,
    });
    assert.ok([400, 401, 403].includes(response.statusCode));
  }
  assert.equal(
    setup.events.some((event) => Array.isArray(event) && event[0] === 'retain'),
    false,
  );
});

void test('maps authentication and storage failures to fixed responses', async (t) => {
  const authentication = {
    ...dependencies(),
    async authenticateAdministrator(): Promise<never> {
      throw new AdministratorSessionError('ADMINISTRATOR_SESSION_ABSENT');
    },
  };
  const unavailableBase = dependencies();
  const unavailable = {
    ...unavailableBase,
    attemptStore: {
      async applyRetention(): Promise<never> {
        throw new PublicationAttemptError();
      },
    },
  };
  for (const [setup, expected] of [
    [authentication, 401],
    [unavailable, 503],
  ] as const) {
    const app = createApp(config, { async ping() {}, async close() {} }, false);
    t.after(() => app.close());
    registerPublicationAttemptRetentionRoutes(app, setup);
    const response = await app.inject({
      method: 'POST',
      url: publicationAttemptRetentionRoutePaths.retention,
      headers: headers(),
    });
    assert.equal(response.statusCode, expected);
    assert.deepEqual(response.json(), {
      error:
        expected === 401 ? 'Authentication required' : 'Retention unavailable',
    });
    assert.doesNotMatch(response.body, /tenant|actor|attempt/i);
  }
});

void test('refuses an unhardened host and malformed origin configuration', async () => {
  const unsafe = Fastify({ logger: true });
  await unsafe.ready();
  assert.throws(
    () => registerPublicationAttemptRetentionRoutes(unsafe, dependencies()),
    /HTTP_LOGGING_CONFIGURATION/,
  );
  await unsafe.close();
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  assert.throws(
    () =>
      registerPublicationAttemptRetentionRoutes(app, {
        ...dependencies(),
        externalOrigin: 'http://service.example',
      }),
    /PUBLICATION_RETENTION_CONFIGURATION/,
  );
  await app.close();
});
