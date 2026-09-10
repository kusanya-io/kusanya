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
