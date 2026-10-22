import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { Pool } from 'pg';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { createDatabase, createPostgresPool } from '../../src/database.js';
import { applyMigrations } from '../../src/migrations.js';
import { PublicationAttemptStore } from '../../src/publication/publication-attempt-store.js';
import { createTenantCredentialVault } from '../../src/tenant/credential-vault.js';
import {
  normalizeSalesforceOrgId,
  normalizeSalesforceUserId,
  TenantConnectionStore,
  type QueryExecutor,
} from '../../src/tenant/connection-store.js';
import {
  createBoundTenantSalesforceSession,
  createTenantSalesforceSession,
} from '../../src/tenant/salesforce-session.js';
import { AdministratorSessionStore } from '../../src/tenant/administrator-session.js';
import {
  administratorSessionRoutePaths,
  registerAdministratorSessionRoutes,
} from '../../src/tenant/administrator-routes.js';
import {
  beginTenantSalesforceAuthorization,
  completeTenantSalesforceAuthorization,
  TenantOAuthTransactionStore,
} from '../../src/tenant/oauth-authorization.js';
const databaseUrl = process.env.DATABASE_URL;
const databaseRequired = process.env.REQUIRE_DATABASE_TESTS === 'true';

void test(
  'publication attempts are durable, tenant-scoped and one-way in PostgreSQL',
  {
    timeout: 15000,
    skip:
      !databaseUrl && !databaseRequired
        ? 'Set DATABASE_URL to a disposable PostgreSQL 17 database'
        : false,
  },
  async (context) => {
    assert.ok(databaseUrl);
    const config = readConfig({
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
    });
    const pool = createPostgresPool(config, () => {});
    const tenantId = randomUUID();
    const otherTenantId = randomUUID();
    const actorId = `administrator:${randomUUID()}`;
    const otherActorId = `administrator:${randomUUID()}`;
    const orgId = normalizeSalesforceOrgId(
      `00D${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    );
    const otherOrgId = normalizeSalesforceOrgId(
      `00D${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    );
    context.after(async () => {
      try {
        await pool.query(
          `DELETE FROM tenant_publication_attempts WHERE tenant_id = ANY($1::uuid[])`,
          [[tenantId, otherTenantId]],
        );
        await pool.query(
          `DELETE FROM tenant_administrator_bindings WHERE actor_id = ANY($1::varchar[])`,
          [[actorId, otherActorId]],
        );
        await pool.query(
          `DELETE FROM tenant_administrator_tenants WHERE tenant_id = ANY($1::uuid[])`,
          [[tenantId, otherTenantId]],
        );
      } finally {
        await pool.end();
      }
    });
    await applyMigrations(pool);
    await pool.query(
      `INSERT INTO tenant_administrator_tenants
         (tenant_id, expected_salesforce_org_id, authorization_origin, namespace_prefix)
       VALUES ($1, $2, 'https://login.salesforce.com', 'ksny__'),
              ($3, $4, 'https://login.salesforce.com', '')`,
      [tenantId, orgId, otherTenantId, otherOrgId],
    );
    await pool.query(
      `INSERT INTO tenant_administrator_bindings (actor_id, tenant_id)
       VALUES ($1, $2), ($3, $4)`,
      [actorId, tenantId, otherActorId, otherTenantId],
    );
    const executor: QueryExecutor = {
      async query<Row>(text: string, values: unknown[] = []) {
        const result = await pool.query(text, values);
        return { rows: result.rows as Row[], rowCount: result.rowCount };
      },
    };
    const store = new PublicationAttemptStore(executor);
    const trusted = {
      actorId,
      tenantId,
      expectedSalesforceOrgId: orgId,
      authorizationOrigin: 'https://login.salesforce.com',
      namespacePrefix: 'ksny__',
      csrfToken: 'c'.repeat(43),
    };
    const otherTrusted = {
      actorId: otherActorId,
      tenantId: otherTenantId,
      expectedSalesforceOrgId: otherOrgId,
      authorizationOrigin: 'https://login.salesforce.com',
      namespacePrefix: '',
      csrfToken: 'o'.repeat(43),
    };
    const otherAttemptId = await store.start(
      otherTrusted,
      'a0B000000000002AAA',
    );
    await store.complete(otherAttemptId, otherTenantId, {
      outcome: 'failed',
      failureCode: 'PUBLICATION_REJECTED',
      salesforceRequestCount: 0,
    });
    const attemptId = await store.start(trusted, 'a0B000000000001AAA');
    await assert.rejects(
      store.complete(attemptId, otherTenantId, {
        outcome: 'failed',
        failureCode: 'PUBLICATION_REJECTED',
        salesforceRequestCount: 0,
      }),
      { message: 'PUBLICATION_ATTEMPT_STORAGE' },
    );
    await store.complete(attemptId, tenantId, {
      outcome: 'partial',
      failureCode: 'PUBLICATION_PUBLISHER_PARTIAL',
      publicationDigest: 'd'.repeat(64),
      xformVersionId: '068000000000001AAA',
      xlsformVersionId: '068000000000002AAA',
      salesforceRequestCount: 8,
    });
    await assert.rejects(
      store.complete(attemptId, tenantId, {
        outcome: 'failed',
        failureCode: 'PUBLICATION_REJECTED',
        salesforceRequestCount: 0,
      }),
      { message: 'PUBLICATION_ATTEMPT_STORAGE' },
    );
    assert.equal(
      (await store.loadReconcilable(trusted, attemptId)).outcome,
      'partial',
    );
    const reconciled = await Promise.all([
      store.resolve(trusted, attemptId, 'partial', 'unlinked', 2),
      store.resolve(trusted, attemptId, 'partial', 'committed', 1),
    ]);
    assert.deepEqual(reconciled[0], reconciled[1]);
    assert.ok(['unlinked', 'committed'].includes(reconciled[0].status));
    const tenantView = await store.listForOperator(trusted);
    const otherTenantView = await store.listForOperator(otherTrusted);
    assert.deepEqual(
      tenantView.map((attempt) => attempt.attemptId),
      [attemptId],
    );
    assert.deepEqual(
      otherTenantView.map((attempt) => ({
        attemptId: attempt.attemptId,
        formVersionId: attempt.formVersionId,
        operatorStatus: attempt.operatorStatus,
      })),
      [
        {
          attemptId: otherAttemptId,
          formVersionId: 'a0B000000000002AAA',
          operatorStatus: 'rejected',
        },
      ],
    );
    await assert.rejects(
      store.loadReconcilable(
        {
          ...trusted,
          tenantId: otherTenantId,
          expectedSalesforceOrgId: otherOrgId,
        },
        attemptId,
      ),
      { message: 'PUBLICATION_ATTEMPT_STORAGE' },
    );
    assert.deepEqual(
      (
        await pool.query(
          `SELECT tenant_id::text, actor_id, salesforce_org_id, outcome,
                  trim(publication_digest) AS publication_digest,
                  xform_version_id, xlsform_version_id, failure_code,
                  salesforce_request_count, reconciliation_status,
                  reconciliation_request_count,
                  (reconciled_at IS NOT NULL) AS has_reconciled_at
           FROM tenant_publication_attempts
           WHERE publication_attempt_id = $1`,
          [attemptId],
        )
      ).rows,
      [
        {
          tenant_id: tenantId,
          actor_id: actorId,
          salesforce_org_id: orgId,
          outcome: 'partial',
          publication_digest: 'd'.repeat(64),
          xform_version_id: '068000000000001AAA',
          xlsform_version_id: '068000000000002AAA',
          failure_code: 'PUBLICATION_PUBLISHER_PARTIAL',
          salesforce_request_count: 8,
          reconciliation_status: reconciled[0].status,
          reconciliation_request_count: reconciled[0].requestCount,
          has_reconciled_at: true,
        },
      ],
    );
  },
);
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

    let mismatchedRequests = 0;
    await assert.rejects(
      createBoundTenantSalesforceSession(
        currentStore,
        {
          tenantId,
          expectedSalesforceOrgId: orgId,
          authorizationOrigin: 'https://test.salesforce.com',
          namespacePrefix: '',
        },
        {
          clientId: 'integration-client-id',
          clientSecret: 'integration-client-secret',
          timeoutMs: 1_000,
        },
        async () => {
          mismatchedRequests++;
          throw new Error('must not run');
        },
      ),
      /TENANT_SALESFORCE_SESSION_BINDING/,
    );
    assert.equal(mismatchedRequests, 0);

    const boundSession = await createBoundTenantSalesforceSession(
      currentStore,
      {
        tenantId,
        expectedSalesforceOrgId: orgId,
        authorizationOrigin: 'https://test.salesforce.com',
        namespacePrefix: 'ksny__',
      },
      {
        clientId: 'integration-client-id',
        clientSecret: 'integration-client-secret',
        timeoutMs: 1_000,
      },
      async () =>
        new Response(
          JSON.stringify({
            access_token: 'integration-access-token',
            instance_url: 'https://tenant.sandbox.my.salesforce.com',
            id: `https://test.salesforce.com/id/${orgId}/005000000000001`,
            token_type: 'Bearer',
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json; charset=UTF-8' },
          },
        ),
    );
    assert.equal(boundSession.tenantId, tenantId);
    assert.equal(boundSession.salesforceOrgId, orgId);
    assert.equal(
      await boundSession.getAccessToken(),
      'integration-access-token',
    );

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
    const actorId = `administrator:${randomUUID()}`;
    const orgStem = `00D${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const orgId = normalizeSalesforceOrgId(orgStem);
    context.after(async () => {
      try {
        await pool.query(
          `DELETE FROM tenant_oauth_transactions
           WHERE tenant_id IN ($1::uuid, $2::uuid)`,
          [tenantId, rejectedTenantId],
        );
        await pool.query(
          `DELETE FROM tenant_salesforce_authorization_audits
           WHERE tenant_id IN ($1::uuid, $2::uuid)`,
          [tenantId, rejectedTenantId],
        );
        await pool.query(
          `DELETE FROM tenant_connections
           WHERE tenant_id IN ($1::uuid, $2::uuid)`,
          [tenantId, rejectedTenantId],
        );
        await pool.query(
          'DELETE FROM tenant_administrator_bindings WHERE actor_id = $1',
          [actorId],
        );
        await pool.query(
          'DELETE FROM tenant_administrator_tenants WHERE tenant_id = $1::uuid',
          [tenantId],
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
    const administratorStore = new AdministratorSessionStore(queryExecutor);
    const stateSecret = Buffer.alloc(32, 71).toString('base64');
    const oauthConfiguration = {
      clientId: 'integration-client-id',
      clientSecret: 'integration-client-secret',
      redirectUri: 'https://service.example/oauth/salesforce/callback',
      stateSecret,
      timeoutMs: 1_000,
      transactionTtlSeconds: 300,
    } as const;
    await administratorStore.provision({
      actorId,
      tenantId,
      expectedSalesforceOrgId: orgId,
      authorizationOrigin: 'https://login.salesforce.com',
      namespacePrefix: '',
    });
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
        actorId,
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
    const firstAudit = await pool.query(
      `SELECT actor_id, salesforce_org_id, salesforce_user_id,
              credential_version
       FROM tenant_salesforce_authorization_audits
       WHERE tenant_id = $1::uuid
       ORDER BY authorization_audit_id`,
      [tenantId],
    );
    assert.deepEqual(firstAudit.rows, [
      {
        actor_id: actorId,
        salesforce_org_id: orgId,
        salesforce_user_id: normalizeSalesforceUserId('005000000000001'),
        credential_version: 1,
      },
    ]);

    const secondStart = await beginTenantSalesforceAuthorization(
      transactionStore,
      {
        trustedTenantId: tenantId,
        expectedSalesforceOrgId: orgId,
        authorizationOrigin: 'https://login.salesforce.com',
        namespacePrefix: '',
      },
      oauthConfiguration,
    );
    const secondState = new URL(secondStart.authorizationUrl).searchParams.get(
      'state',
    );
    assert.ok(secondState);
    const secondUserId = '005000000000002';
    const secondIdentity = `https://login.salesforce.com/id/${orgId}/${secondUserId}`;
    const secondSignature = createHmac(
      'sha256',
      oauthConfiguration.clientSecret,
    )
      .update(secondIdentity + issuedAt)
      .digest('base64');
    await completeTenantSalesforceAuthorization(
      transactionStore,
      connectionStore,
      actorId,
      { state: secondState, code: 'second-authorization-code' },
      oauthConfiguration,
      async () =>
        new Response(
          JSON.stringify({
            access_token: 'second-access-token',
            refresh_token: 'second-refresh-token',
            signature: secondSignature,
            scope: 'api refresh_token',
            instance_url: 'https://tenant.my.salesforce.com',
            id: secondIdentity,
            token_type: 'Bearer',
            issued_at: issuedAt,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const audits = await pool.query(
      `SELECT actor_id, salesforce_org_id, salesforce_user_id,
              credential_version
       FROM tenant_salesforce_authorization_audits
       WHERE tenant_id = $1::uuid
       ORDER BY authorization_audit_id`,
      [tenantId],
    );
    assert.deepEqual(audits.rows, [
      ...firstAudit.rows,
      {
        actor_id: actorId,
        salesforce_org_id: orgId,
        salesforce_user_id: normalizeSalesforceUserId(secondUserId),
        credential_version: 2,
      },
    ]);
    assert.doesNotMatch(
      JSON.stringify(
        (
          await pool.query(
            `SELECT * FROM tenant_salesforce_authorization_audits
             WHERE tenant_id = $1::uuid`,
            [tenantId],
          )
        ).rows,
      ),
      /(?:access|refresh)-token|authorization-code|state|session|csrf/i,
    );
    assert.equal(
      (await connectionStore.load(tenantId))?.getRefreshToken(),
      'second-refresh-token',
    );

    const refusedStart = await beginTenantSalesforceAuthorization(
      transactionStore,
      {
        trustedTenantId: tenantId,
        expectedSalesforceOrgId: orgId,
        authorizationOrigin: 'https://login.salesforce.com',
        namespacePrefix: '',
      },
      oauthConfiguration,
    );
    const refusedState = new URL(
      refusedStart.authorizationUrl,
    ).searchParams.get('state');
    assert.ok(refusedState);
    await assert.rejects(
      completeTenantSalesforceAuthorization(
        transactionStore,
        connectionStore,
        'administrator:not-provisioned',
        { state: refusedState, code: 'refused-authorization-code' },
        oauthConfiguration,
        async () =>
          new Response(
            JSON.stringify({
              access_token: 'refused-access-token',
              refresh_token: 'refused-refresh-token',
              signature: secondSignature,
              scope: 'api refresh_token',
              instance_url: 'https://tenant.my.salesforce.com',
              id: secondIdentity,
              token_type: 'Bearer',
              issued_at: issuedAt,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
      { message: 'TENANT_OAUTH_CONNECTION' },
    );
    const afterRefusal = await connectionStore.load(tenantId);
    assert.equal(afterRefusal?.credentialVersion, 2);
    assert.equal(afterRefusal?.getRefreshToken(), 'second-refresh-token');
    assert.equal(
      (
        await pool.query(
          `SELECT 1 FROM tenant_salesforce_authorization_audits
           WHERE tenant_id = $1::uuid`,
          [tenantId],
        )
      ).rowCount,
      2,
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
        actorId,
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
        actorId,
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
  'migration 0004 collapses multiple consistent legacy administrators into one tenant',
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
    const controlPool = createPostgresPool(config, () => {});
    const schema = `migration_upgrade_${randomUUID().replaceAll('-', '')}`;
    assert.match(schema, /^[a-z0-9_]+$/);
    await controlPool.query(`CREATE SCHEMA ${schema}`);
    const legacyPool = new Pool({
      connectionString: config.databaseUrl,
      ssl: config.databaseSsl ? { rejectUnauthorized: true } : false,
      options: `-c search_path=${schema}`,
      max: 2,
      connectionTimeoutMillis: config.databaseTimeoutMs,
      query_timeout: config.databaseTimeoutMs,
      statement_timeout: config.databaseTimeoutMs,
      application_name: 'kusanya-migration-upgrade-test',
    });
    context.after(async () => {
      await legacyPool.end();
      try {
        await controlPool.query(`DROP SCHEMA ${schema} CASCADE`);
      } finally {
        await controlPool.end();
      }
    });

    await applyMigrations(legacyPool, '0003_administrator_sessions');
    const tenantId = randomUUID();
    const actorIds = [
      `administrator:${randomUUID()}`,
      `administrator:${randomUUID()}`,
    ];
    const orgId = normalizeSalesforceOrgId(
      `00D${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    );
    await legacyPool.query(
      `INSERT INTO tenant_administrator_bindings (
         actor_id, tenant_id, expected_salesforce_org_id,
         authorization_origin, namespace_prefix
       ) VALUES
         ($1, $3::uuid, $4, $5, $6),
         ($2, $3::uuid, $4, $5, $6)`,
      [
        actorIds[0],
        actorIds[1],
        tenantId,
        orgId,
        'https://login.salesforce.com',
        'ksny__',
      ],
    );

    await applyMigrations(legacyPool);
    await applyMigrations(legacyPool);
    assert.deepEqual(
      (
        await legacyPool.query<{
          tenant_id: string;
          expected_salesforce_org_id: string;
          authorization_origin: string;
          namespace_prefix: string;
        }>(
          `SELECT tenant_id::text, expected_salesforce_org_id,
                  authorization_origin, namespace_prefix
           FROM tenant_administrator_tenants`,
        )
      ).rows,
      [
        {
          tenant_id: tenantId,
          expected_salesforce_org_id: orgId,
          authorization_origin: 'https://login.salesforce.com',
          namespace_prefix: 'ksny__',
        },
      ],
    );
    assert.deepEqual(
      (
        await legacyPool.query<{ actor_id: string; tenant_id: string }>(
          `SELECT actor_id, tenant_id::text
           FROM tenant_administrator_bindings
           ORDER BY actor_id`,
        )
      ).rows,
      actorIds
        .toSorted()
        .map((actor_id) => ({ actor_id, tenant_id: tenantId })),
    );
    assert.deepEqual(
      (
        await legacyPool.query<{ migration_id: string }>(
          `SELECT migration_id
           FROM kusanya_schema_migrations
           ORDER BY migration_id`,
        )
      ).rows.map((row) => row.migration_id),
      [
        '0001_tenant_connections',
        '0002_tenant_oauth_transactions',
        '0003_administrator_sessions',
        '0004_administrator_tenants',
        '0005_salesforce_authorization_audits',
        '0006_publication_attempts',
        '0007_publication_attempt_reconciliation',
      ],
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

    const browserSession = await store.issue(actorId, sessionConfiguration);
    const app = createApp(config, { async ping() {}, async close() {} }, false);
    registerAdministratorSessionRoutes(app, {
      verifyLoginRequest: async () => ({ actorId }),
      sessionStore: store,
      sessionConfiguration,
      externalOrigin: 'https://service.example',
    });
    const csrf = await app.inject({
      method: 'POST',
      url: administratorSessionRoutePaths.csrf,
      headers: {
        origin: 'https://service.example',
        cookie: `__Host-kusanya_admin_session=${browserSession.opaqueSession}`,
      },
    });
    assert.equal(csrf.statusCode, 200);
    assert.deepEqual(csrf.json(), { csrfToken: browserSession.csrfToken });
    const logout = await app.inject({
      method: 'POST',
      url: administratorSessionRoutePaths.logout,
      headers: {
        origin: 'https://service.example',
        cookie: `__Host-kusanya_admin_session=${browserSession.opaqueSession}`,
        'x-csrf-token': browserSession.csrfToken,
      },
    });
    assert.equal(logout.statusCode, 204);
    assert.equal(
      logout.headers['set-cookie'],
      '__Host-kusanya_admin_session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax',
    );
    assert.equal(
      await store.authenticate(
        browserSession.opaqueSession,
        sessionConfiguration,
      ),
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
    await app.close();
  },
);
