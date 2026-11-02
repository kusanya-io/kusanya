import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import {
  registerReviewerPrintRoutes,
  reviewerPrintRoutePaths,
  type ReviewerPrintRouteDependencies,
} from '../../src/print/reviewer-routes.js';

const config = readConfig({ DATABASE_URL: 'postgresql://localhost/kusanya' });
const tenantId = '10000000-0000-4000-8000-000000000001';
const formVersionId = 'a0B000000000001AAA';
const session = 's'.repeat(43);
const csrf = 'c'.repeat(43);
const html =
  '<!doctype html><html><body>AUTHOR_ONLY_SENTINEL_4197</body></html>';
type Role = 'administrator' | 'publisher' | 'reviewer';

function setup(role: Role = 'reviewer') {
  const calls: unknown[] = [];
  const value: ReviewerPrintRouteDependencies = {
    authenticateAdministrator: async (opaque) => {
      calls.push(['authenticate', opaque]);
      return {
        actorId: 'oidc:synthetic',
        tenantId,
        expectedSalesforceOrgId: '00D000000000001EAA',
        authorizationOrigin: 'https://login.salesforce.com',
        namespacePrefix: '',
        role,
        csrfToken: csrf,
      };
    },
    connectionStore: {} as ReviewerPrintRouteDependencies['connectionStore'],
    publisherConfiguration: {
      clientId: 'client',
      clientSecret: 'secret',
      refreshTimeoutMs: 100,
      perRequestTimeoutMs: 100,
      overallTimeoutMs: 1000,
    },
    externalOrigin: 'https://service.example',
    reviewer: async (_store, context, _configuration, request) => {
      calls.push(['review', context.tenantId, request.formVersionId]);
      return { ok: true, html, requestCount: 1 };
    },
  };
  return { value, calls };
}

const headers = (extra: Record<string, string> = {}) => ({
  origin: 'https://service.example',
  cookie: `__Host-kusanya_admin_session=${session}`,
  'x-csrf-token': csrf,
  ...extra,
});

void test('delivers author-only HTML to every live review role with real response protections', async (t) => {
  for (const role of ['administrator', 'publisher', 'reviewer'] as const) {
    const selected = setup(role);
    const app = createApp(config, { async ping() {}, async close() {} }, false);
    t.after(() => app.close());
    registerReviewerPrintRoutes(app, selected.value);
    const response = await app.inject({
      method: 'POST',
      url: reviewerPrintRoutePaths.render,
      headers: headers({ 'x-tenant-id': 'forged-tenant' }),
      payload: { formVersionId },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, html);
    assert.match(String(response.headers['content-type']), /^text\/html/);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['x-frame-options'], 'DENY');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.equal(
      response.headers['cross-origin-resource-policy'],
      'same-origin',
    );
    assert.match(
      String(response.headers['content-security-policy']),
      /script-src 'none'/,
    );
    assert.match(
      String(response.headers['content-security-policy']),
      /frame-ancestors 'none'/,
    );
    assert.deepEqual(selected.calls, [
      ['authenticate', session],
      ['review', tenantId, formVersionId],
    ]);
  }
});

void test('public, malformed, cross-origin and CSRF requests cannot reach the reviewer', async (t) => {
  const cases = [
    {
      headers: headers({ cookie: '', authorization: 'Bearer collector-token' }),
      payload: { formVersionId },
      status: 401,
    },
    {
      headers: headers({ origin: 'https://attacker.example' }),
      payload: { formVersionId },
      status: 400,
    },
    {
      headers: headers({ 'x-csrf-token': 'x'.repeat(43) }),
      payload: { formVersionId },
      status: 403,
    },
    {
      headers: headers(),
      payload: { formVersionId, extra: true },
      status: 400,
    },
    { headers: headers(), payload: { formVersionId: 'bad' }, status: 400 },
  ];
  for (const selected of cases) {
    const dependencies = setup();
    const app = createApp(config, { async ping() {}, async close() {} }, false);
    t.after(() => app.close());
    registerReviewerPrintRoutes(app, dependencies.value);
    const response = await app.inject({
      method: 'POST',
      url: reviewerPrintRoutePaths.render,
      headers: selected.headers,
      payload: selected.payload,
    });
    assert.equal(response.statusCode, selected.status);
    assert.equal(
      dependencies.calls.some(
        (call) => Array.isArray(call) && call[0] === 'review',
      ),
      false,
    );
  }
});

void test('only POST exists, failures are fixed and an unhardened host is refused', async (t) => {
  const selected = setup();
  const dependencies: ReviewerPrintRouteDependencies = {
    ...selected.value,
    reviewer: async () => ({
      ok: false,
      code: 'TENANT_REVIEW_RENDER',
      requestCount: 1,
    }),
  };
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  t.after(() => app.close());
  registerReviewerPrintRoutes(app, dependencies);
  const refused = await app.inject({
    method: 'POST',
    url: reviewerPrintRoutePaths.render,
    headers: headers(),
    payload: { formVersionId },
  });
  assert.equal(refused.statusCode, 422);
  assert.deepEqual(refused.json(), { error: 'Reviewer view unavailable' });
  for (const method of ['GET', 'PUT', 'PATCH', 'DELETE'] as const)
    assert.equal(
      (await app.inject({ method, url: reviewerPrintRoutePaths.render }))
        .statusCode,
      404,
    );
  const unsafe = Fastify({ logger: true });
  assert.throws(
    () => registerReviewerPrintRoutes(unsafe, setup().value),
    /HTTP_LOGGING_CONFIGURATION/,
  );
  await unsafe.close();
});
