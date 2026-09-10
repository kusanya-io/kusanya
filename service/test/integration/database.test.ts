import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { createDatabase } from '../../src/database.js';
const databaseUrl = process.env.DATABASE_URL;
const databaseRequired = process.env.REQUIRE_DATABASE_TESTS === 'true';
void test(
  'PostgreSQL dependency responds through the HTTP readiness contract',
  {
    timeout: 10000,
    skip:
      !databaseUrl && !databaseRequired
        ? 'Set DATABASE_URL to a disposable PostgreSQL 17 database'
        : false,
  },
  async (context) => {
    assert.ok(
      databaseUrl,
      'DATABASE_URL is required when REQUIRE_DATABASE_TESTS=true',
    );
    const config = readConfig({
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
    });
    const app = createApp(
      config,
      createDatabase(config, () => {}),
      false,
    );
    context.after(() => app.close());
    const response = await app.inject('/readyz');
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: 'ready' });
  },
);
void test(
  'unresponsive database connection times out and yields unavailable without details',
  { timeout: 10000 },
  async (context) => {
    // Exercise the real pg timeout against TCP that never speaks PostgreSQL.
    const sockets = new Set<import('node:net').Socket>();
    const stalledDatabase = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) =>
      stalledDatabase.listen(0, '127.0.0.1', resolve),
    );
    context.after(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        stalledDatabase.close((error) => (error ? reject(error) : resolve())),
      );
    });
    const address = stalledDatabase.address();
    assert.ok(address && typeof address !== 'string');
    const config = readConfig({
      NODE_ENV: 'test',
      DATABASE_URL: `postgresql://synthetic@127.0.0.1:${address.port}/synthetic`,
      DATABASE_SSL: 'false',
      DATABASE_TIMEOUT_MS: '100',
    });
    const app = createApp(
      config,
      createDatabase(config, () => {}),
      false,
    );
    context.after(() => app.close());
    const response = await app.inject('/readyz');
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { status: 'unavailable' });
    const live = await app.inject('/healthz');
    assert.equal(live.statusCode, 200);
  },
);
