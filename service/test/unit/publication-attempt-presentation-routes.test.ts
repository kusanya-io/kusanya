import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import {
  publicationAttemptPresentationRoutePaths,
  registerPublicationAttemptPresentationRoutes,
  type PublicationAttemptPresentationRouteDependencies,
} from '../../src/publication/publication-attempt-presentation-routes.js';
import { AdministratorSessionError } from '../../src/tenant/administrator-session.js';

const tenantId = '10000000-0000-4000-8000-000000000001';
const otherTenantId = '20000000-0000-4000-8000-000000000002';
const session = 's'.repeat(43);
const csrf = 'c'.repeat(43);
const config = readConfig({ DATABASE_URL: 'postgresql://localhost/kusanya' });
const cursor = Buffer.from(
  ['2026-10-22T10:00:00.000000Z', '10000000-0000-4000-8000-000000000009'].join(
    '\0',
  ),
).toString('base64url');

const trusted = (
  selectedTenant = tenantId,
  role: 'administrator' | 'publisher' | 'reviewer' = 'administrator',
) => ({
  actorId: `oidc:${selectedTenant.slice(0, 8)}`,
  tenantId: selectedTenant,
  expectedSalesforceOrgId: '00D000000000001EAA',
  authorizationOrigin: 'https://login.salesforce.com',
  namespacePrefix: 'ksny__',
  role,
  csrfToken: csrf,
});

function headers(extra: Record<string, string> = {}) {
  return {
    origin: 'https://service.example',
    cookie: `__Host-kusanya_admin_session=${session}`,
    'x-csrf-token': csrf,
    ...extra,
  };
}

function dependencies(
  selectedTenant = tenantId,
  role: 'administrator' | 'publisher' | 'reviewer' = 'administrator',
): PublicationAttemptPresentationRouteDependencies & {
  events: unknown[];
} {
  const events: unknown[] = [];
  return {
    events,
    externalOrigin: 'https://service.example',
    async authenticateAdministrator(value) {
      events.push(['authenticate', value]);
      return trusted(selectedTenant, role);
    },
    attemptStore: {
      async listForOperator(context, cursor) {
        events.push(['list', context, cursor]);
        return {
          attempts: [
            {
              attemptId: '10000000-0000-4000-8000-000000000009',
              formVersionId: 'a0B000000000001AAA',
              operatorStatus: 'human_judgement_required_indeterminate',
              startedAt: '2026-10-22T10:00:00.000Z',
              completedAt: null,
              reconciledAt: '2026-10-22T10:01:00.000Z',
              credential: 'must-never-serialize',
            } as never,
          ],
          nextCursor: null,
        };
      },
    },
  };
}

void test('lists only the live session tenant through a least-data schema', async (t) => {
  const setup = dependencies(otherTenantId);
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  t.after(() => app.close());
  registerPublicationAttemptPresentationRoutes(app, setup);

  const response = await app.inject({
    method: 'GET',
    url: publicationAttemptPresentationRoutePaths.list,
    headers: headers({ 'x-tenant-id': tenantId }),
  });
  assert.equal(
    response.statusCode,
    200,
    `${response.body}; events=${JSON.stringify(setup.events)}`,
  );
  assert.deepEqual(response.json(), {
    attempts: [
      {
        attemptId: '10000000-0000-4000-8000-000000000009',
        formVersionId: 'a0B000000000001AAA',
        operatorStatus: 'human_judgement_required_indeterminate',
        startedAt: '2026-10-22T10:00:00.000Z',
        completedAt: null,
        reconciledAt: '2026-10-22T10:01:00.000Z',
      },
    ],
    nextCursor: null,
  });
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(setup.events[0], ['authenticate', session]);
  assert.equal((setup.events[1] as unknown[])[0], 'list');
  assert.equal(
    ((setup.events[1] as unknown[])[1] as { tenantId: string }).tenantId,
    otherTenantId,
  );
  assert.doesNotMatch(response.body, /credential|provider|digest|content/i);
});

void test('permits a reviewer to read only the tenant-scoped operator history', async (t) => {
  const setup = dependencies(tenantId, 'reviewer');
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  t.after(() => app.close());
  registerPublicationAttemptPresentationRoutes(app, setup);
  const response = await app.inject({
    method: 'GET',
    url: publicationAttemptPresentationRoutePaths.list,
    headers: headers(),
  });
  assert.equal(response.statusCode, 200);
  assert.equal(
    setup.events.some((event) => Array.isArray(event) && event[0] === 'list'),
    true,
  );
});

