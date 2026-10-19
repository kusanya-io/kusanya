import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { createDatabase, createPostgresPool } from '../../src/database.js';
import { applyMigrations } from '../../src/migrations.js';
import { createTenantCredentialVault } from '../../src/tenant/credential-vault.js';
import {
  normalizeSalesforceOrgId,
  TenantConnectionStore,
  type QueryExecutor,
} from '../../src/tenant/connection-store.js';
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
  'tenant connections migrate, isolate, rotate and remain encrypted in PostgreSQL',
  {
    timeout: 15000,
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
    const pool = createPostgresPool(config, () => {});
    const tenantId = randomUUID();
    const otherTenantId = randomUUID();
    context.after(async () => {
      try {
        await pool.query(
          'DELETE FROM tenant_connections WHERE tenant_id IN ($1::uuid, $2::uuid)',
          [tenantId, otherTenantId],
        );
      } finally {
        await pool.end();
      }
    });
    await applyMigrations(pool);
    await applyMigrations(pool);

    const queryExecutor: QueryExecutor = {
      async query<Row>(text: string, values: unknown[] = []) {
        const result = await pool.query(text, values);
        return {
          rows: result.rows as Row[],
          rowCount: result.rowCount,
        };
      },
    };
    const orgStem = `00D${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const orgId = normalizeSalesforceOrgId(orgStem);

    const oldKey = Buffer.alloc(32, 17).toString('base64');
    const newKey = Buffer.alloc(32, 29).toString('base64');
    const oldStore = new TenantConnectionStore(
      queryExecutor,
      createTenantCredentialVault({
        activeKeyId: 'integration-old',
        keys: { 'integration-old': oldKey },
      }),
    );
    const saved = await oldStore.save({
      tenantId,
      salesforceOrgId: orgStem,
      authorizationOrigin: 'https://test.salesforce.com',
      instanceOrigin: 'https://tenant.sandbox.my.salesforce.com',
      namespacePrefix: '',
      refreshToken: 'first-synthetic-refresh-token',
    });
    assert.equal(saved.salesforceOrgId, orgId);
    assert.equal(saved.credentialVersion, 1);
    assert.equal(saved.getRefreshToken(), 'first-synthetic-refresh-token');

    const stored = await pool.query<{
      credential_ciphertext: string;
      credential_key_id: string;
    }>(
      `SELECT credential_ciphertext, credential_key_id
       FROM tenant_connections
       WHERE tenant_id = $1::uuid`,
      [tenantId],
    );
    assert.equal(stored.rows[0]?.credential_key_id, 'integration-old');
    assert.doesNotMatch(
      stored.rows[0]?.credential_ciphertext ?? '',
      /first-synthetic-refresh-token/,
    );

    const rotatingStore = new TenantConnectionStore(
      queryExecutor,
      createTenantCredentialVault({
        activeKeyId: 'integration-new',
        keys: {
          'integration-old': oldKey,
          'integration-new': newKey,
        },
      }),
    );
    assert.equal(
      (await rotatingStore.load(tenantId))?.needsEncryptionRotation,
      true,
    );
    assert.equal(await rotatingStore.rotateEncryption(tenantId), true);
    assert.equal(await rotatingStore.rotateEncryption(tenantId), false);

    const currentStore = new TenantConnectionStore(
      queryExecutor,
      createTenantCredentialVault({
        activeKeyId: 'integration-new',
        keys: { 'integration-new': newKey },
      }),
    );
    const rotated = await currentStore.load(tenantId);
    assert.equal(rotated?.needsEncryptionRotation, false);
    assert.equal(rotated?.credentialVersion, 1);
    assert.equal(rotated?.getRefreshToken(), 'first-synthetic-refresh-token');

    const replaced = await currentStore.save({
      tenantId,
      salesforceOrgId: orgId,
      authorizationOrigin: 'https://test.salesforce.com',
      instanceOrigin: 'https://tenant.sandbox.my.salesforce.com',
      namespacePrefix: 'ksny__',
      refreshToken: 'second-synthetic-refresh-token',
    });
    assert.equal(replaced.credentialVersion, 2);
    assert.equal(replaced.namespacePrefix, 'ksny__');
    assert.equal(replaced.getRefreshToken(), 'second-synthetic-refresh-token');

    await assert.rejects(
      currentStore.save({
        tenantId: otherTenantId,
        salesforceOrgId: orgId,
        authorizationOrigin: 'https://test.salesforce.com',
        instanceOrigin: 'https://tenant.sandbox.my.salesforce.com',
        namespacePrefix: '',
        refreshToken: 'cross-tenant-refresh-token',
      }),
      /TENANT_CONNECTION_CONFLICT/,
    );
    assert.equal(await currentStore.load(otherTenantId), undefined);
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
