import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import {
  administratorProvisioningRoutePaths,
  registerAdministratorProvisioningRoutes,
  type AdministratorProvisioningRouteDependencies,
} from '../../src/tenant/administrator-provisioning-routes.js';
import { AdministratorSessionError } from '../../src/tenant/administrator-session.js';
import { administratorOidcActorId } from '../../src/tenant/oidc-login.js';

const config = readConfig({ DATABASE_URL: 'postgresql://localhost/kusanya' });
const externalOrigin = 'https://kusanya.example';
const issuer = 'https://login.example/tenant/v2.0';
const opaqueSession = 's'.repeat(43);
const csrfToken = 'c'.repeat(43);
const trusted = Object.freeze({
  actorId: administratorOidcActorId(issuer, 'current-subject'),
  tenantId: '10000000-0000-4000-8000-000000000001',
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
): AdministratorProvisioningRouteDependencies & {
  readonly events: unknown[];
} {
  const events: unknown[] = [];
  return {
    events,
    externalOrigin,
    async authenticateAdministrator(value) {
      events.push(['authenticate', value]);
      return { ...trusted, role };
    },
    actorIdForSubject(subject) {
      events.push(['derive', subject]);
      return administratorOidcActorId(issuer, subject);
    },
    sessionStore: {
      async deprovision(input) {
        events.push(['deprovision', input]);
      },
      async changeRole(input) {
        events.push(['change-role', input]);
      },
    },
  };
}

void test('deprovisions only an OIDC-derived actor from the live session tenant', async (t) => {
  const setup = dependencies();
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  t.after(() => app.close());
  registerAdministratorProvisioningRoutes(app, setup);

  const response = await app.inject({
    method: 'DELETE',
    url: administratorProvisioningRoutePaths.provision,
    headers: headers({
      'x-actor-id': 'forged',
      'x-tenant-id': '20000000-0000-4000-8000-000000000002',
    }),
    payload: { subject: 'departing-subject' },
  });
  assert.equal(response.statusCode, 204);
  assert.deepEqual(setup.events, [
    ['authenticate', opaqueSession],
    ['derive', 'departing-subject'],
    [
      'deprovision',
      {
        performedByActorId: trusted.actorId,
        targetActorId: administratorOidcActorId(issuer, 'departing-subject'),
        tenantId: trusted.tenantId,
      },
    ],
  ]);
});

void test('authenticates and checks CSRF before deriving or mutating', async (t) => {
  const setup = dependencies();
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  t.after(() => app.close());
  registerAdministratorProvisioningRoutes(app, setup);
  for (const method of ['DELETE', 'PATCH'] as const)
    for (const request of [
      { headers: headers({ origin: 'https://attacker.example' }) },
      { headers: { ...headers(), cookie: '' } },
      {
        headers: {
          ...headers(),
          cookie: `__Host-kusanya_admin_session=${opaqueSession}; __Host-kusanya_admin_session=${opaqueSession}`,
        },
      },
      { headers: headers({ 'x-csrf-token': 'x'.repeat(43) }) },
      { headers: headers({ 'x-csrf-token': 'x' }) },
    ]) {
      setup.events.length = 0;
      const response = await app.inject({
        method,
        url: administratorProvisioningRoutePaths.provision,
        payload:
          method === 'DELETE'
            ? { subject: 'peer-subject' }
            : { subject: 'peer-subject', role: 'reviewer' },
        ...request,
      });
      assert.ok([400, 401, 403].includes(response.statusCode));
      assert.equal(
        setup.events.some(
          (event) =>
            Array.isArray(event) &&
            ['derive', 'deprovision', 'change-role'].includes(String(event[0])),
        ),
        false,
      );
      assert.doesNotMatch(response.body, /subject|tenant|actor|00D/i);
    }
});

void test('makes absent, last, self and cross-tenant removals indistinguishable', async (t) => {
  for (const error of [
    new AdministratorSessionError('ADMINISTRATOR_SESSION_CONFLICT'),
    new Error('confidential target does not exist'),
  ]) {
    const setup = dependencies();
    setup.sessionStore.deprovision = async () => {
      throw error;
    };
    const app = createApp(config, { async ping() {}, async close() {} }, false);
    t.after(() => app.close());
    registerAdministratorProvisioningRoutes(app, setup);
    const response = await app.inject({
      method: 'DELETE',
      url: administratorProvisioningRoutePaths.provision,
      headers: headers(),
      payload: { subject: 'confidential-target' },
    });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { error: 'Provisioning unavailable' });
    assert.doesNotMatch(
      response.body,
      /last|self|confidential|tenant|subject/i,
    );
  }
});

