import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import {
  administratorInvitationRoutePaths,
  registerAdministratorInvitationRoutes,
  type AdministratorInvitationRouteDependencies,
} from '../../src/tenant/administrator-invitation-routes.js';
import { administratorOidcActorId } from '../../src/tenant/oidc-login.js';

const config = readConfig({ DATABASE_URL: 'postgresql://localhost/kusanya' });
const externalOrigin = 'https://kusanya.example';
const issuer = 'https://login.example/tenant/v2.0';
const opaqueSession = 's'.repeat(43);
const csrfToken = 'c'.repeat(43);
const invitationId = '10000000-0000-4000-8000-000000000001';
const invitationToken = 'i'.repeat(43);
const trusted = Object.freeze({
  actorId: administratorOidcActorId(issuer, 'current-subject'),
  tenantId: '20000000-0000-4000-8000-000000000002',
  expectedSalesforceOrgId: '00D000000000001EAA',
  authorizationOrigin: 'https://login.salesforce.com',
  namespacePrefix: 'ksny__',
  role: 'administrator' as const,
  csrfToken,
});

function headers(extra: Record<string, string> = {}) {
  return {
    origin: externalOrigin,
    cookie: `__Host-kusanya_admin_session=${opaqueSession}`,
    'x-csrf-token': csrfToken,
    'content-type': 'application/json',
    ...extra,
  };
}

function dependencies(
  role: 'administrator' | 'publisher' | 'reviewer' = 'administrator',
): AdministratorInvitationRouteDependencies & { readonly events: unknown[] } {
  const events: unknown[] = [];
  return {
    events,
    externalOrigin,
    invitationConfiguration: { ttlSeconds: 3600 },
    async authenticateAdministrator(value) {
      events.push(['authenticate', value]);
      return { ...trusted, role };
    },
    actorIdForSubject(subject) {
      events.push(['derive', subject]);
      return administratorOidcActorId(issuer, subject);
    },
    invitationStore: {
      async issue(input, configuration) {
        events.push(['issue', input, configuration]);
        return { invitationId, invitationToken, expiresInSeconds: 3600 };
      },
      async revoke(input) {
        events.push(['revoke', input]);
      },
    },
  };
}

void test('issues one opaque invitation for an OIDC-derived target and live tenant', async (t) => {
  const setup = dependencies();
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  t.after(() => app.close());
  registerAdministratorInvitationRoutes(app, setup);
  const response = await app.inject({
    method: 'POST',
    url: administratorInvitationRoutePaths.invitations,
    headers: headers({ 'x-tenant-id': 'forged', 'x-actor-id': 'forged' }),
    payload: { subject: 'future-operator', role: 'publisher' },
  });
  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.json(), {
    invitationId,
    invitationToken,
    expiresInSeconds: 3600,
  });
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(setup.events, [
    ['authenticate', opaqueSession],
    ['derive', 'future-operator'],
    [
      'issue',
      {
        performedByActorId: trusted.actorId,
        targetActorId: administratorOidcActorId(issuer, 'future-operator'),
        tenantId: trusted.tenantId,
        role: 'publisher',
      },
      { ttlSeconds: 3600 },
    ],
  ]);
});

void test('revokes idempotently by opaque id without accepting tenant selectors', async (t) => {
  const setup = dependencies();
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  t.after(() => app.close());
  registerAdministratorInvitationRoutes(app, setup);
  const response = await app.inject({
    method: 'DELETE',
    url: administratorInvitationRoutePaths.invitations,
    headers: headers(),
    payload: { invitationId },
  });
  assert.equal(response.statusCode, 204);
  assert.deepEqual(setup.events, [
    ['authenticate', opaqueSession],
    [
      'revoke',
      {
        performedByActorId: trusted.actorId,
        invitationId,
        tenantId: trusted.tenantId,
      },
    ],
  ]);
  const widened = await app.inject({
    method: 'DELETE',
    url: administratorInvitationRoutePaths.invitations,
    headers: headers(),
    payload: { invitationId, tenantId: trusted.tenantId },
  });
  assert.equal(widened.statusCode, 400);
});

void test('denies lower roles and validates origin, session and CSRF before subject derivation', async (t) => {
  for (const role of ['publisher', 'reviewer'] as const) {
    const setup = dependencies(role);
    const app = createApp(config, { async ping() {}, async close() {} }, false);
    t.after(() => app.close());
    registerAdministratorInvitationRoutes(app, setup);
    for (const method of ['POST', 'DELETE'] as const) {
      setup.events.length = 0;
      const response = await app.inject({
        method,
        url: administratorInvitationRoutePaths.invitations,
        headers: headers(),
        payload:
          method === 'POST'
            ? { subject: 'future-operator', role: 'reviewer' }
            : { invitationId },
      });
      assert.equal(response.statusCode, 403);
      assert.equal(
        setup.events.some(
          (event) =>
            Array.isArray(event) &&
            ['derive', 'issue', 'revoke'].includes(String(event[0])),
        ),
        false,
      );
    }
  }

  const setup = dependencies();
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  t.after(() => app.close());
  registerAdministratorInvitationRoutes(app, setup);
  for (const headersValue of [
    headers({ origin: 'https://evil.example' }),
    { ...headers(), cookie: '' },
    headers({ 'x-csrf-token': 'x'.repeat(43) }),
  ]) {
    setup.events.length = 0;
    const response = await app.inject({
      method: 'POST',
      url: administratorInvitationRoutePaths.invitations,
      headers: headersValue,
      payload: { subject: 'future-operator', role: 'reviewer' },
    });
    assert.ok([400, 401, 403].includes(response.statusCode));
    assert.equal(
      setup.events.some(
        (event) =>
          Array.isArray(event) &&
          ['derive', 'issue'].includes(String(event[0])),
      ),
      false,
    );
  }
});

void test('refuses role escalation, extra selectors, hostile subjects and alternate methods', async (t) => {
  const setup = dependencies();
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  t.after(() => app.close());
  registerAdministratorInvitationRoutes(app, setup);
  for (const body of [
    {},
    { subject: 'future-operator', role: 'owner' },
    {
      subject: 'future-operator',
      role: 'reviewer',
      tenantId: trusted.tenantId,
    },
    { subject: null, role: 'reviewer' },
    { subject: 'x'.repeat(513), role: 'reviewer' },
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: administratorInvitationRoutePaths.invitations,
      headers: headers(),
      payload: body,
    });
    assert.equal(response.statusCode, 400);
  }
  assert.equal(
    (
      await app.inject({
        method: 'GET',
        url: administratorInvitationRoutePaths.invitations,
        headers: headers(),
      })
    ).statusCode,
    404,
  );
  const unsafe = Fastify({ logger: true });
  assert.throws(
    () => registerAdministratorInvitationRoutes(unsafe, dependencies()),
    /HTTP_LOGGING_CONFIGURATION/,
  );
  await unsafe.close();
});
