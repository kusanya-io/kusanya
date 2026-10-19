import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
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
import { createTenantSalesforceSession } from '../../src/tenant/salesforce-session.js';
import { AdministratorSessionStore } from '../../src/tenant/administrator-session.js';
import {
  beginTenantSalesforceAuthorization,
  completeTenantSalesforceAuthorization,
  TenantOAuthTransactionStore,
} from '../../src/tenant/oauth-authorization.js';
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
        await pool.query<{ count: number }>(
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
      async connect() {
        const client = await pool.connect();
        return {
          async query<Row>(text: string, values: unknown[] = []) {
            const result = await client.query(text, values);
            return {
              rows: result.rows as Row[],
              rowCount: result.rowCount,
            };
          },
          release() {
            client.release();
          },
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

    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const firstHasLock = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let secondEntered = false;
    const firstRefresh = currentStore.withRefreshLock(
      tenantId,
      async (selected) => {
        assert.equal(selected.credentialVersion, 2);
        assert.equal(
          selected.getRefreshToken(),
          'second-synthetic-refresh-token',
        );
        firstEntered();
        await firstMayFinish;
        return {
          value: 'first',
          rotatedRefreshToken: 'third-synthetic-refresh-token',
        };
      },
    );
    await firstHasLock;
    const secondRefresh = currentStore.withRefreshLock(
      tenantId,
      async (selected) => {
        secondEntered = true;
        assert.equal(selected.credentialVersion, 3);
        assert.equal(
          selected.getRefreshToken(),
          'third-synthetic-refresh-token',
        );
        return { value: 'second' };
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(secondEntered, false);
    releaseFirst();
    assert.equal((await firstRefresh)?.connection.credentialVersion, 3);
    assert.equal((await secondRefresh)?.value, 'second');

    const timeoutStarted = performance.now();
    await assert.rejects(
      createTenantSalesforceSession(
        currentStore,
        tenantId,
        {
          clientId: 'integration-client-id',
          clientSecret: 'integration-client-secret',
          timeoutMs: 25,
        },
        async () => await new Promise<Response>(() => undefined),
      ),
      /TENANT_SALESFORCE_SESSION_REFRESH/,
    );
    assert.ok(performance.now() - timeoutStarted < 1_000);
    let enteredAfterTimeout = false;
    const afterTimeout = await currentStore.withRefreshLock(
      tenantId,
      async (selected) => {
        enteredAfterTimeout = true;
        assert.equal(selected.credentialVersion, 3);
        assert.equal(
          selected.getRefreshToken(),
          'third-synthetic-refresh-token',
        );
        return { value: 'lock-released' };
      },
    );
    assert.equal(enteredAfterTimeout, true);
    assert.equal(afterTimeout?.value, 'lock-released');

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

void test(
  'OAuth state is single-use and a complete signed grant is the only durable connection',
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
    const rejectedTenantId = randomUUID();
    context.after(async () => {
      try {
        await pool.query(
          `DELETE FROM tenant_oauth_transactions
           WHERE tenant_id IN ($1::uuid, $2::uuid)`,
          [tenantId, rejectedTenantId],
        );
        await pool.query(
          `DELETE FROM tenant_connections
           WHERE tenant_id IN ($1::uuid, $2::uuid)`,
          [tenantId, rejectedTenantId],
        );
      } finally {
        await pool.end();
      }
    });
    await applyMigrations(pool);
    const queryExecutor: QueryExecutor = {
      async query<Row>(text: string, values: unknown[] = []) {
        const result = await pool.query(text, values);
        return { rows: result.rows as Row[], rowCount: result.rowCount };
      },
      async connect() {
        const client = await pool.connect();
        return {
          async query<Row>(text: string, values: unknown[] = []) {
            const result = await client.query(text, values);
            return { rows: result.rows as Row[], rowCount: result.rowCount };
          },
          release() {
            client.release();
          },
        };
      },
    };
    const transactionStore = new TenantOAuthTransactionStore(queryExecutor);
    const connectionStore = new TenantConnectionStore(
      queryExecutor,
      createTenantCredentialVault({
        activeKeyId: 'oauth-integration',
        keys: {
          'oauth-integration': Buffer.alloc(32, 61).toString('base64'),
        },
      }),
    );
    const stateSecret = Buffer.alloc(32, 71).toString('base64');
    const oauthConfiguration = {
      clientId: 'integration-client-id',
      clientSecret: 'integration-client-secret',
      redirectUri: 'https://service.example/oauth/salesforce/callback',
      stateSecret,
      timeoutMs: 1_000,
      transactionTtlSeconds: 300,
    } as const;
    const orgStem = `00D${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const orgId = normalizeSalesforceOrgId(orgStem);
    const start = await beginTenantSalesforceAuthorization(
      transactionStore,
      {
        trustedTenantId: tenantId,
        expectedSalesforceOrgId: orgId,
        authorizationOrigin: 'https://login.salesforce.com',
        namespacePrefix: '',
      },
      oauthConfiguration,
    );
    const state = new URL(start.authorizationUrl).searchParams.get('state');
    assert.ok(state);
    const rawTransaction = await pool.query(
      `SELECT * FROM tenant_oauth_transactions WHERE tenant_id = $1::uuid`,
      [tenantId],
    );
    assert.equal(rawTransaction.rowCount, 1);
    assert.doesNotMatch(JSON.stringify(rawTransaction.rows), new RegExp(state));
    assert.doesNotMatch(
      JSON.stringify(rawTransaction.rows),
      /integration-client-secret|code_verifier/,
    );

    let exchanges = 0;
    const identity = `https://login.salesforce.com/id/${orgId}/005000000000001`;
    const issuedAt = '1790000000000';
    const signature = createHmac('sha256', oauthConfiguration.clientSecret)
      .update(identity + issuedAt)
      .digest('base64');
    const finish = () =>
      completeTenantSalesforceAuthorization(
        transactionStore,
        connectionStore,
        { state, code: 'integration-authorization-code' },
        oauthConfiguration,
        async () => {
          exchanges++;
          return new Response(
            JSON.stringify({
              access_token: 'integration-access-token',
              refresh_token: 'integration-refresh-token',
              signature,
              scope: 'api refresh_token',
              instance_url: 'https://tenant.my.salesforce.com',
              id: identity,
              token_type: 'Bearer',
              issued_at: issuedAt,
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          );
        },
      );
    const outcomes = await Promise.allSettled([finish(), finish()]);
    assert.equal(
      outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
      1,
    );
    assert.equal(exchanges, 1);
    const connection = await connectionStore.load(tenantId);
    assert.equal(connection?.salesforceOrgId, orgId);
    assert.equal(connection?.getRefreshToken(), 'integration-refresh-token');
    const rawConnection = await pool.query(
      `SELECT * FROM tenant_connections WHERE tenant_id = $1::uuid`,
      [tenantId],
    );
    assert.equal(rawConnection.rowCount, 1);
    assert.doesNotMatch(
      JSON.stringify(rawConnection.rows),
      /integration-(?:refresh|access)-token/,
    );

    const rejectedStart = await beginTenantSalesforceAuthorization(
      transactionStore,
      {
        trustedTenantId: rejectedTenantId,
        expectedSalesforceOrgId: orgId,
        authorizationOrigin: 'https://login.salesforce.com',
        namespacePrefix: '',
      },
      oauthConfiguration,
    );
    const rejectedState = new URL(
      rejectedStart.authorizationUrl,
    ).searchParams.get('state');
    assert.ok(rejectedState);
    await assert.rejects(
      completeTenantSalesforceAuthorization(
        transactionStore,
        connectionStore,
        { state: rejectedState, code: 'rejected-authorization-code' },
        oauthConfiguration,
        async () =>
          new Response('{}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
      { message: 'TENANT_OAUTH_PROVIDER' },
    );
    assert.equal(await connectionStore.load(rejectedTenantId), undefined);
    assert.equal(
      (
        await pool.query(
          `SELECT 1 FROM tenant_oauth_transactions
           WHERE tenant_id = $1::uuid`,
          [rejectedTenantId],
        )
      ).rowCount,
      0,
    );

    const expiredStart = await beginTenantSalesforceAuthorization(
      transactionStore,
      {
        trustedTenantId: rejectedTenantId,
        expectedSalesforceOrgId: orgId,
        authorizationOrigin: 'https://login.salesforce.com',
        namespacePrefix: '',
      },
      oauthConfiguration,
    );
    const expiredState = new URL(
      expiredStart.authorizationUrl,
    ).searchParams.get('state');
    assert.ok(expiredState);
    await pool.query(
      `UPDATE tenant_oauth_transactions
       SET created_at = clock_timestamp() - interval '2 hours',
           expires_at = clock_timestamp() - interval '1 hour'
       WHERE tenant_id = $1::uuid`,
      [rejectedTenantId],
    );
    let expiredExchanges = 0;
    await assert.rejects(
      completeTenantSalesforceAuthorization(
        transactionStore,
        connectionStore,
        { state: expiredState, code: 'expired-authorization-code' },
        oauthConfiguration,
        async () => {
          expiredExchanges++;
          return new Response('{}');
        },
      ),
      { message: 'TENANT_OAUTH_STATE' },
    );
    assert.equal(expiredExchanges, 0);
    assert.equal(
      (
        await pool.query(
          `SELECT 1 FROM tenant_oauth_transactions
           WHERE tenant_id = $1::uuid`,
          [rejectedTenantId],
        )
      ).rowCount,
      0,
    );
  },
);

void test(
  'administrator sessions are opaque, replaceable, immediately revocable and immutably provisioned',
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
    const raceTenantId = randomUUID();
    const actorId = `administrator:${randomUUID()}`;
    const secondActorId = `administrator:${randomUUID()}`;
    const conflictActorId = `administrator:${randomUUID()}`;
    const raceActorIds = [
      `administrator:${randomUUID()}`,
      `administrator:${randomUUID()}`,
    ];
    context.after(async () => {
      try {
        await pool.query(
          `DELETE FROM tenant_administrator_bindings
           WHERE actor_id = ANY($1::varchar[])`,
          [[actorId, secondActorId, conflictActorId, ...raceActorIds]],
        );
        await pool.query(
          `DELETE FROM tenant_administrator_tenants
           WHERE tenant_id = ANY($1::uuid[])`,
          [[tenantId, otherTenantId, raceTenantId]],
        );
      } finally {
        await pool.end();
      }
    });
    await applyMigrations(pool);
    await applyMigrations(pool);
    assert.deepEqual(
      (
        await pool.query<{ column_name: string }>(
          `SELECT column_name
           FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'tenant_administrator_bindings'
           ORDER BY column_name`,
        )
      ).rows.map((row) => row.column_name),
      ['actor_id', 'created_at', 'tenant_id'],
    );
    const queryExecutor: QueryExecutor = {
      async query<Row>(text: string, values: unknown[] = []) {
        const result = await pool.query(text, values);
        return { rows: result.rows as Row[], rowCount: result.rowCount };
      },
    };
    const store = new AdministratorSessionStore(queryExecutor);
    const sessionConfiguration = Object.freeze({
      sessionSecret: Buffer.alloc(32, 83).toString('base64'),
      ttlSeconds: 900,
    });
    const orgStem = `00D${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const orgId = normalizeSalesforceOrgId(orgStem);
    const provisioned = Object.freeze({
      actorId,
      tenantId,
      expectedSalesforceOrgId: orgStem,
      authorizationOrigin: 'https://login.salesforce.com',
      namespacePrefix: '',
    });
    await store.provision(provisioned);
    await store.provision({
      ...provisioned,
      expectedSalesforceOrgId: orgId,
    });
    await store.provision({ ...provisioned, actorId: secondActorId });
    await assert.rejects(
      store.provision({ ...provisioned, tenantId: otherTenantId }),
      { message: 'ADMINISTRATOR_SESSION_CONFLICT' },
    );
    assert.equal(
      (
        await pool.query<{ count: number }>(
          `SELECT count(*)::integer AS count
           FROM tenant_administrator_tenants
           WHERE tenant_id = $1`,
          [otherTenantId],
        )
      ).rows[0]?.count,
      0,
    );
    for (const changed of [
      { expectedSalesforceOrgId: '00D000000000002EAA' },
      { authorizationOrigin: 'https://test.salesforce.com' },
      { namespacePrefix: 'other__' },
    ])
      await assert.rejects(
        store.provision({
          ...provisioned,
          ...changed,
          actorId: conflictActorId,
        }),
        { message: 'ADMINISTRATOR_SESSION_CONFLICT' },
      );
    for (const namespacePrefix of ['MyNs__', 'my_ns__', 'Evil__'])
      await assert.rejects(
        store.provision({
          ...provisioned,
          actorId: conflictActorId,
          namespacePrefix,
        }),
        { message: 'ADMINISTRATOR_SESSION_INPUT' },
      );

    const race = await Promise.allSettled([
      store.provision({
        ...provisioned,
        actorId: raceActorIds[0]!,
        tenantId: raceTenantId,
      }),
      store.provision({
        ...provisioned,
        actorId: raceActorIds[1]!,
        tenantId: raceTenantId,
        expectedSalesforceOrgId: '00D000000000002EAA',
      }),
    ]);
    assert.equal(
      race.filter((result) => result.status === 'fulfilled').length,
      1,
    );
    assert.equal(
      race.filter(
        (result) =>
          result.status === 'rejected' &&
          result.reason instanceof Error &&
          result.reason.message === 'ADMINISTRATOR_SESSION_CONFLICT',
      ).length,
      1,
    );
    assert.equal(
      (
        await pool.query<{ count: number }>(
          `SELECT count(*)::integer AS count
           FROM tenant_administrator_bindings
           WHERE actor_id = ANY($1::varchar[])`,
          [raceActorIds],
        )
      ).rows[0]?.count,
      1,
    );
    assert.equal(
      (
        await pool.query<{ count: number }>(
          `SELECT count(*)::integer AS count
           FROM tenant_administrator_bindings
           WHERE actor_id = $1`,
          [conflictActorId],
        )
      ).rows[0]?.count,
      0,
    );

    const first = await store.issue(actorId, sessionConfiguration);
    const rawFirst = await pool.query(
      `SELECT b.*, s.*
       FROM tenant_administrator_bindings b
       JOIN administrator_sessions s ON s.actor_id = b.actor_id
       WHERE b.actor_id = $1`,
      [actorId],
    );
    assert.equal(rawFirst.rowCount, 1);
    assert.doesNotMatch(
      JSON.stringify(rawFirst.rows),
      new RegExp(`${first.opaqueSession}|${first.csrfToken}`),
    );
    assert.deepEqual(
      await store.authenticate(first.opaqueSession, sessionConfiguration),
      {
        actorId,
        tenantId,
        expectedSalesforceOrgId: orgId,
        authorizationOrigin: 'https://login.salesforce.com',
        namespacePrefix: '',
        csrfToken: first.csrfToken,
      },
    );

    const issued = await Promise.all([
      store.issue(actorId, sessionConfiguration),
      store.issue(actorId, sessionConfiguration),
    ]);
    assert.equal(
      (
        await pool.query<{ count: number }>(
          'SELECT count(*)::integer AS count FROM administrator_sessions WHERE actor_id = $1',
          [actorId],
        )
      ).rows[0]?.count,
      1,
    );
    assert.equal(
      await store.authenticate(first.opaqueSession, sessionConfiguration),
      undefined,
    );
    const concurrentResults = await Promise.all(
      issued.map((item) =>
        store.authenticate(item.opaqueSession, sessionConfiguration),
      ),
    );
    assert.equal(concurrentResults.filter(Boolean).length, 1);
    const current = issued[concurrentResults[0] === undefined ? 1 : 0];
    assert.equal(await store.revoke(current.opaqueSession), true);
    assert.equal(
      await store.authenticate(current.opaqueSession, sessionConfiguration),
      undefined,
    );

    const expiring = await store.issue(actorId, sessionConfiguration);
    await pool.query(
      `UPDATE administrator_sessions
       SET created_at = clock_timestamp() - interval '2 hours',
           expires_at = clock_timestamp() - interval '1 hour'
       WHERE actor_id = $1`,
      [actorId],
    );
    assert.equal(
      await store.authenticate(expiring.opaqueSession, sessionConfiguration),
      undefined,
    );
    assert.equal(
      (
        await pool.query<{ count: number }>(
          'SELECT count(*)::integer AS count FROM administrator_sessions WHERE actor_id = $1',
          [actorId],
        )
      ).rows[0]?.count,
      0,
    );
    assert.equal(
      (
        await pool.query<{ tenant_id: string }>(
          `SELECT b.tenant_id::text AS tenant_id
           FROM tenant_administrator_bindings b
           JOIN tenant_administrator_tenants t ON t.tenant_id = b.tenant_id
           WHERE b.actor_id = $1`,
          [actorId],
        )
      ).rows[0]?.tenant_id,
      tenantId,
    );
  },
);
