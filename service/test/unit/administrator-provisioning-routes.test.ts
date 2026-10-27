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
import {
  AdministratorSessionError,
  type AdministratorProvisioningInput,
} from '../../src/tenant/administrator-session.js';
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

function dependencies(): AdministratorProvisioningRouteDependencies & {
  readonly events: unknown[];
} {
  const events: unknown[] = [];
  return {
    events,
    externalOrigin,
    async authenticateAdministrator(value) {
      events.push(['authenticate', value]);
      return trusted;
    },
    actorIdForSubject(subject) {
      events.push(['derive', subject]);
      return administratorOidcActorId(issuer, subject);
    },
    sessionStore: {
      async provision(input) {
        events.push(['provision', input]);
      },
    },
  };
}

void test('enrolls only an OIDC-derived actor into the live session tenant', async (t) => {
  const setup = dependencies();
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  t.after(() => app.close());
  registerAdministratorProvisioningRoutes(app, setup);

  const response = await app.inject({
    method: 'POST',
    url: administratorProvisioningRoutePaths.provision,
    headers: headers({
      'x-actor-id': 'forged',
      'x-tenant-id': '20000000-0000-4000-8000-000000000002',
    }),
    payload: { subject: 'new-subject' },
  });
  assert.equal(response.statusCode, 204);
  assert.deepEqual(setup.events.slice(0, 2), [
    ['authenticate', opaqueSession],
    ['derive', 'new-subject'],
  ]);
  const provisioned = (setup.events[2] as ['provision', unknown])[1];
  assert.deepEqual(provisioned, {
    actorId: administratorOidcActorId(issuer, 'new-subject'),
    tenantId: trusted.tenantId,
    expectedSalesforceOrgId: trusted.expectedSalesforceOrgId,
    authorizationOrigin: trusted.authorizationOrigin,
    namespacePrefix: trusted.namespacePrefix,
  });
  assert.equal(
    Object.keys(provisioned as AdministratorProvisioningInput).includes(
      'subject',
    ),
    false,
  );
});

void test('authenticates and checks CSRF before deriving or provisioning', async (t) => {
  const setup = dependencies();
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  t.after(() => app.close());
  registerAdministratorProvisioningRoutes(app, setup);
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
      method: 'POST',
      url: administratorProvisioningRoutePaths.provision,
      payload: { subject: 'new-subject' },
      ...request,
    });
    assert.ok([400, 401, 403].includes(response.statusCode));
    assert.equal(
      setup.events.some(
        (event) =>
          Array.isArray(event) &&
          typeof event[0] === 'string' &&
          ['derive', 'provision'].includes(event[0]),
      ),
      false,
    );
    assert.doesNotMatch(response.body, /subject|tenant|actor|00D/i);
  }
});

void test('refuses selectors and hostile subjects without widening the tenant tuple', async (t) => {
  const setup = dependencies();
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  t.after(() => app.close());
  registerAdministratorProvisioningRoutes(app, setup);
  const bodies = [
    {},
    { actorId: 'oidc:forged' },
    { subject: 'new-subject', actorId: 'oidc:forged' },
    { subject: 'new-subject', tenantId: trusted.tenantId },
    { subject: 'new-subject', expectedSalesforceOrgId: '00D000000000002EAA' },
    { subject: null },
    { subject: '' },
    { subject: 'x'.repeat(513) },
    { subject: 'line\nbreak' },
  ];
  for (const body of bodies) {
    setup.events.length = 0;
    const response = await app.inject({
      method: 'POST',
      url: administratorProvisioningRoutePaths.provision,
      headers: headers(),
      payload: body,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(
      setup.events.some(
        (event) => Array.isArray(event) && event[0] === 'provision',
      ),
      false,
    );
  }
  const query = await app.inject({
    method: 'POST',
    url: `${administratorProvisioningRoutePaths.provision}?tenant=other`,
    headers: headers(),
    payload: { subject: 'new-subject' },
  });
  assert.equal(query.statusCode, 400);
});

void test('makes cross-tenant conflicts indistinguishable from storage failures', async (t) => {
  for (const error of [
    new AdministratorSessionError('ADMINISTRATOR_SESSION_CONFLICT'),
    new Error('actor already belongs to confidential tenant'),
  ]) {
    const setup = dependencies();
    setup.sessionStore.provision = async () => {
      throw error;
    };
    const app = createApp(config, { async ping() {}, async close() {} }, false);
    t.after(() => app.close());
    registerAdministratorProvisioningRoutes(app, setup);
    const response = await app.inject({
      method: 'POST',
      url: administratorProvisioningRoutePaths.provision,
      headers: headers(),
      payload: { subject: 'already-bound-subject' },
    });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { error: 'Provisioning unavailable' });
    assert.doesNotMatch(response.body, /already|confidential|tenant|subject/i);
  }
});

void test('exposes no alternate mutation method and refuses an unhardened host', async (t) => {
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  t.after(() => app.close());
  registerAdministratorProvisioningRoutes(app, dependencies());
  for (const method of ['GET', 'PUT', 'PATCH', 'DELETE'] as const) {
    const response = await app.inject({
      method,
      url: administratorProvisioningRoutePaths.provision,
      headers: headers(),
    });
    assert.ok(
      [400, 404].includes(response.statusCode),
      `${method}: ${response.body}`,
    );
  }

  const unsafe = Fastify({ logger: true });
  assert.throws(
    () => registerAdministratorProvisioningRoutes(unsafe, dependencies()),
    /HTTP_LOGGING_CONFIGURATION/,
  );
  await unsafe.close();
});
