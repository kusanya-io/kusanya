import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import {
  administratorSessionRoutePaths,
  registerAdministratorSessionRoutes,
  type AdministratorRouteDependencies,
} from '../../src/tenant/administrator-routes.js';

const origin = 'https://service.example';
const actorId = 'administrator:synthetic';
const opaqueSession = 's'.repeat(43);
const csrfToken = 'c'.repeat(43);
const cookieName = '__Host-kusanya_admin_session';
const sessionConfiguration = Object.freeze({
  sessionSecret: Buffer.alloc(32, 71).toString('base64'),
  ttlSeconds: 900,
});
const context = Object.freeze({
  actorId,
  tenantId: '10000000-0000-4000-8000-000000000001',
  expectedSalesforceOrgId: '00D000000000001EAA',
  authorizationOrigin: 'https://login.salesforce.com',
  namespacePrefix: 'ksny__',
  role: 'administrator' as const,
  csrfToken,
});
const config = readConfig({
  DATABASE_URL: 'postgresql://kusanya@localhost:5432/kusanya',
});

function createRouteApp(
  overrides: Partial<AdministratorRouteDependencies> = {},
) {
  const issuedActors: string[] = [];
  const authenticated: string[] = [];
  const revoked: string[] = [];
  const accepted: unknown[] = [];
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  const dependencies: AdministratorRouteDependencies = {
    verifyLoginRequest: async () => ({ actorId }),
    sessionStore: {
      async issue(actor) {
        issuedActors.push(actor);
        return Object.freeze({
          opaqueSession,
          csrfToken,
          expiresInSeconds: 900,
        });
      },
      async authenticate(session) {
        authenticated.push(session);
        return session === opaqueSession ? context : undefined;
      },
      async revoke(session) {
        revoked.push(session);
        return session === opaqueSession;
      },
    },
    invitationStore: {
      async accept(input) {
        accepted.push(input);
        return Object.freeze({
          opaqueSession,
          csrfToken,
          expiresInSeconds: 900,
        });
      },
    },
    sessionConfiguration,
    externalOrigin: origin,
    ...overrides,
  };
  registerAdministratorSessionRoutes(app, dependencies);
  return { app, issuedActors, authenticated, revoked, accepted };
}

function headers(extra: Record<string, string> = {}) {
  return {
    origin,
    cookie: `${cookieName}=${opaqueSession}`,
    ...extra,
  };
}

void test('issues only a fresh hardened host cookie after trusted login', async (t) => {
  let verifications = 0;
  const { app, issuedActors } = createRouteApp({
    verifyLoginRequest: async () => {
      verifications++;
      return { actorId };
    },
  });
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: administratorSessionRoutePaths.login,
    headers: headers(),
  });
  assert.equal(response.statusCode, 204);
  assert.equal(response.body, '');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(
    response.headers['set-cookie'],
    `${cookieName}=${opaqueSession}; Path=/; Max-Age=900; Secure; HttpOnly; SameSite=Lax`,
  );
  assert.doesNotMatch(String(response.headers['set-cookie']), /Domain=/i);
  assert.doesNotMatch(response.body, new RegExp(csrfToken));
  assert.deepEqual(issuedActors, [actorId]);
  assert.equal(verifications, 1);
});

void test('accepts an invitation only for the OIDC-verified actor and issues the same hardened cookie', async (t) => {
  const invitationToken = 'i'.repeat(43);
  const { app, issuedActors, accepted } = createRouteApp();
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: administratorSessionRoutePaths.login,
    headers: {
      ...headers(),
      'content-type': 'application/json',
    },
    payload: { invitationToken },
  });
  assert.equal(response.statusCode, 204);
  assert.deepEqual(issuedActors, []);
  assert.deepEqual(accepted, [{ actorId, invitationToken }]);
  assert.equal(
    response.headers['set-cookie'],
    `${cookieName}=${opaqueSession}; Path=/; Max-Age=900; Secure; HttpOnly; SameSite=Lax`,
  );
});

void test('login rejects cross-origin, nonempty and hostile verifier results', async (t) => {
  let calls = 0;
  const { app, issuedActors } = createRouteApp({
    verifyLoginRequest: async () => {
      calls++;
      return Object.defineProperty({}, 'actorId', {
        enumerable: true,
        get() {
          throw new Error('must not execute');
        },
      });
    },
  });
  t.after(() => app.close());
  const cases = [
    {
      url: administratorSessionRoutePaths.login,
      origin: 'https://evil.example',
      expected: 400,
    },
    {
      url: `${administratorSessionRoutePaths.login}?actor=${actorId}`,
      origin,
      expected: 400,
    },
    { url: administratorSessionRoutePaths.login, origin, expected: 401 },
  ];
  for (const item of cases) {
    const response = await app.inject({
      method: 'POST',
      url: item.url,
      headers: { ...headers(), origin: item.origin },
    });
    assert.equal(response.statusCode, item.expected);
    assert.equal(
      response.headers['set-cookie'],
      `${cookieName}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`,
    );
    assert.doesNotMatch(response.body, /actor|must not execute/);
  }
  assert.equal(calls, 1);
  assert.deepEqual(issuedActors, []);
});

