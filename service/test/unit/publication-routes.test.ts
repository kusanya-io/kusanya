import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import {
  publicationRoutePaths,
  registerPublicationRoutes,
  type PublicationRouteDependencies,
} from '../../src/publication/publication-routes.js';
import type { publishTenantSalesforceDefinition } from '../../src/publication/tenant-salesforce-publisher.js';

const tenantId = '10000000-0000-4000-8000-000000000001';
const otherTenantId = '20000000-0000-4000-8000-000000000002';
const orgId = '00D000000000001EAA';
const formVersionId = 'a0B000000000001AAA';
const attemptId = '10000000-0000-4000-8000-000000000009';
const session = 's'.repeat(43);
const csrf = 'c'.repeat(43);
const digest = 'd'.repeat(64);
const config = readConfig({ DATABASE_URL: 'postgresql://localhost/kusanya' });

const context = (
  selectedTenant = tenantId,
  role: 'administrator' | 'publisher' | 'reviewer' = 'administrator',
) => ({
  actorId: 'oidc:synthetic',
  tenantId: selectedTenant,
  expectedSalesforceOrgId: orgId,
  authorizationOrigin: 'https://login.salesforce.com',
  namespacePrefix: 'ksny__',
  role,
  csrfToken: csrf,
});

function dependencies(
  publisher: typeof publishTenantSalesforceDefinition,
  selectedTenant = tenantId,
  role: 'administrator' | 'publisher' | 'reviewer' = 'administrator',
) {
  const events: unknown[] = [];
  const value: PublicationRouteDependencies = {
    authenticateAdministrator: async (opaque) => {
      events.push(['authenticate', opaque]);
      return context(selectedTenant, role);
    },
    connectionStore: {} as PublicationRouteDependencies['connectionStore'],
    attemptStore: {
      async start(trusted, version) {
        events.push(['start', trusted.tenantId, version]);
        return attemptId;
      },
      async complete(id, tenant, completion) {
        events.push(['complete', id, tenant, completion]);
      },
    },
    publisherConfiguration: {
      clientId: 'client',
      clientSecret: 'secret',
      refreshTimeoutMs: 100,
      perRequestTimeoutMs: 100,
      overallTimeoutMs: 1_000,
    },
    validateXForm: async () => ({ ok: true }),
    externalOrigin: 'https://service.example',
    publisher,
  };
  return { value, events };
}

function requestHeaders(extra: Record<string, string> = {}) {
  return {
    origin: 'https://service.example',
    cookie: `__Host-kusanya_admin_session=${session}`,
    'x-csrf-token': csrf,
    ...extra,
  };
}

void test('publishes only from the live session tenant and durably completes success', async (t) => {
  const publisher = (async (_store, trusted) => {
    assert.equal(trusted.tenantId, otherTenantId);
    return {
      ok: true,
      publicationDigest: digest,
      alreadyCommitted: false,
      requestCount: 7,
    } as const;
  }) as typeof publishTenantSalesforceDefinition;
  const setup = dependencies(publisher, otherTenantId);
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  t.after(() => app.close());
  registerPublicationRoutes(app, setup.value);
  const response = await app.inject({
    method: 'POST',
    url: publicationRoutePaths.publish,
    headers: requestHeaders({ 'x-tenant-id': tenantId }),
    payload: { formVersionId },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    status: 'published',
    attemptId,
    publicationDigest: digest,
    alreadyCommitted: false,
    salesforceRequestCount: 7,
  });
  assert.deepEqual(setup.events, [
    ['authenticate', session],
    ['start', otherTenantId, formVersionId],
    [
      'complete',
      attemptId,
      otherTenantId,
      {
        outcome: 'succeeded',
        publicationDigest: digest,
        salesforceRequestCount: 7,
      },
    ],
  ]);
});

void test('permits publishers and refuses reviewers before starting an attempt', async (t) => {
  let calls = 0;
  const publisher = (async () => {
    calls++;
    return {
      ok: true,
      publicationDigest: digest,
      alreadyCommitted: false,
      requestCount: 1,
    } as const;
  }) as typeof publishTenantSalesforceDefinition;
  const publisherSetup = dependencies(publisher, tenantId, 'publisher');
  const publisherApp = createApp(
    config,
    { async ping() {}, async close() {} },
    false,
  );
  t.after(() => publisherApp.close());
  registerPublicationRoutes(publisherApp, publisherSetup.value);
  assert.equal(
    (
      await publisherApp.inject({
        method: 'POST',
        url: publicationRoutePaths.publish,
        headers: requestHeaders(),
        payload: { formVersionId },
      })
    ).statusCode,
    200,
  );

  const reviewerSetup = dependencies(publisher, tenantId, 'reviewer');
  const reviewerApp = createApp(
    config,
    { async ping() {}, async close() {} },
    false,
  );
  t.after(() => reviewerApp.close());
  registerPublicationRoutes(reviewerApp, reviewerSetup.value);
  const refused = await reviewerApp.inject({
    method: 'POST',
    url: publicationRoutePaths.publish,
    headers: requestHeaders(),
    payload: { formVersionId },
  });
  assert.equal(refused.statusCode, 403);
  assert.deepEqual(refused.json(), { error: 'Request rejected' });
  assert.equal(
    reviewerSetup.events.some(
      (event) => Array.isArray(event) && event[0] === 'start',
    ),
    false,
  );
  assert.equal(calls, 1);
});

