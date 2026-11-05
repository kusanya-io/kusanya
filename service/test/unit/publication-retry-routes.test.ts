import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { PublicationAttemptRetryError } from '../../src/publication/publication-attempt-store.js';
import {
  publicationRetryRoutePaths,
  registerPublicationRetryRoutes,
  type PublicationRetryRouteDependencies,
} from '../../src/publication/publication-retry-routes.js';
import type { publishTenantSalesforceDefinition } from '../../src/publication/tenant-salesforce-publisher.js';

const tenantId = '10000000-0000-4000-8000-000000000001';
const sourceAttemptId = '10000000-0000-4000-8000-000000000009';
const retryAttemptId = '20000000-0000-4000-8000-000000000009';
const formVersionId = 'a0B000000000001AAA';
const session = 's'.repeat(43);
const csrf = 'c'.repeat(43);
const digest = 'd'.repeat(64);
const config = readConfig({ DATABASE_URL: 'postgresql://localhost/kusanya' });

function context(role: 'administrator' | 'publisher' | 'reviewer') {
  return {
    actorId: 'oidc:synthetic',
    tenantId,
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
  publisher: typeof publishTenantSalesforceDefinition = async () => ({
    ok: true,
    publicationDigest: digest,
    alreadyCommitted: false,
    requestCount: 4,
  }),
) {
  const events: unknown[] = [];
  const value: PublicationRetryRouteDependencies = {
    async authenticateAdministrator(value) {
      events.push(['authenticate', value]);
      return context(role);
    },
    connectionStore: {} as PublicationRetryRouteDependencies['connectionStore'],
    attemptStore: {
      async startRetry(trusted, source) {
        events.push(['startRetry', trusted.role, source]);
        return Object.freeze({
          attemptId: retryAttemptId,
          formVersionId,
        });
      },
      async complete(attempt, tenant, completion) {
        events.push(['complete', attempt, tenant, completion]);
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

void test('administrator retries an eligible source as a new durable attempt', async (t) => {
  let selectedVersion = '';
  const publisher = (async (_store, _trusted, _config, input) => {
    selectedVersion = input.formVersionId;
    return {
      ok: true,
      publicationDigest: digest,
      alreadyCommitted: false,
      requestCount: 4,
    } as const;
  }) as typeof publishTenantSalesforceDefinition;
  const setup = dependencies('administrator', publisher);
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  t.after(() => app.close());
  registerPublicationRetryRoutes(app, setup.value);

  const response = await app.inject({
    method: 'POST',
    url: publicationRetryRoutePaths.retry,
    headers: headers(),
    payload: { attemptId: sourceAttemptId },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(selectedVersion, formVersionId);
  assert.deepEqual(response.json(), {
    status: 'published',
    attemptId: retryAttemptId,
    publicationDigest: digest,
    alreadyCommitted: false,
    salesforceRequestCount: 4,
  });
  assert.deepEqual(setup.events, [
    ['authenticate', session],
    ['startRetry', 'administrator', sourceAttemptId],
    [
      'complete',
      retryAttemptId,
      tenantId,
      {
        outcome: 'succeeded',
        publicationDigest: digest,
        salesforceRequestCount: 4,
      },
    ],
  ]);
});

void test('publisher and reviewer are refused before retry storage or publication', async (t) => {
  for (const role of ['publisher', 'reviewer'] as const) {
    let calls = 0;
    const publisher = (async () => {
      calls++;
      throw new Error('not reached');
    }) as typeof publishTenantSalesforceDefinition;
    const setup = dependencies(role, publisher);
    const app = createApp(config, { async ping() {}, async close() {} }, false);
    t.after(() => app.close());
    registerPublicationRetryRoutes(app, setup.value);
    const response = await app.inject({
      method: 'POST',
      url: publicationRetryRoutePaths.retry,
      headers: headers(),
      payload: { attemptId: sourceAttemptId },
    });
    assert.equal(response.statusCode, 403);
    assert.deepEqual(
      setup.events.map((event) => (event as unknown[])[0]),
      ['authenticate'],
    );
    assert.equal(calls, 0);
  }
});

void test('ineligible and already-used sources are one fixed conflict', async (t) => {
  const setup = dependencies();
  setup.value.attemptStore.startRetry = async () => {
    throw new PublicationAttemptRetryError();
  };
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  t.after(() => app.close());
  registerPublicationRetryRoutes(app, setup.value);
  const response = await app.inject({
    method: 'POST',
    url: publicationRetryRoutePaths.retry,
    headers: headers(),
    payload: { attemptId: sourceAttemptId },
  });
  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.json(), { error: 'Publication retry refused' });
  assert.doesNotMatch(response.body, /eligible|already|tenant|source/i);
});

void test('validates origin, exact body, session and CSRF before retry storage', async (t) => {
  const setup = dependencies();
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  t.after(() => app.close());
  registerPublicationRetryRoutes(app, setup.value);
  const requests = [
    { headers: headers({ origin: 'https://attacker.example' }) },
    { headers: headers({ 'x-csrf-token': 'x'.repeat(43) }) },
    { headers: { ...headers(), cookie: '' } },
    { headers: headers(), payload: { attemptId: sourceAttemptId, tenantId } },
    { headers: headers(), payload: { attemptId: 'not-an-attempt-id' } },
    { headers: headers(), url: `${publicationRetryRoutePaths.retry}?retry=1` },
  ];
  for (const value of requests) {
    setup.events.length = 0;
    const response = await app.inject({
      method: 'POST',
      url: publicationRetryRoutePaths.retry,
      payload: { attemptId: sourceAttemptId },
      ...value,
    });
    assert.ok([400, 401, 403].includes(response.statusCode));
    assert.equal(
      setup.events.some(
        (event) => Array.isArray(event) && event[0] === 'startRetry',
      ),
      false,
    );
  }
});

void test('partial retry keeps the same durable reconciliation semantics', async (t) => {
  const publisher = (async (
    _store,
    _trusted,
    _configuration,
    _input,
    _validate,
    _fetch,
    recordPartial,
  ) => {
    await recordPartial?.({
      publicationDigest: digest,
      xformVersionId: '068000000000001AAA',
      xlsformVersionId: '068000000000002AAA',
      requestCount: 3,
    });
    return {
      ok: false,
      diagnostics: [
        { code: 'PUBLICATION_PUBLISHER_PARTIAL', location: 'publisher' },
      ],
      requestCount: 3,
    } as const;
  }) as typeof publishTenantSalesforceDefinition;
  const setup = dependencies('administrator', publisher);
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  t.after(() => app.close());
  registerPublicationRetryRoutes(app, setup.value);
  const response = await app.inject({
    method: 'POST',
    url: publicationRetryRoutePaths.retry,
    headers: headers(),
    payload: { attemptId: sourceAttemptId },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json<{ status: string }>().status, 'partial');
  assert.equal(
    setup.events.some(
      (event) =>
        Array.isArray(event) &&
        event[0] === 'complete' &&
        (event[3] as { outcome: string }).outcome === 'partial',
    ),
    true,
  );
});

void test('storage failures are fixed and unhardened hosts cannot mount retry', async (t) => {
  const setup = dependencies();
  setup.value.attemptStore.startRetry = async () => {
    throw new Error('synthetic confidential database details');
  };
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  t.after(() => app.close());
  registerPublicationRetryRoutes(app, setup.value);
  const response = await app.inject({
    method: 'POST',
    url: publicationRetryRoutePaths.retry,
    headers: headers(),
    payload: { attemptId: sourceAttemptId },
  });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), { error: 'Publication unavailable' });
  assert.doesNotMatch(response.body, /synthetic|database|details/i);

  const unsafe = Fastify({ logger: true });
  assert.throws(
    () => registerPublicationRetryRoutes(unsafe, setup.value),
    /HTTP_LOGGING_CONFIGURATION/,
  );
  await unsafe.close();
  const malformed = createApp(
    config,
    { async ping() {}, async close() {} },
    false,
  );
  t.after(() => malformed.close());
  assert.throws(
    () =>
      registerPublicationRetryRoutes(malformed, {
        ...setup.value,
        externalOrigin: 'https://service.example:8443',
      }),
    /PUBLICATION_RETRY_ROUTE_CONFIGURATION/,
  );
});