void test('changes only a peer role and denies lifecycle access to lower roles', async (t) => {
  const setup = dependencies();
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  t.after(() => app.close());
  registerAdministratorProvisioningRoutes(app, setup);

  const changed = await app.inject({
    method: 'PATCH',
    url: administratorProvisioningRoutePaths.provision,
    headers: headers(),
    payload: { subject: 'peer-subject', role: 'reviewer' },
  });
  assert.equal(changed.statusCode, 204);
  assert.deepEqual(setup.events.slice(-2), [
    ['derive', 'peer-subject'],
    [
      'change-role',
      {
        performedByActorId: trusted.actorId,
        targetActorId: administratorOidcActorId(issuer, 'peer-subject'),
        tenantId: trusted.tenantId,
        role: 'reviewer',
      },
    ],
  ]);

  for (const role of ['publisher', 'reviewer'] as const) {
    const denied = dependencies(role);
    const deniedApp = createApp(
      config,
      { async ping() {}, async close() {} },
      false,
    );
    t.after(() => deniedApp.close());
    registerAdministratorProvisioningRoutes(deniedApp, denied);
    for (const method of ['DELETE', 'PATCH'] as const) {
      denied.events.length = 0;
      const response = await deniedApp.inject({
        method,
        url: administratorProvisioningRoutePaths.provision,
        headers: headers(),
        payload:
          method === 'DELETE'
            ? { subject: 'peer-subject' }
            : { subject: 'peer-subject', role: 'reviewer' },
      });
      assert.equal(response.statusCode, 403);
      assert.deepEqual(response.json(), { error: 'Request rejected' });
      assert.equal(
        denied.events.some(
          (event) =>
            Array.isArray(event) &&
            ['derive', 'deprovision', 'change-role'].includes(String(event[0])),
        ),
        false,
      );
    }
  }
});

void test('removes direct enrolment and refuses hostile selectors', async (t) => {
  const setup = dependencies();
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  t.after(() => app.close());
  registerAdministratorProvisioningRoutes(app, setup);
  const direct = await app.inject({
    method: 'POST',
    url: administratorProvisioningRoutePaths.provision,
    headers: headers(),
    payload: { subject: 'new-subject', role: 'publisher' },
  });
  assert.equal(direct.statusCode, 404);
  for (const body of [
    {},
    { subject: 'peer-subject', role: 'owner' },
    { subject: 'peer-subject', role: 'reviewer', tenantId: trusted.tenantId },
  ]) {
    const response = await app.inject({
      method: 'PATCH',
      url: administratorProvisioningRoutePaths.provision,
      headers: headers(),
      payload: body,
    });
    assert.equal(response.statusCode, 400);
  }
  const query = await app.inject({
    method: 'DELETE',
    url: `${administratorProvisioningRoutePaths.provision}?tenant=other`,
    headers: headers(),
    payload: { subject: 'peer-subject' },
  });
  assert.equal(query.statusCode, 400);
});

void test('exposes no alternate mutation method and refuses an unhardened host', async (t) => {
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  t.after(() => app.close());
  registerAdministratorProvisioningRoutes(app, dependencies());
  for (const method of ['GET', 'PUT'] as const) {
    const response = await app.inject({
      method,
      url: administratorProvisioningRoutePaths.provision,
      headers: headers(),
    });
    assert.ok([400, 404].includes(response.statusCode));
  }
  const bootstrap = await app.inject({
    method: 'POST',
    url: `${administratorProvisioningRoutePaths.provision}/bootstrap`,
    headers: headers(),
    payload: { subject: 'first-administrator' },
  });
  assert.equal(bootstrap.statusCode, 404);

  const unsafe = Fastify({ logger: true });
  assert.throws(
    () => registerAdministratorProvisioningRoutes(unsafe, dependencies()),
    /HTTP_LOGGING_CONFIGURATION/,
  );
  await unsafe.close();
});
