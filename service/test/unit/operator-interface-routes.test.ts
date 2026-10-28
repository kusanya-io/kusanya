import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import {
  operatorInterfaceRoutePaths,
  registerOperatorInterfaceRoutes,
} from '../../src/operator-interface-routes.js';

const config = readConfig({ DATABASE_URL: 'postgresql://localhost/kusanya' });
const hash = (value: string) =>
  createHash('sha256').update(value, 'utf8').digest('base64');

void test('serves one no-store self-contained operator shell with exact CSP hashes', async (t) => {
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  t.after(() => app.close());
  registerOperatorInterfaceRoutes(app);
  const response = await app.inject({
    method: 'GET',
    url: operatorInterfaceRoutePaths.interface,
  });
  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers['content-type']), /^text\/html/);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(response.headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(response.headers['cross-origin-resource-policy'], 'same-origin');

  const style = response.body.match(/<style>([\s\S]*?)<\/style>/)?.[1];
  const script = response.body.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(style);
  assert.ok(script);
  const policy = String(response.headers['content-security-policy']);
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /connect-src 'self'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.ok(policy.includes(`style-src 'sha256-${hash(style)}'`));
  assert.ok(policy.includes(`script-src 'sha256-${hash(script)}'`));
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval|https?:/i);
  assert.doesNotMatch(response.body, /<link|<img|<iframe|src="https?:/i);
});

void test('uses only mounted same-origin APIs and keeps bearer and CSRF values in memory', async (t) => {
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  t.after(() => app.close());
  registerOperatorInterfaceRoutes(app);
  const response = await app.inject({
    method: 'GET',
    url: operatorInterfaceRoutePaths.interface,
  });
  for (const path of [
    '/api/admin/session/login',
    '/api/admin/session/csrf',
    '/api/admin/session/logout',
    '/api/admin/administrators',
    '/api/admin/administrator-invitations',
    '/api/admin/salesforce/publications',
    '/api/admin/salesforce/publication-attempts',
    '/api/admin/publication-attempts/retention',
  ])
    assert.ok(response.body.includes(path), path);
  assert.match(response.body, /credentials: 'same-origin'/);
  assert.match(response.body, /cache: 'no-store'/);
  assert.match(response.body, /redirect: 'error'/);
  assert.match(response.body, /elements\.token\.value = ''/);
  assert.match(response.body, /clearInvitationSecret\(\)/);
  assert.match(
    response.body,
    /Invitation created\. Copy its one-time token securely\./,
  );
  assert.match(response.body, /method: 'DELETE'/);
  assert.match(response.body, /method: 'PATCH'/);
  assert.match(response.body, /value="administrator">Administrator<\/option>/);
  assert.match(response.body, /value="publisher">Publisher<\/option>/);
  assert.match(response.body, /value="reviewer">Reviewer<\/option>/);
  assert.match(response.body, /Operator access removed for this tenant\./);
  assert.match(response.body, /Operator role changed for this tenant\./);
  assert.match(response.body, /Delete expired safe attempts/);
  assert.match(
    response.body,
    /Deleted ' \+ result\.deletedCount \+ ' retention-eligible publication attempts\./,
  );
  assert.match(
    response.body,
    /Human judgement is required before any publication retry\./,
  );
  assert.doesNotMatch(
    response.body,
    /innerHTML|outerHTML|document\.write|eval\(|localStorage|sessionStorage|indexedDB/i,
  );
  assert.doesNotMatch(
    response.body,
    /actorId|tenantId|expectedSalesforceOrgId/,
  );
});

void test('has no operator-shell mutation route and refuses an unhardened host', async (t) => {
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  t.after(() => app.close());
  registerOperatorInterfaceRoutes(app);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    const response = await app.inject({
      method,
      url: operatorInterfaceRoutePaths.interface,
    });
    assert.equal(response.statusCode, 404);
  }
  const unsafe = Fastify({ logger: true });
  assert.throws(
    () => registerOperatorInterfaceRoutes(unsafe),
    /HTTP_LOGGING_CONFIGURATION/,
  );
  await unsafe.close();
});
