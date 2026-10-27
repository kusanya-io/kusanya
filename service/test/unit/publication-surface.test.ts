import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import {
  registerPublicationSurface,
  type PublicationSurfaceDependencies,
} from '../../src/publication-surface.js';
import { AdministratorSessionError } from '../../src/tenant/administrator-session.js';
import { AdministratorOidcError } from '../../src/tenant/oidc-login.js';

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
    administratorIdentity: {
      verifyLoginRequest: async () => ({ actorId: context.actorId }),
      actorIdForSubject: (subject) => `oidc:${subject}`,
    },
    sessionStore: {
      async provision() {},
      async deprovision() {},
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
        return {
          attempts: [
            {
              attemptId: '11111111-1111-4111-8111-111111111111',
              formVersionId: 'a01000000000001AAA',
              operatorStatus: 'human_judgement_required_unresolved' as const,
              startedAt: '2026-10-27T00:00:00.000Z',
              completedAt: null,
              reconciledAt: null,
            },
          ],
          nextCursor: null,
        };
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
    nextCursor: string | null;
  }>();
  assert.equal(attemptsBody.nextCursor, null);
  assert.deepEqual(Object.keys(attemptsBody.attempts[0]!), [
    'attemptId',
    'formVersionId',
    'operatorStatus',
    'startedAt',
    'completedAt',
    'reconciledAt',
  ]);
  assert.equal(attempts.headers['cache-control'], 'no-store');
  const operatorInterface = await app.inject({
    method: 'GET',
    url: '/admin',
  });
  assert.equal(operatorInterface.statusCode, 200);
  assert.match(
    String(operatorInterface.headers['content-security-policy']),
    /default-src 'none'/,
  );
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

void test('mounted administrator lifecycle crosses identity and live tenant exactly once', async (contextTest) => {
  const base = dependencies();
  const provisioned: unknown[] = [];
  const deprovisioned: unknown[] = [];
  const app = createApp(config, { async ping() {}, async close() {} }, false, {
    ...base,
    sessionStore: {
      ...base.sessionStore,
      async provision(input) {
        provisioned.push(input);
      },
      async deprovision(input) {
        deprovisioned.push(input);
      },
    },
  });
  contextTest.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: '/api/admin/administrators',
    headers: {
      origin,
      cookie: `__Host-kusanya_admin_session=${opaqueSession}`,
      'x-csrf-token': csrfToken,
      'content-type': 'application/json',
      'x-actor-id': 'forged',
      'x-tenant-id': 'forged',
    },
    payload: { subject: 'new-subject' },
  });
  assert.equal(response.statusCode, 204);
  assert.deepEqual(provisioned, [
    {
      actorId: 'oidc:new-subject',
      tenantId: context.tenantId,
      expectedSalesforceOrgId: context.expectedSalesforceOrgId,
      authorizationOrigin: context.authorizationOrigin,
      namespacePrefix: context.namespacePrefix,
    },
  ]);

  const widened = await app.inject({
    method: 'POST',
    url: '/api/admin/administrators',
    headers: {
      origin,
      cookie: `__Host-kusanya_admin_session=${opaqueSession}`,
      'x-csrf-token': csrfToken,
      'content-type': 'application/json',
    },
    payload: { subject: 'other', tenantId: 'forged' },
  });
  assert.equal(widened.statusCode, 400);
  assert.equal(provisioned.length, 1);

  const removed = await app.inject({
    method: 'DELETE',
    url: '/api/admin/administrators',
    headers: {
      origin,
      cookie: `__Host-kusanya_admin_session=${opaqueSession}`,
      'x-csrf-token': csrfToken,
      'content-type': 'application/json',
      'x-tenant-id': 'forged',
    },
    payload: { subject: 'departing-subject' },
  });
  assert.equal(removed.statusCode, 204);
  assert.deepEqual(deprovisioned, [
    {
      performedByActorId: context.actorId,
      targetActorId: 'oidc:departing-subject',
      tenantId: context.tenantId,
    },
  ]);
});

void test('mounted login reports identity refusals as authentication failures', async (contextTest) => {
  const rejectedDependencies = dependencies();
  const rejectedApp = createApp(
    config,
    { async ping() {}, async close() {} },
    false,
    {
      ...rejectedDependencies,
      administratorIdentity: {
        ...rejectedDependencies.administratorIdentity,
        verifyLoginRequest: async () => {
          throw new AdministratorOidcError();
        },
      },
    },
  );
  contextTest.after(() => rejectedApp.close());
  const rejected = await rejectedApp.inject({
    method: 'POST',
    url: '/api/admin/session/login',
    headers: {
      origin,
      authorization: 'Bearer rejected.synthetic.token',
    },
  });
  assert.equal(rejected.statusCode, 401);
  assert.deepEqual(rejected.json(), { error: 'Authentication required' });
  assert.match(
    String(rejected.headers['set-cookie'] ?? ''),
    /Max-Age=0; Secure; HttpOnly; SameSite=Lax/,
  );

  const absentDependencies = dependencies();
  const absentApp = createApp(
    config,
    { async ping() {}, async close() {} },
    false,
    {
      ...absentDependencies,
      sessionStore: {
        ...absentDependencies.sessionStore,
        async issue() {
          throw new AdministratorSessionError('ADMINISTRATOR_SESSION_ABSENT');
        },
      },
    },
  );
  contextTest.after(() => absentApp.close());
  const absent = await absentApp.inject({
    method: 'POST',
    url: '/api/admin/session/login',
    headers: {
      origin,
      authorization: 'Bearer valid.but.unprovisioned',
    },
  });
  assert.equal(absent.statusCode, 401);
  assert.deepEqual(absent.json(), { error: 'Authentication required' });
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
  for (const key of ['verifyLoginRequest', 'actorIdForSubject']) {
    const app = createApp(config, { async ping() {}, async close() {} }, false);
    const base = dependencies();
    const identity = {
      ...base.administratorIdentity,
    } as Record<string, unknown>;
    delete identity[key];
    assert.throws(
      () =>
        registerPublicationSurface(app, {
          ...base,
          administratorIdentity: identity as never,
        }),
      /PUBLICATION_SURFACE_CONFIGURATION/,
      key,
    );
    await app.close();
  }
});