void test('requires exact origin, session and CSRF before the single read', async (t) => {
  const setup = dependencies();
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  t.after(() => app.close());
  registerPublicationAttemptPresentationRoutes(app, setup);

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
      url: `${publicationAttemptPresentationRoutePaths.list}?tenant=${tenantId}`,
    },
    { headers: headers(), payload: { tenantId } },
  ];
  for (const [index, value] of requests.entries()) {
    const response = await app.inject({
      method: 'GET',
      url: publicationAttemptPresentationRoutePaths.list,
      ...value,
    });
    assert.ok(
      [400, 401, 403, 415].includes(response.statusCode),
      `hostile request ${index} returned ${response.statusCode}`,
    );
  }
  assert.equal(
    setup.events.some((event) => Array.isArray(event) && event[0] === 'list'),
    false,
  );
});

void test('accepts only one opaque cursor after authentication and keeps the page bounded', async (t) => {
  const setup = dependencies();
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  t.after(() => app.close());
  registerPublicationAttemptPresentationRoutes(app, setup);
  const response = await app.inject({
    method: 'GET',
    url: `${publicationAttemptPresentationRoutePaths.list}?cursor=${cursor}`,
    headers: headers(),
  });
  assert.equal(
    response.statusCode,
    200,
    `${response.body}; events=${JSON.stringify(setup.events)}`,
  );
  assert.equal((setup.events[1] as unknown[])[2], cursor);

  for (const query of [
    'cursor=x',
    `cursor=${cursor}&cursor=${cursor}`,
    `cursor=${cursor}&tenant=${tenantId}`,
  ]) {
    setup.events.length = 0;
    const refused = await app.inject({
      method: 'GET',
      url: `${publicationAttemptPresentationRoutePaths.list}?${query}`,
      headers: headers(),
    });
    assert.equal(refused.statusCode, 400);
    assert.deepEqual(
      setup.events.map((event) => (event as unknown[])[0]),
      ['authenticate'],
    );
  }
});

void test('has no mutation method and normalizes storage failures', async (t) => {
  const base = dependencies();
  const setup: PublicationAttemptPresentationRouteDependencies = {
    ...base,
    attemptStore: {
      async listForOperator() {
        throw new Error('synthetic confidential provider details');
      },
    },
  };
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  t.after(() => app.close());
  registerPublicationAttemptPresentationRoutes(app, setup);

  const response = await app.inject({
    method: 'GET',
    url: publicationAttemptPresentationRoutePaths.list,
    headers: headers(),
  });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), {
    error: 'Publication history unavailable',
  });
  assert.doesNotMatch(response.body, /synthetic|provider|details/i);

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    const mutation = await app.inject({
      method,
      url: publicationAttemptPresentationRoutePaths.list,
      headers: headers(),
      payload: {},
    });
    assert.equal(mutation.statusCode, 404);
  }
});

void test('distinguishes invalid authentication from unavailable session storage', async (t) => {
  for (const [error, expected] of [
    [new AdministratorSessionError('ADMINISTRATOR_SESSION_ABSENT'), 401],
    [new AdministratorSessionError('ADMINISTRATOR_SESSION_STORAGE'), 503],
  ] as const) {
    const base = dependencies();
    const setup: PublicationAttemptPresentationRouteDependencies = {
      ...base,
      async authenticateAdministrator() {
        throw error;
      },
    };
    const app = createApp(config, { async ping() {}, async close() {} }, false);
    t.after(() => app.close());
    registerPublicationAttemptPresentationRoutes(app, setup);
    const response = await app.inject({
      method: 'GET',
      url: publicationAttemptPresentationRoutePaths.list,
      headers: headers(),
    });
    assert.equal(response.statusCode, expected);
    assert.doesNotMatch(response.body, /ADMINISTRATOR_SESSION/);
  }
});

void test('refuses mounting on a host whose logger can serialize the request URL', () => {
  const app = Fastify({ logger: true });
  assert.throws(
    () => registerPublicationAttemptPresentationRoutes(app, dependencies()),
    /HTTP_LOGGING_CONFIGURATION/,
  );
  return app.close();
});
