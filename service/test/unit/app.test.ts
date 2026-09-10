import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
const config = readConfig({
  DATABASE_URL: 'postgresql://kusanya@localhost:5432/kusanya',
});
void test('liveness stays healthy when PostgreSQL is unavailable', async (context) => {
  let pings = 0;
  const app = createApp(
    config,
    {
      async ping() {
        pings += 1;
        throw new Error('secret database details');
      },
      async close() {},
    },
    false,
  );
  context.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'ok' });
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(pings, 0);
});
void test('readiness reports real dependency state and recovers without restart', async (context) => {
  let available = false;
  let pings = 0;
  const app = createApp(
    config,
    {
      async ping() {
        pings += 1;
        if (!available) throw new Error('postgresql://secret@private-db/db');
      },
      async close() {},
    },
    false,
  );
  context.after(() => app.close());
  const unavailable = await app.inject('/readyz');
  assert.equal(unavailable.statusCode, 503);
  assert.deepEqual(unavailable.json(), { status: 'unavailable' });
  assert.equal(unavailable.headers['cache-control'], 'no-store');
  assert.ok(!unavailable.body.includes('secret'));
  available = true;
  const ready = await app.inject('/readyz');
  assert.equal(ready.statusCode, 200);
  assert.deepEqual(ready.json(), { status: 'ready' });
  assert.equal(pings, 2);
});
void test('closing the HTTP service closes its database pool', async () => {
  let closed = false;
  const app = createApp(
    config,
    {
      async ping() {},
      async close() {
        closed = true;
      },
    },
    false,
  );
  await app.ready();
  await app.close();
  assert.equal(closed, true);
});
void test('health probes support HEAD and unknown routes do not reflect URL tokens', async (context) => {
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  context.after(() => app.close());
  for (const path of ['/healthz', '/readyz']) {
    const response = await app.inject({ method: 'HEAD', url: path });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, '');
  }
  const absent = await app.inject('/submission?token=secret');
  assert.equal(absent.statusCode, 404);
  assert.deepEqual(absent.json(), { error: 'Not found' });
});
void test('a 2 KB POST to readiness preserves 413 without reflecting its body', async (context) => {
  let pings = 0;
  const app = createApp(
    config,
    {
      async ping() {
        pings += 1;
      },
      async close() {},
    },
    false,
  );
  context.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: '/readyz',
    headers: { 'content-type': 'text/plain' },
    payload: 'private-request-'.padEnd(2048, 'x'),
  });
  assert.equal(response.statusCode, 413);
  assert.deepEqual(response.json(), { error: 'Request rejected' });
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(pings, 0);
  const small = await app.inject({
    method: 'POST',
    url: '/readyz',
    headers: { 'content-type': 'application/json' },
    payload: '{}',
  });
  assert.equal(small.statusCode, 404);
  assert.deepEqual(small.json(), { error: 'Not found' });
});
void test('malformed JSON and unsupported media preserve 400 and 415 with generic errors', async (context) => {
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  context.after(() => app.close());
  // Exercise media rejection on a test-only POST route; real probes are GET/HEAD.
  app.post('/synthetic-parser', async () => ({ parsed: true }));
  for (const [contentType, status] of [
    ['application/json', 400],
    ['application/x-private', 415],
  ] as const) {
    const response = await app.inject({
      method: 'POST',
      url: '/synthetic-parser',
      headers: { 'content-type': contentType },
      payload: '{private-request',
    });
    assert.equal(response.statusCode, status);
    assert.deepEqual(response.json(), { error: 'Request rejected' });
    assert.equal(response.headers['cache-control'], 'no-store');
  }
});
void test('only integer 4xx error statuses are preserved and internal errors remain sanitized', async (context) => {
  const app = createApp(config, { async ping() {}, async close() {} }, false);
  context.after(() => app.close());
  // These routes exist only in this test instance, not in the service scaffold.
  const cases = [
    [400, 400],
    [401, 401],
    [429, 429],
    [499, 499],
    [399, 500],
    [400.5, 500],
    [500, 500],
    [503, 500],
    ['413', 500],
    [undefined, 500],
  ] as const;
  cases.forEach(([statusCode], index) => {
    app.get(`/synthetic-error-${index}`, async () => {
      throw Object.assign(new Error('private-database-detail'), { statusCode });
    });
  });
  for (const [index, [, expectedStatus]] of cases.entries()) {
    const response = await app.inject(`/synthetic-error-${index}`);
    assert.equal(response.statusCode, expectedStatus);
    assert.deepEqual(response.json(), {
      error:
        expectedStatus < 500 ? 'Request rejected' : 'Internal server error',
    });
    assert.equal(response.headers['cache-control'], 'no-store');
  }
});
