import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import {
  registerPublicationSurface,
  type PublicationSurfaceDependencies,
} from '../../src/publication-surface.js';

const config = readConfig({
  DATABASE_URL: 'postgresql://kusanya@localhost:5432/kusanya',
});
const origin = 'https://kusanya.example';
const opaqueSession = 's'.repeat(43);
const csrfToken = 'c'.repeat(43);
const context = {
  actorId: 'oidc:actor',
  tenantId: '11111111-1111-4111-8111-111111111111',
  expectedSalesforceOrgId: '00D000000000001EAA',
  authorizationOrigin: 'https://login.salesforce.com',
  namespacePrefix: '',
  csrfToken,
};

function dependencies(): PublicationSurfaceDependencies {
  return {
    verifyLoginRequest: async () => ({ actorId: context.actorId }),
    sessionStore: {
      async issue() {
        return { opaqueSession, csrfToken, expiresInSeconds: 3600 };
      },
      async authenticate() {
        return context;
      },
      async revoke() {
        return true;
      },
    },
    sessionConfiguration: {
      sessionSecret: Buffer.alloc(32, 1).toString('base64'),
      ttlSeconds: 3600,
    },
    connectionStore: {
      async withRefreshLock() {
        throw new Error('not reached');
      },
    },
    attemptStore: {
      async start() {
        throw new Error('not reached');
      },
      async complete() {
        throw new Error('not reached');
      },
      async listForOperator() {
        return [
          {
            attemptId: '11111111-1111-4111-8111-111111111111',
            formVersionId: 'a01000000000001AAA',
            operatorStatus: 'human_judgement_required_unresolved' as const,
            startedAt: '2026-10-27T00:00:00.000Z',
            completedAt: null,
            reconciledAt: null,
          },
        ];
      },
    },
    publisherConfiguration: {
      clientId: 'client',
      clientSecret: 'secret',
      refreshTimeoutMs: 1000,
      perRequestTimeoutMs: 1000,
      overallTimeoutMs: 5000,
    },
    validateXForm: async () => ({ ok: true }),
    externalOrigin: origin,
  };
}

void test('the real app mounts login, CSRF, publication and least-data presentation', async (contextTest) => {
  const app = createApp(
    config,
    { async ping() {}, async close() {} },
    false,
    dependencies(),
  );
  contextTest.after(() => app.close());
  const login = await app.inject({
    method: 'POST',
    url: '/api/admin/session/login',
    headers: { origin, authorization: 'Bearer synthetic.id.token' },
  });
  assert.equal(login.statusCode, 204);
  assert.match(
    String(login.headers['set-cookie'] ?? ''),
    /Secure; HttpOnly; SameSite=Lax/,
  );

  const csrf = await app.inject({
    method: 'POST',
    url: '/api/admin/session/csrf',
    headers: {
      origin,
      cookie: `__Host-kusanya_admin_session=${opaqueSession}`,
    },
  });
  assert.equal(csrf.statusCode, 200);
  assert.deepEqual(csrf.json(), { csrfToken });

  const attempts = await app.inject({
    method: 'GET',
    url: '/api/admin/salesforce/publication-attempts',
    headers: {
      origin,
      cookie: `__Host-kusanya_admin_session=${opaqueSession}`,
      'x-csrf-token': csrfToken,
    },
  });
  assert.equal(attempts.statusCode, 200);
  const attemptsBody = attempts.json<{
    attempts: Array<Record<string, unknown>>;
  }>();
  assert.deepEqual(Object.keys(attemptsBody.attempts[0]!), [
    'attemptId',
    'formVersionId',
    'operatorStatus',
    'startedAt',
    'completedAt',
    'reconciledAt',
  ]);
  assert.equal(attempts.headers['cache-control'], 'no-store');
  assert.equal(
    (
      await app.inject({
        method: 'GET',
        url: '/api/admin/salesforce/publications',
      })
    ).statusCode,
    404,
  );
});

void test('mounted presentation keeps origin, session and CSRF boundaries in the real app', async (contextTest) => {
  const app = createApp(
    config,
    { async ping() {}, async close() {} },
    false,
    dependencies(),
  );
  contextTest.after(() => app.close());
  const base = {
    method: 'GET' as const,
    url: '/api/admin/salesforce/publication-attempts',
    headers: {
      origin,
      cookie: `__Host-kusanya_admin_session=${opaqueSession}`,
      'x-csrf-token': csrfToken,
    },
  };
  const attacks = [
    {
      ...base,
      headers: {
        cookie: base.headers.cookie,
        'x-csrf-token': csrfToken,
      },
    },
    { ...base, headers: { ...base.headers, origin: 'https://evil.example' } },
    {
      ...base,
      headers: { ...base.headers, 'content-type': 'application/json' },
      payload: '{}',
    },
    { ...base, url: `${base.url}?tenant=other` },
    {
      ...base,
      headers: {
        origin,
        'x-csrf-token': csrfToken,
      },
    },
    {
      ...base,
      headers: { ...base.headers, cookie: '__Host-kusanya_admin_session=x' },
    },
    {
      ...base,
      headers: {
        ...base.headers,
        cookie: `${base.headers.cookie}; __Host-kusanya_admin_session=${opaqueSession}`,
      },
    },
    {
      ...base,
      headers: { origin, cookie: base.headers.cookie },
    },
    { ...base, headers: { ...base.headers, 'x-csrf-token': 'x' } },
    { ...base, headers: { ...base.headers, 'x-csrf-token': 'x'.repeat(43) } },
  ];
  for (const attack of attacks) {
    const response = await app.inject(attack);
    assert.ok([400, 401, 403].includes(response.statusCode));
    assert.doesNotMatch(response.body, /tenant|actor|00D|secret/i);
  }
  const forgedSelector = await app.inject({
    ...base,
    headers: { ...base.headers, 'x-tenant-id': 'other' },
  });
  assert.equal(forgedSelector.statusCode, 200);
  assert.doesNotMatch(forgedSelector.body, /other|tenant|actor|00D/i);

  const revokedDependencies = dependencies();
  const revokedApp = createApp(
    config,
    { async ping() {}, async close() {} },
    false,
    {
      ...revokedDependencies,
      sessionStore: {
        ...revokedDependencies.sessionStore,
        async authenticate() {
          return undefined;
        },
      },
    },
  );
  contextTest.after(() => revokedApp.close());
  const revoked = await revokedApp.inject(base);
  assert.equal(revoked.statusCode, 401);
  assert.deepEqual(revoked.json(), { error: 'Authentication required' });
});

void test('composition refuses an unhardened host and any missing capability', async () => {
  const unsafe = Fastify({ logger: true });
  await unsafe.ready();
  assert.throws(
    () => registerPublicationSurface(unsafe, dependencies()),
    /HTTP_LOGGING_CONFIGURATION/,
  );
  await unsafe.close();

  for (const key of Object.keys(dependencies())) {
    const app = createApp(config, { async ping() {}, async close() {} }, false);
    const broken = { ...dependencies() } as Record<string, unknown>;
    delete broken[key];
    assert.throws(
      () =>
        registerPublicationSurface(
          app,
          broken as unknown as PublicationSurfaceDependencies,
        ),
      /PUBLICATION_SURFACE_CONFIGURATION/,
      key,
    );
    await app.close();
  }
});