void test('releases CSRF only to an exact-origin authenticated bootstrap', async (t) => {
  const { app, authenticated } = createRouteApp();
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: administratorSessionRoutePaths.csrf,
    headers: headers(),
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { csrfToken });
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['set-cookie'], undefined);
  const crossOrigin = await app.inject({
    method: 'POST',
    url: administratorSessionRoutePaths.csrf,
    headers: headers({ origin: 'https://evil.example' }),
  });
  assert.equal(crossOrigin.statusCode, 400);
  assert.doesNotMatch(crossOrigin.body, new RegExp(csrfToken));
  assert.equal(crossOrigin.headers['access-control-allow-origin'], undefined);
  const absent = await app.inject({
    method: 'POST',
    url: administratorSessionRoutePaths.csrf,
    headers: { origin },
  });
  assert.equal(absent.statusCode, 401);
  assert.equal(
    absent.headers['set-cookie'],
    `${cookieName}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`,
  );
  assert.doesNotMatch(absent.body, new RegExp(csrfToken));
  assert.deepEqual(authenticated, [opaqueSession]);
});

void test('keeps session bootstrap and logout available to every active role', async (t) => {
  for (const role of ['administrator', 'publisher', 'reviewer'] as const) {
    const events: string[] = [];
    const { app } = createRouteApp({
      sessionStore: {
        async issue() {
          throw new Error('unused');
        },
        async authenticate() {
          events.push(`authenticate:${role}`);
          return { ...context, role };
        },
        async revoke() {
          events.push(`revoke:${role}`);
          return true;
        },
      },
    });
    t.after(() => app.close());
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: administratorSessionRoutePaths.csrf,
          headers: headers(),
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: administratorSessionRoutePaths.logout,
          headers: headers({ 'x-csrf-token': csrfToken }),
        })
      ).statusCode,
      204,
    );
    assert.deepEqual(events, [
      `authenticate:${role}`,
      `authenticate:${role}`,
      `revoke:${role}`,
    ]);
  }
});

void test('rejects duplicate session cookies and hostile contexts without access', async (t) => {
  let getterCalls = 0;
  const { app } = createRouteApp({
    sessionStore: {
      async issue() {
        throw new Error('unused');
      },
      async authenticate() {
        return Object.defineProperty({}, 'csrfToken', {
          enumerable: true,
          get() {
            getterCalls++;
            return csrfToken;
          },
        }) as never;
      },
      async revoke() {
        throw new Error('unused');
      },
    },
  });
  t.after(() => app.close());
  const duplicate = await app.inject({
    method: 'POST',
    url: administratorSessionRoutePaths.csrf,
    headers: {
      origin,
      cookie: `${cookieName}=${opaqueSession}; ${cookieName}=${'x'.repeat(43)}`,
    },
  });
  assert.equal(duplicate.statusCode, 401);
  const hostile = await app.inject({
    method: 'POST',
    url: administratorSessionRoutePaths.csrf,
    headers: headers(),
  });
  assert.equal(hostile.statusCode, 401);
  assert.equal(getterCalls, 0);
  assert.doesNotMatch(hostile.body, new RegExp(csrfToken));
});

void test('logout revokes the row before expiring the browser cookie', async (t) => {
  const events: string[] = [];
  const { app } = createRouteApp({
    sessionStore: {
      async issue() {
        throw new Error('unused');
      },
      async authenticate() {
        events.push('authenticate');
        return context;
      },
      async revoke() {
        events.push('revoke');
        return true;
      },
    },
  });
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: administratorSessionRoutePaths.logout,
    headers: headers({ 'x-csrf-token': csrfToken }),
  });
  assert.equal(response.statusCode, 204);
  assert.deepEqual(events, ['authenticate', 'revoke']);
  assert.equal(
    response.headers['set-cookie'],
    `${cookieName}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`,
  );
  assert.equal(response.body, '');
});

void test('logout keeps the cookie when CSRF or database revocation fails', async (t) => {
  let revocations = 0;
  const { app } = createRouteApp({
    sessionStore: {
      async issue() {
        throw new Error('unused');
      },
      async authenticate() {
        return context;
      },
      async revoke() {
        revocations++;
        throw new Error('private database detail');
      },
    },
  });
  t.after(() => app.close());
  const wrongCsrf = await app.inject({
    method: 'POST',
    url: administratorSessionRoutePaths.logout,
    headers: headers({ 'x-csrf-token': 'x'.repeat(43) }),
  });
  assert.equal(wrongCsrf.statusCode, 403);
  assert.equal(wrongCsrf.headers['set-cookie'], undefined);
  const failed = await app.inject({
    method: 'POST',
    url: administratorSessionRoutePaths.logout,
    headers: headers({ 'x-csrf-token': csrfToken }),
  });
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.headers['set-cookie'], undefined);
  assert.deepEqual(failed.json(), { error: 'Logout unavailable' });
  assert.equal(revocations, 1);
});

void test('logout treats an unconfirmed revocation as an invalid session', async (t) => {
  const { app } = createRouteApp({
    sessionStore: {
      async issue() {
        throw new Error('unused');
      },
      async authenticate() {
        return context;
      },
      async revoke() {
        return false;
      },
    },
  });
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: administratorSessionRoutePaths.logout,
    headers: headers({ 'x-csrf-token': csrfToken }),
  });
  assert.equal(response.statusCode, 401);
  assert.equal(
    response.headers['set-cookie'],
    `${cookieName}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`,
  );
  assert.deepEqual(response.json(), { error: 'Authentication required' });
});

void test('refuses browser route registration on a default Fastify host', async () => {
  const app = Fastify({ logger: false });
  assert.throws(
    () =>
      registerAdministratorSessionRoutes(app, {
        verifyLoginRequest: async () => ({ actorId }),
        sessionStore: {
          async issue() {
            throw new Error('unused');
          },
          async authenticate() {
            return undefined;
          },
          async revoke() {
            return false;
          },
        },
        invitationStore: {
          async accept() {
            throw new Error('unused');
          },
        },
        sessionConfiguration,
        externalOrigin: origin,
      }),
    { message: 'HTTP_LOGGING_CONFIGURATION' },
  );
  await app.close();
});