void test('records exact artifacts and gives partial publication a distinct operator state', async (t) => {
  const publisher = (async (
    _store,
    _trusted,
    _config,
    _request,
    _validate,
    _fetch,
    recordPartial,
  ) => {
    await recordPartial?.({
      publicationDigest: digest,
      xformVersionId: '068000000000001AAA',
      xlsformVersionId: '068000000000002AAA',
      requestCount: 8,
    });
    return {
      ok: false,
      diagnostics: [
        { code: 'PUBLICATION_PUBLISHER_PARTIAL', location: 'publisher' },
      ],
      requestCount: 8,
    } as const;
  }) as typeof publishTenantSalesforceDefinition;
  const setup = dependencies(publisher);
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  t.after(() => app.close());
  registerPublicationRoutes(app, setup.value);
  const response = await app.inject({
    method: 'POST',
    url: publicationRoutePaths.publish,
    headers: requestHeaders(),
    payload: { formVersionId },
  });
  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.json(), {
    status: 'partial',
    attemptId,
    error: 'Publication outcome requires reconciliation',
    salesforceRequestCount: 8,
  });
  assert.deepEqual(setup.events[2], [
    'complete',
    attemptId,
    tenantId,
    {
      outcome: 'partial',
      failureCode: 'PUBLICATION_PUBLISHER_PARTIAL',
      publicationDigest: digest,
      xformVersionId: '068000000000001AAA',
      xlsformVersionId: '068000000000002AAA',
      salesforceRequestCount: 8,
    },
  ]);
});

void test('rejects bad CSRF before starting an attempt or calling the publisher', async (t) => {
  let called = false;
  const publisher = (async () => {
    called = true;
    throw new Error('must not run');
  }) as typeof publishTenantSalesforceDefinition;
  const setup = dependencies(publisher);
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  t.after(() => app.close());
  registerPublicationRoutes(app, setup.value);
  const response = await app.inject({
    method: 'POST',
    url: publicationRoutePaths.publish,
    headers: requestHeaders({ 'x-csrf-token': 'x'.repeat(43) }),
    payload: { formVersionId },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(called, false);
  assert.deepEqual(setup.events, [['authenticate', session]]);
});

void test('records clean refusals once and does not disguise them as partial', async (t) => {
  const publisher = (async () => ({
    ok: false,
    diagnostics: [
      { code: 'TENANT_PUBLICATION_NOT_CONNECTED', location: 'publisher' },
    ],
    requestCount: 0,
  })) as typeof publishTenantSalesforceDefinition;
  const setup = dependencies(publisher);
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  t.after(() => app.close());
  registerPublicationRoutes(app, setup.value);
  const response = await app.inject({
    method: 'POST',
    url: publicationRoutePaths.publish,
    headers: requestHeaders(),
    payload: { formVersionId },
  });
  assert.equal(response.statusCode, 422);
  assert.deepEqual(response.json(), {
    status: 'rejected',
    attemptId,
    diagnostics: [
      { code: 'TENANT_PUBLICATION_NOT_CONNECTED', location: 'publisher' },
    ],
    salesforceRequestCount: 0,
  });
  assert.deepEqual(setup.events[2], [
    'complete',
    attemptId,
    tenantId,
    {
      outcome: 'failed',
      failureCode: 'TENANT_PUBLICATION_NOT_CONNECTED',
      salesforceRequestCount: 0,
    },
  ]);
});

void test('rejects malformed authority before any durable attempt or publication', async (t) => {
  let called = false;
  const publisher = (async () => {
    called = true;
    throw new Error('must not run');
  }) as typeof publishTenantSalesforceDefinition;
  const setup = dependencies(publisher);
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  t.after(() => app.close());
  registerPublicationRoutes(app, setup.value);
  for (const request of [
    {
      headers: requestHeaders({ origin: 'https://attacker.example' }),
      payload: { formVersionId },
    },
    {
      headers: requestHeaders(),
      payload: { formVersionId, tenantId },
    },
    {
      headers: requestHeaders({
        cookie: `__Host-kusanya_admin_session=${session}; __Host-kusanya_admin_session=${session}`,
      }),
      payload: { formVersionId },
    },
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: publicationRoutePaths.publish,
      ...request,
    });
    assert.ok(response.statusCode === 400 || response.statusCode === 401);
  }
  assert.equal(called, false);
  assert.equal(
    setup.events.some((event) => Array.isArray(event) && event[0] === 'start'),
    false,
  );
});

void test('refuses mounting on a host whose logger can serialize the request URL', () => {
  const app = Fastify({ logger: true });
  const setup = dependencies(async () => {
    throw new Error();
  });
  assert.throws(
    () => registerPublicationRoutes(app, setup.value),
    /HTTP_LOGGING_CONFIGURATION/,
  );
  return app.close();
});
