import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { PublicationArtifactCleanupError } from '../../src/publication/publication-attempt-store.js';
import {
  publicationArtifactCleanupRoutePaths,
  registerPublicationArtifactCleanupRoutes,
  type PublicationArtifactCleanupRouteDependencies,
} from '../../src/publication/publication-artifact-cleanup-routes.js';

const sourceAttemptId = '10000000-0000-4000-8000-000000000009';
const session = 's'.repeat(43);
const csrf = 'c'.repeat(43);
const config = readConfig({ DATABASE_URL: 'postgresql://localhost/kusanya' });

function context(role: 'administrator' | 'publisher' | 'reviewer') {
  return {
    actorId: 'oidc:synthetic',
    tenantId: '10000000-0000-4000-8000-000000000001',
    expectedSalesforceOrgId: '00D000000000001EAA',
    authorizationOrigin: 'https://login.salesforce.com',
    namespacePrefix: '',
    role,
    csrfToken: csrf,
  } as const;
}

function dependencies(
  role: 'administrator' | 'publisher' | 'reviewer' = 'administrator',
  cleanup: NonNullable<
    PublicationArtifactCleanupRouteDependencies['cleanup']
  > = async () => ({
    ok: true,
    outcome: 'succeeded',
  }),
) {
  const events: unknown[][] = [];
  const value: PublicationArtifactCleanupRouteDependencies = {
    async authenticateAdministrator(value) {
      events.push(['authenticate', value]);
      return context(role);
    },
    connectionStore:
      {} as PublicationArtifactCleanupRouteDependencies['connectionStore'],
    attemptStore: {
      async startArtifactCleanup() {
        throw new Error('owned by injected cleanup');
      },
      async completeArtifactCleanup() {
        throw new Error('owned by injected cleanup');
      },
    },
    publisherConfiguration: {
      clientId: 'client',
      clientSecret: 'secret',
      refreshTimeoutMs: 100,
      perRequestTimeoutMs: 100,
      overallTimeoutMs: 1000,
    },
    externalOrigin: 'https://service.example',
    async cleanup(...args) {
      events.push(['cleanup', args[2].role, args[3]]);
      return await cleanup(...args);
    },
  };
  return { value, events };
}

function headers(extra: Record<string, string> = {}) {
  return {
    origin: 'https://service.example',
    cookie: `__Host-kusanya_admin_session=${session}`,
    'x-csrf-token': csrf,
    ...extra,
  };
}

void test('only a live administrator may invoke exact cleanup', async (t) => {
  const setup = dependencies();
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  t.after(() => app.close());
  registerPublicationArtifactCleanupRoutes(app, setup.value);
  const response = await app.inject({
    method: 'POST',
    url: publicationArtifactCleanupRoutePaths.cleanup,
    headers: headers(),
    payload: { attemptId: sourceAttemptId },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { outcome: 'succeeded' });
  assert.deepEqual(setup.events, [
    ['authenticate', session],
    ['cleanup', 'administrator', sourceAttemptId],
  ]);

  for (const role of ['publisher', 'reviewer'] as const) {
    const denied = dependencies(role);
    const deniedApp = createApp(
      config,
      { async ping() {}, async close() {} },
      false,
    );
    t.after(() => deniedApp.close());
    registerPublicationArtifactCleanupRoutes(deniedApp, denied.value);
    const result = await deniedApp.inject({
      method: 'POST',
      url: publicationArtifactCleanupRoutePaths.cleanup,
      headers: headers(),
      payload: { attemptId: sourceAttemptId },
    });
    assert.equal(result.statusCode, 403);
    assert.deepEqual(denied.events, [['authenticate', session]]);
  }
});

void test('origin, exact body, session and CSRF fail before cleanup', async (t) => {
  const setup = dependencies();
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  t.after(() => app.close());
  registerPublicationArtifactCleanupRoutes(app, setup.value);
  const variants = [
    { headers: headers({ origin: 'https://attacker.example' }) },
    { headers: headers({ 'x-csrf-token': 'x'.repeat(43) }) },
    { headers: { ...headers(), cookie: '' } },
    {
      headers: headers(),
      payload: { attemptId: sourceAttemptId, force: true },
    },
    { headers: headers(), payload: { attemptId: 'bad' } },
    {
      headers: headers(),
      url: `${publicationArtifactCleanupRoutePaths.cleanup}?force=1`,
    },
  ];
  for (const variant of variants) {
    setup.events.length = 0;
    const response = await app.inject({
      method: 'POST',
      url: variant.url ?? publicationArtifactCleanupRoutePaths.cleanup,
      headers: variant.headers,
      payload: variant.payload ?? { attemptId: sourceAttemptId },
    });
    assert.ok(
      [400, 401, 403].includes(response.statusCode),
      `${response.statusCode}: ${response.body}`,
    );
    assert.equal(
      setup.events.some((event) => event[0] === 'cleanup'),
      false,
    );
  }
});

void test('eligibility, known refusal and uncertainty use fixed responses', async (t) => {
  const cases = [
    {
      outcome: { ok: false, outcome: 'failed' } as const,
      status: 409,
      body: { error: 'Artifact cleanup refused' },
    },
    {
      outcome: { ok: false, outcome: 'indeterminate' } as const,
      status: 503,
      body: { error: 'Artifact cleanup requires investigation' },
    },
  ];
  for (const selected of cases) {
    const setup = dependencies('administrator', async () => selected.outcome);
    const app = createApp(config, { async ping() {}, async close() {} }, false);
    t.after(() => app.close());
    registerPublicationArtifactCleanupRoutes(app, setup.value);
    const response = await app.inject({
      method: 'POST',
      url: publicationArtifactCleanupRoutePaths.cleanup,
      headers: headers(),
      payload: { attemptId: sourceAttemptId },
    });
    assert.equal(response.statusCode, selected.status);
    assert.deepEqual(response.json(), selected.body);
  }

  const setup = dependencies('administrator', async () => {
    throw new PublicationArtifactCleanupError();
  });
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  t.after(() => app.close());
  registerPublicationArtifactCleanupRoutes(app, setup.value);
  const response = await app.inject({
    method: 'POST',
    url: publicationArtifactCleanupRoutePaths.cleanup,
    headers: headers(),
    payload: { attemptId: sourceAttemptId },
  });
  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.json(), { error: 'Artifact cleanup refused' });
});

void test('refuses unhardened or malformed route configuration', async (t) => {
  const malformed = [
    'http://service.example',
    'https://user:password@service.example',
    'https://service.example:8443',
    'https://service.example/path',
  ];
  for (const externalOrigin of malformed) {
    const app = createApp(config, { async ping() {}, async close() {} }, false);
    t.after(() => app.close());
    const setup = dependencies();
    assert.throws(
      () =>
        registerPublicationArtifactCleanupRoutes(app, {
          ...setup.value,
          externalOrigin,
        }),
      /PUBLICATION_ARTIFACT_CLEANUP_ROUTE_CONFIGURATION/,
    );
  }
});
