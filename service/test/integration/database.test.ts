import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { Pool } from 'pg';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import {
  createDatabase,
  createPostgresPool,
  createQueryExecutor,
} from '../../src/database.js';
import { applyMigrations } from '../../src/migrations.js';
import {
  PublicationAttemptError,
  PublicationAttemptStore,
} from '../../src/publication/publication-attempt-store.js';
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
import {
  AdministratorSessionError,
  AdministratorSessionStore,
} from '../../src/tenant/administrator-session.js';
import {
  administratorProvisioningRoutePaths,
  registerAdministratorProvisioningRoutes,
} from '../../src/tenant/administrator-provisioning-routes.js';
import {
  AdministratorInvitationError,
  AdministratorInvitationStore,
} from '../../src/tenant/administrator-invitation.js';
import {
  administratorInvitationRoutePaths,
  registerAdministratorInvitationRoutes,
} from '../../src/tenant/administrator-invitation-routes.js';
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
          `DELETE FROM tenant_publication_attempt_retention_audits
           WHERE tenant_id = ANY($1::uuid[])`,
          [[tenantId, otherTenantId]],
        );
        const cleanup = await pool.connect();
        try {
          await cleanup.query('BEGIN');
          for (const [cleanupTenant, cleanupActor] of [
            [tenantId, actorId],
            [otherTenantId, otherActorId],
          ]) {
            await cleanup.query(
              `SELECT set_config(
                 'kusanya.publication_retention_actor', $1, true
               )`,
              [cleanupActor],
            );
            await cleanup.query(
              `UPDATE tenant_publication_attempts
               SET outcome = 'failed', failure_code = 'TEST_CLEANUP',
                   salesforce_request_count = 0,
                   completed_at = clock_timestamp() - interval '4000 days'
               WHERE tenant_id = $1 AND outcome = 'started'
                 AND reconciliation_status IS NULL`,
              [cleanupTenant],
            );
            await cleanup.query(
              `UPDATE tenant_publication_attempts
               SET reconciliation_status = 'artifacts_missing',
                   reconciled_at = clock_timestamp() - interval '4000 days'
               WHERE tenant_id = $1 AND outcome = 'partial'
                 AND reconciliation_status IN ('unlinked', 'committed')`,
              [cleanupTenant],
            );
            await cleanup.query(
              `UPDATE tenant_publication_attempts
               SET completed_at = clock_timestamp() - interval '4000 days'
               WHERE tenant_id = $1 AND outcome IN ('succeeded', 'failed')`,
              [cleanupTenant],
            );
            await cleanup.query(
              `DELETE FROM tenant_publication_attempts WHERE tenant_id = $1`,
              [cleanupTenant],
            );
          }
          await cleanup.query('COMMIT');
        } catch (error) {
          await cleanup.query('ROLLBACK');
          throw error;
        } finally {
          cleanup.release();
        }
        await pool.query(
          `DELETE FROM tenant_publication_attempt_retention_audits
           WHERE tenant_id = ANY($1::uuid[])`,
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
      `INSERT INTO tenant_administrator_bindings (actor_id, tenant_id, role)
       VALUES ($1, $2, 'administrator'), ($3, $4, 'administrator')`,
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
      role: 'administrator' as const,
      csrfToken: 'c'.repeat(43),
    };
    const otherTrusted = {
      actorId: otherActorId,
      tenantId: otherTenantId,
      expectedSalesforceOrgId: otherOrgId,
      authorizationOrigin: 'https://login.salesforce.com',
      namespacePrefix: '',
      role: 'administrator' as const,
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
      tenantView.attempts.map((attempt) => attempt.attemptId),
      [attemptId],
    );
    assert.deepEqual(
      otherTenantView.attempts.map((attempt) => ({
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
    const pageAttemptIds = Array.from({ length: 101 }, () => randomUUID());
    await pool.query(
      `UPDATE tenant_publication_attempts
       SET created_at = clock_timestamp() - interval '1 day'
       WHERE publication_attempt_id = $1`,
      [attemptId],
    );
    await pool.query(
      `INSERT INTO tenant_publication_attempts (
         publication_attempt_id, tenant_id, actor_id, salesforce_org_id,
         form_version_id, created_at
       )
       SELECT generated.attempt_id, $2, $3, $4,
              'a0B000000000003AAA',
              statement_timestamp() - generated.ordinal * interval '1 microsecond'
       FROM unnest($1::uuid[]) WITH ORDINALITY
         AS generated(attempt_id, ordinal)`,
      [pageAttemptIds, tenantId, actorId, orgId],
    );
    const firstPage = await store.listForOperator(trusted);
    assert.equal(firstPage.attempts.length, 100);
    assert.ok(firstPage.nextCursor);
    const secondPage = await store.listForOperator(
      trusted,
      firstPage.nextCursor,
    );
    assert.equal(secondPage.attempts.length, 2);
    assert.equal(secondPage.nextCursor, null);
    const pagedIds = [
      ...firstPage.attempts.map((attempt) => attempt.attemptId),
      ...secondPage.attempts.map((attempt) => attempt.attemptId),
    ];
    assert.equal(new Set(pagedIds).size, 102);
    assert.deepEqual(
      new Set(pagedIds),
      new Set([attemptId, ...pageAttemptIds]),
    );
    assert.equal(pagedIds.includes(otherAttemptId), false);
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
  'publication retention deletes only old safe tenant evidence and preserves atomic audits',
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
          `DELETE FROM tenant_publication_attempt_retention_audits
           WHERE tenant_id = ANY($1::uuid[])`,
          [[tenantId, otherTenantId]],
        );
        const cleanup = await pool.connect();
        try {
          await cleanup.query('BEGIN');
          for (const [cleanupTenant, cleanupActor] of [
            [tenantId, actorId],
            [otherTenantId, otherActorId],
          ]) {
            await cleanup.query(
              `SELECT set_config(
                 'kusanya.publication_retention_actor', $1, true
               )`,
              [cleanupActor],
            );
            await cleanup.query(
              `UPDATE tenant_publication_attempts
               SET outcome = 'failed', publication_digest = NULL,
                   xform_version_id = NULL, xlsform_version_id = NULL,
                   failure_code = 'TEST_CLEANUP',
                   salesforce_request_count = 0,
                   completed_at = clock_timestamp() - interval '4000 days',
                   reconciliation_status = NULL,
                   reconciliation_request_count = NULL,
                   reconciled_at = NULL
               WHERE tenant_id = $1`,
              [cleanupTenant],
            );
            await cleanup.query(
              `DELETE FROM tenant_publication_attempts WHERE tenant_id = $1`,
              [cleanupTenant],
            );
          }
          await cleanup.query('COMMIT');
        } catch (error) {
          await cleanup.query('ROLLBACK');
          throw error;
        } finally {
          cleanup.release();
        }
        await pool.query(
          `DELETE FROM tenant_publication_attempt_retention_audits
           WHERE tenant_id = ANY($1::uuid[])`,
          [[tenantId, otherTenantId]],
        );
        await pool.query(
          `DELETE FROM tenant_administrator_bindings
           WHERE actor_id = ANY($1::varchar[])`,
          [[actorId, otherActorId]],
        );
        await pool.query(
          `DELETE FROM tenant_administrator_tenants
           WHERE tenant_id = ANY($1::uuid[])`,
          [[tenantId, otherTenantId]],
        );
      } finally {
        await pool.end();
      }
    });
    await applyMigrations(pool);
    await pool.query(
      `INSERT INTO tenant_administrator_tenants
         (tenant_id, expected_salesforce_org_id, authorization_origin,
          namespace_prefix)
       VALUES ($1, $2, 'https://login.salesforce.com', 'ksny__'),
              ($3, $4, 'https://login.salesforce.com', '')`,
      [tenantId, orgId, otherTenantId, otherOrgId],
    );
    await pool.query(
      `INSERT INTO tenant_administrator_bindings
         (actor_id, tenant_id, role)
       VALUES ($1, $2, 'administrator'), ($3, $4, 'administrator')`,
      [actorId, tenantId, otherActorId, otherTenantId],
    );
    const insert = async (
      selectedTenant: string,
      selectedActor: string,
      selectedOrg: string,
      outcome: 'started' | 'succeeded' | 'failed' | 'partial',
      reconciliation:
        null | 'indeterminate' | 'committed' | 'unlinked' | 'artifacts_missing',
      old = true,
    ) => {
      const attemptId = randomUUID();
      const partial = outcome === 'partial';
      const completed = outcome !== 'started';
      await pool.query(
        `INSERT INTO tenant_publication_attempts (
           publication_attempt_id, tenant_id, actor_id, salesforce_org_id,
           form_version_id, outcome, publication_digest,
           xform_version_id, xlsform_version_id, failure_code,
           salesforce_request_count, created_at, completed_at,
           reconciliation_status, reconciliation_request_count, reconciled_at
         ) VALUES (
           $1, $2, $3, $4, 'a0B000000000001AAA', $5, $6, $7, $8, $9, $10,
           clock_timestamp() - interval '120 days',
           CASE WHEN $11 THEN clock_timestamp()
             - (CASE WHEN $12 THEN interval '120 days' ELSE interval '1 day' END)
             ELSE NULL END,
           $13, $14,
           CASE WHEN $13::varchar IS NOT NULL THEN clock_timestamp()
             - interval '120 days' ELSE NULL END
         )`,
        [
          attemptId,
          selectedTenant,
          selectedActor,
          selectedOrg,
          outcome,
          outcome === 'succeeded' || partial ? 'd'.repeat(64) : null,
          partial ? '068000000000001AAA' : null,
          partial ? '068000000000002AAA' : null,
          outcome === 'failed' || partial ? 'PUBLICATION_REJECTED' : null,
          completed ? 1 : null,
          completed,
          old,
          reconciliation,
          reconciliation === null
            ? null
            : reconciliation === 'indeterminate'
              ? 0
              : 1,
        ],
      );
      return attemptId;
    };
    const eligible = [
      await insert(tenantId, actorId, orgId, 'succeeded', null),
      await insert(tenantId, actorId, orgId, 'failed', null),
      await insert(tenantId, actorId, orgId, 'partial', 'committed'),
      await insert(tenantId, actorId, orgId, 'partial', 'artifacts_missing'),
    ];
    const protectedAttempts = [
      await insert(tenantId, actorId, orgId, 'started', null),
      await insert(tenantId, actorId, orgId, 'started', 'indeterminate'),
      await insert(tenantId, actorId, orgId, 'partial', null),
      await insert(tenantId, actorId, orgId, 'partial', 'unlinked'),
      await insert(tenantId, actorId, orgId, 'succeeded', null, false),
    ];
    const otherAttempt = await insert(
      otherTenantId,
      otherActorId,
      otherOrgId,
      'failed',
      null,
    );
    const store = new PublicationAttemptStore(createQueryExecutor(pool));
    const trusted = {
      actorId,
      tenantId,
      expectedSalesforceOrgId: orgId,
      authorizationOrigin: 'https://login.salesforce.com',
      namespacePrefix: 'ksny__',
      role: 'administrator' as const,
      csrfToken: 'c'.repeat(43),
    };
    assert.deepEqual(await store.applyRetention(trusted), { deletedCount: 4 });
    assert.deepEqual(
      (
        await pool.query<{ publication_attempt_id: string }>(
          `SELECT publication_attempt_id::text
           FROM tenant_publication_attempts
           WHERE tenant_id = $1 ORDER BY publication_attempt_id`,
          [tenantId],
        )
      ).rows.map((row) => row.publication_attempt_id),
      protectedAttempts.toSorted(),
    );
    assert.equal(
      (
        await pool.query(
          `SELECT 1 FROM tenant_publication_attempts
           WHERE publication_attempt_id = $1`,
          [otherAttempt],
        )
      ).rowCount,
      1,
    );
    const audits = await pool.query<{
      publication_attempt_id: string;
      performed_by_actor_id: string;
      retention_days: number;
    }>(
      `SELECT publication_attempt_id::text, performed_by_actor_id,
              retention_days::integer
       FROM tenant_publication_attempt_retention_audits
       WHERE tenant_id = $1 ORDER BY publication_attempt_id`,
      [tenantId],
    );
    assert.deepEqual(
      audits.rows.map((row) => row.publication_attempt_id),
      eligible.toSorted(),
    );
    assert.equal(
      audits.rows.every(
        (row) =>
          row.performed_by_actor_id === actorId && row.retention_days === 90,
      ),
      true,
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO tenant_publication_attempt_retention_audits (
           tenant_id, publication_attempt_id, performed_by_actor_id,
           outcome, reconciliation_status, terminal_at, retention_days
         ) VALUES (
           $1, $2, $3, 'partial', NULL,
           clock_timestamp() - interval '120 days', 90
         )`,
        [tenantId, randomUUID(), actorId],
      ),
      { code: '23514' },
    );
    const direct = await pool.connect();
    try {
      for (const protectedAttempt of protectedAttempts) {
        await direct.query('BEGIN');
        await direct.query(
          `SELECT set_config(
             'kusanya.publication_retention_actor', $1, true
           )`,
          [actorId],
        );
        await assert.rejects(
          direct.query(
            `DELETE FROM tenant_publication_attempts
             WHERE publication_attempt_id = $1`,
            [protectedAttempt],
          ),
          { code: '23514' },
        );
        await direct.query('ROLLBACK');
      }
    } finally {
      direct.release();
    }

    const batchIds = Array.from({ length: 101 }, () => randomUUID());
    await pool.query(
      `INSERT INTO tenant_publication_attempts (
         publication_attempt_id, tenant_id, actor_id, salesforce_org_id,
         form_version_id, outcome, failure_code,
         salesforce_request_count, created_at, completed_at
       )
       SELECT batch.attempt_id, $2, $3, $4, 'a0B000000000001AAA',
              'failed', 'PUBLICATION_REJECTED', 0,
              clock_timestamp() - interval '120 days',
              clock_timestamp() - interval '120 days'
       FROM unnest($1::uuid[]) AS batch(attempt_id)`,
      [batchIds, tenantId, actorId, orgId],
    );
    assert.deepEqual(await store.applyRetention(trusted), {
      deletedCount: 100,
    });
    assert.equal(
      (
        await pool.query(
          `SELECT 1 FROM tenant_publication_attempts
           WHERE publication_attempt_id = ANY($1::uuid[])`,
          [batchIds],
        )
      ).rowCount,
      1,
    );
    assert.deepEqual(await store.applyRetention(trusted), { deletedCount: 1 });

    const collision = await insert(tenantId, actorId, orgId, 'failed', null);
    await pool.query(
      `INSERT INTO tenant_publication_attempt_retention_audits (
         tenant_id, publication_attempt_id, performed_by_actor_id,
         outcome, terminal_at, retention_days
       ) VALUES ($1, $2, $3, 'failed',
         clock_timestamp() - interval '120 days', 90)`,
      [tenantId, collision, actorId],
    );
    await assert.rejects(
      store.applyRetention(trusted),
      PublicationAttemptError,
    );
    assert.equal(
      (
        await pool.query(
          `SELECT 1 FROM tenant_publication_attempts
           WHERE publication_attempt_id = $1`,
          [collision],
        )
      ).rowCount,
      1,
    );
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
          'DELETE FROM tenant_administrator_role_audits WHERE tenant_id = $1::uuid',
          [tenantId],
        );
        await pool.query(
          'DELETE FROM tenant_administrator_lifecycle_audits WHERE tenant_id = $1::uuid',
          [tenantId],
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
    await administratorStore.bootstrap({
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
        await legacyPool.query<{
          actor_id: string;
          tenant_id: string;
          active: boolean;
          deprovisioned_at: string | null;
          role: string;
        }>(
          `SELECT actor_id, tenant_id::text, active,
                  deprovisioned_at::text, role
           FROM tenant_administrator_bindings
           ORDER BY actor_id`,
        )
      ).rows,
      actorIds.toSorted().map((actor_id) => ({
        actor_id,
        tenant_id: tenantId,
        active: true,
        deprovisioned_at: null,
        role: 'administrator',
      })),
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
        '0008_administrator_lifecycle',
        '0009_administrator_roles',
        '0010_administrator_invitations',
        '0011_publication_attempt_retention',
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
    const bootstrapTenantId = randomUUID();
    const actorId = `administrator:${randomUUID()}`;
    const secondActorId = `administrator:${randomUUID()}`;
    const conflictActorId = `administrator:${randomUUID()}`;
    const otherBoundActorId = `administrator:${randomUUID()}`;
    const enrolledActorId = `administrator:${randomUUID()}`;
    const raceActorIds = [
      `administrator:${randomUUID()}`,
      `administrator:${randomUUID()}`,
    ];
    const bootstrapActorIds = [
      `administrator:${randomUUID()}`,
      `administrator:${randomUUID()}`,
    ];
    context.after(async () => {
      try {
        await pool.query(
          `DELETE FROM tenant_administrator_invitations
           WHERE tenant_id = ANY($1::uuid[])`,
          [[tenantId, otherTenantId, raceTenantId, bootstrapTenantId]],
        );
        await pool.query(
          `DELETE FROM tenant_administrator_role_audits
           WHERE tenant_id = ANY($1::uuid[])`,
          [[tenantId, otherTenantId, raceTenantId, bootstrapTenantId]],
        );
        await pool.query(
          `DELETE FROM tenant_administrator_lifecycle_audits
           WHERE tenant_id = ANY($1::uuid[])`,
          [[tenantId, otherTenantId, raceTenantId, bootstrapTenantId]],
        );
        await pool.query(
          `DELETE FROM tenant_administrator_bindings
           WHERE actor_id = ANY($1::varchar[])`,
          [
            [
              actorId,
              secondActorId,
              conflictActorId,
              otherBoundActorId,
              enrolledActorId,
              ...raceActorIds,
              ...bootstrapActorIds,
            ],
          ],
        );
        await pool.query(
          `DELETE FROM tenant_administrator_tenants
           WHERE tenant_id = ANY($1::uuid[])`,
          [[tenantId, otherTenantId, raceTenantId, bootstrapTenantId]],
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
      [
        'active',
        'actor_id',
        'created_at',
        'deprovisioned_at',
        'role',
        'tenant_id',
      ],
    );
    assert.deepEqual(
      (
        await pool.query<{
          column_default: string | null;
          is_nullable: string;
        }>(
          `SELECT column_default, is_nullable
           FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'tenant_administrator_bindings'
             AND column_name = 'role'`,
        )
      ).rows,
      [{ column_default: null, is_nullable: 'NO' }],
    );
    const queryExecutor: QueryExecutor = {
      async query<Row>(text: string, values: unknown[] = []) {
        const result = await pool.query(text, values);
        return { rows: result.rows as Row[], rowCount: result.rowCount };
      },
    };
    const store = new AdministratorSessionStore(queryExecutor);
    const invitationStore = new AdministratorInvitationStore(queryExecutor);
    const invitationConfiguration = Object.freeze({ ttlSeconds: 3600 });
    const sessionConfiguration = Object.freeze({
      sessionSecret: Buffer.alloc(32, 83).toString('base64'),
      ttlSeconds: 900,
    });
    const orgStem = `00D${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const orgId = normalizeSalesforceOrgId(orgStem);
    const otherBoundOrgId = normalizeSalesforceOrgId('00D000000000003');
    const provisioned = Object.freeze({
      actorId,
      performedByActorId: actorId,
      tenantId,
      expectedSalesforceOrgId: orgStem,
      authorizationOrigin: 'https://login.salesforce.com',
      namespacePrefix: '',
      role: 'administrator' as const,
    });
    const bootstrapOrgStem = `00D${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const bootstrapRace = await Promise.allSettled(
      bootstrapActorIds.map((bootstrapActorId) =>
        store.bootstrap({
          actorId: bootstrapActorId,
          tenantId: bootstrapTenantId,
          expectedSalesforceOrgId: bootstrapOrgStem,
          authorizationOrigin: 'https://login.salesforce.com',
          namespacePrefix: '',
        }),
      ),
    );
    assert.equal(
      bootstrapRace.filter((result) => result.status === 'fulfilled').length,
      1,
    );
    assert.equal(
      bootstrapRace.filter(
        (result) =>
          result.status === 'rejected' &&
          result.reason instanceof AdministratorSessionError &&
          result.reason.code === 'ADMINISTRATOR_SESSION_CONFLICT',
      ).length,
      1,
    );
    const bootstrappedActorId =
      bootstrapActorIds[bootstrapRace[0]?.status === 'fulfilled' ? 0 : 1]!;
    await assert.rejects(
      store.bootstrap({
        actorId: bootstrappedActorId,
        tenantId: bootstrapTenantId,
        expectedSalesforceOrgId: bootstrapOrgStem,
        authorizationOrigin: 'https://login.salesforce.com',
        namespacePrefix: '',
      }),
      { message: 'ADMINISTRATOR_SESSION_CONFLICT' },
    );
    assert.deepEqual(
      (
        await pool.query<{
          performed_by_actor_id: string;
          target_actor_id: string;
          action: string;
        }>(
          `SELECT performed_by_actor_id, target_actor_id, action
           FROM tenant_administrator_lifecycle_audits
           WHERE tenant_id = $1::uuid`,
          [bootstrapTenantId],
        )
      ).rows,
      [
        {
          performed_by_actor_id: bootstrappedActorId,
          target_actor_id: bootstrappedActorId,
          action: 'bootstrap',
        },
      ],
    );
    const secondBootstrapActorId = bootstrapActorIds.find(
      (candidate) => candidate !== bootstrappedActorId,
    )!;
    await store.provision({
      actorId: secondBootstrapActorId,
      performedByActorId: bootstrappedActorId,
      tenantId: bootstrapTenantId,
      expectedSalesforceOrgId: bootstrapOrgStem,
      authorizationOrigin: 'https://login.salesforce.com',
      namespacePrefix: '',
      role: 'administrator',
    });
    const bootstrapSessions = await Promise.all(
      bootstrapActorIds.map((candidate) =>
        store.issue(candidate, sessionConfiguration),
      ),
    );
    const roleRace = await Promise.allSettled([
      store.changeRole({
        performedByActorId: bootstrapActorIds[0]!,
        targetActorId: bootstrapActorIds[1]!,
        tenantId: bootstrapTenantId,
        role: 'reviewer',
      }),
      store.changeRole({
        performedByActorId: bootstrapActorIds[1]!,
        targetActorId: bootstrapActorIds[0]!,
        tenantId: bootstrapTenantId,
        role: 'reviewer',
      }),
    ]);
    assert.equal(
      roleRace.filter((result) => result.status === 'fulfilled').length,
      1,
    );
    const roleRows = (
      await pool.query<{ actor_id: string; role: string }>(
        `SELECT actor_id, role
         FROM tenant_administrator_bindings
         WHERE tenant_id = $1::uuid AND active
         ORDER BY actor_id`,
        [bootstrapTenantId],
      )
    ).rows;
    assert.deepEqual(roleRows.map((row) => row.role).toSorted(), [
      'administrator',
      'reviewer',
    ]);
    const survivingAdministrator = roleRows.find(
      (row) => row.role === 'administrator',
    )!.actor_id;
    const demotedAdministrator = roleRows.find(
      (row) => row.role === 'reviewer',
    )!.actor_id;
    assert.equal(
      (
        await store.authenticate(
          bootstrapSessions[bootstrapActorIds.indexOf(demotedAdministrator)]!
            .opaqueSession,
          sessionConfiguration,
        )
      )?.role,
      'reviewer',
    );
    await store.changeRole({
      performedByActorId: survivingAdministrator,
      targetActorId: demotedAdministrator,
      tenantId: bootstrapTenantId,
      role: 'administrator',
    });
    const removalRace = await Promise.allSettled([
      store.deprovision({
        performedByActorId: bootstrapActorIds[0]!,
        targetActorId: bootstrapActorIds[1]!,
        tenantId: bootstrapTenantId,
      }),
      store.deprovision({
        performedByActorId: bootstrapActorIds[1]!,
        targetActorId: bootstrapActorIds[0]!,
        tenantId: bootstrapTenantId,
      }),
    ]);
    assert.equal(
      removalRace.filter((result) => result.status === 'fulfilled').length,
      1,
    );
    assert.equal(
      (
        await pool.query<{ count: number }>(
          `SELECT count(*)::integer AS count
           FROM tenant_administrator_bindings
           WHERE tenant_id = $1::uuid AND active`,
          [bootstrapTenantId],
        )
      ).rows[0]?.count,
      1,
    );
    assert.equal(
      (
        await Promise.all(
          bootstrapSessions.map((session) =>
            store.authenticate(session.opaqueSession, sessionConfiguration),
          ),
        )
      ).filter(Boolean).length,
      1,
    );
    await store.bootstrap({
      actorId,
      tenantId,
      expectedSalesforceOrgId: orgStem,
      authorizationOrigin: 'https://login.salesforce.com',
      namespacePrefix: '',
    });
    await assert.rejects(
      pool.query(
        `UPDATE tenant_administrator_bindings
         SET role = 'owner'
         WHERE actor_id = $1`,
        [actorId],
      ),
      (error: unknown) =>
        error !== null &&
        typeof error === 'object' &&
        Object.getOwnPropertyDescriptor(error, 'code')?.value === '23514',
    );
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
    await store.bootstrap({
      actorId: otherBoundActorId,
      tenantId: otherTenantId,
      expectedSalesforceOrgId: otherBoundOrgId,
      authorizationOrigin: 'https://login.salesforce.com',
      namespacePrefix: '',
    });
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

    const raceOrgId = normalizeSalesforceOrgId('00D000000000004');
    await store.bootstrap({
      actorId: raceActorIds[0]!,
      tenantId: raceTenantId,
      expectedSalesforceOrgId: raceOrgId,
      authorizationOrigin: 'https://login.salesforce.com',
      namespacePrefix: '',
    });
    const raceProvisioning = {
      actorId: raceActorIds[1]!,
      performedByActorId: raceActorIds[0]!,
      tenantId: raceTenantId,
      expectedSalesforceOrgId: raceOrgId,
      authorizationOrigin: 'https://login.salesforce.com',
      namespacePrefix: '',
      role: 'reviewer' as const,
    };
    const race = await Promise.allSettled([
      store.provision(raceProvisioning),
      store.provision({
        ...raceProvisioning,
        expectedSalesforceOrgId: '00D000000000002EAA',
      }),
    ]);
    assert.equal(
      race.filter((result) => result.status === 'fulfilled').length,
      1,
      JSON.stringify(
        race.map((result) =>
          result.status === 'fulfilled'
            ? result.status
            : [result.status, String(result.reason)],
        ),
      ),
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
           WHERE actor_id = $1`,
          [raceActorIds[1]],
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
        role: 'administrator',
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
    registerAdministratorProvisioningRoutes(app, {
      authenticateAdministrator: async (opaqueSession) => {
        const authenticated = await store.authenticate(
          opaqueSession,
          sessionConfiguration,
        );
        if (authenticated === undefined)
          throw new Error('ADMINISTRATOR_SESSION_AUTHENTICATION');
        return authenticated;
      },
      actorIdForSubject: (subject) => {
        if (subject === 'already-other-tenant') return otherBoundActorId;
        if (subject === 'new-same-tenant') return enrolledActorId;
        if (subject === 'departing-same-tenant') return secondActorId;
        if (subject === 'current-administrator') return actorId;
        throw new Error('OIDC_SUBJECT');
      },
      sessionStore: store,
      externalOrigin: 'https://service.example',
    });
    registerAdministratorInvitationRoutes(app, {
      authenticateAdministrator: async (opaqueSession) => {
        const authenticated = await store.authenticate(
          opaqueSession,
          sessionConfiguration,
        );
        if (authenticated === undefined)
          throw new Error('ADMINISTRATOR_SESSION_AUTHENTICATION');
        return authenticated;
      },
      actorIdForSubject: (subject) => {
        if (subject === 'already-other-tenant') return otherBoundActorId;
        if (subject === 'new-same-tenant') return enrolledActorId;
        throw new Error('OIDC_SUBJECT');
      },
      invitationStore,
      invitationConfiguration,
      externalOrigin: 'https://service.example',
    });
    registerAdministratorSessionRoutes(app, {
      verifyLoginRequest: async (request) => ({
        actorId:
          request.headers.authorization === 'Bearer enrolled.synthetic.token'
            ? enrolledActorId
            : request.headers.authorization === 'Bearer other.synthetic.token'
              ? otherBoundActorId
              : actorId,
      }),
      sessionStore: store,
      invitationStore,
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
    const crossTenantInvitation = await app.inject({
      method: 'POST',
      url: administratorInvitationRoutePaths.invitations,
      headers: {
        origin: 'https://service.example',
        cookie: `__Host-kusanya_admin_session=${browserSession.opaqueSession}`,
        'x-csrf-token': browserSession.csrfToken,
      },
      payload: { subject: 'already-other-tenant', role: 'reviewer' },
    });
    assert.equal(crossTenantInvitation.statusCode, 201);
    const crossTenantToken = crossTenantInvitation.json<{
      invitationToken: string;
    }>().invitationToken;
    const crossTenantAcceptance = await app.inject({
      method: 'POST',
      url: administratorSessionRoutePaths.login,
      headers: {
        origin: 'https://service.example',
        authorization: 'Bearer other.synthetic.token',
        'content-type': 'application/json',
      },
      payload: { invitationToken: crossTenantToken },
    });
    assert.equal(crossTenantAcceptance.statusCode, 401);
    assert.deepEqual(crossTenantAcceptance.json(), {
      error: 'Authentication required',
    });

    const invitation = await app.inject({
      method: 'POST',
      url: administratorInvitationRoutePaths.invitations,
      headers: {
        origin: 'https://service.example',
        cookie: `__Host-kusanya_admin_session=${browserSession.opaqueSession}`,
        'x-csrf-token': browserSession.csrfToken,
      },
      payload: { subject: 'new-same-tenant', role: 'reviewer' },
    });
    assert.equal(invitation.statusCode, 201);
    const invitationBody = invitation.json<{
      invitationId: string;
      invitationToken: string;
      expiresInSeconds: number;
    }>();
    assert.equal(invitationBody.expiresInSeconds, 3600);
    const accepted = await app.inject({
      method: 'POST',
      url: administratorSessionRoutePaths.login,
      headers: {
        origin: 'https://service.example',
        authorization: 'Bearer enrolled.synthetic.token',
        'content-type': 'application/json',
      },
      payload: { invitationToken: invitationBody.invitationToken },
    });
    assert.equal(accepted.statusCode, 204);
    const acceptedCookie = String(accepted.headers['set-cookie']);
    const enrolledOpaqueSession = acceptedCookie.match(
      /__Host-kusanya_admin_session=([A-Za-z0-9_-]{43})/,
    )?.[1];
    assert.ok(enrolledOpaqueSession);
    assert.equal(
      (await store.authenticate(enrolledOpaqueSession, sessionConfiguration))
        ?.role,
      'reviewer',
    );
    const roleChanged = await app.inject({
      method: 'PATCH',
      url: administratorProvisioningRoutePaths.provision,
      headers: {
        origin: 'https://service.example',
        cookie: `__Host-kusanya_admin_session=${browserSession.opaqueSession}`,
        'x-csrf-token': browserSession.csrfToken,
      },
      payload: { subject: 'new-same-tenant', role: 'publisher' },
    });
    assert.equal(roleChanged.statusCode, 204);
    assert.equal(
      (await store.authenticate(enrolledOpaqueSession, sessionConfiguration))
        ?.role,
      'publisher',
    );
    assert.deepEqual(
      (
        await pool.query<{ actor_id: string; tenant_id: string; role: string }>(
          `SELECT actor_id, tenant_id::text, role
           FROM tenant_administrator_bindings
           WHERE actor_id = ANY($1::varchar[])
           ORDER BY actor_id`,
          [[otherBoundActorId, enrolledActorId]],
        )
      ).rows,
      [
        {
          actor_id: enrolledActorId,
          tenant_id: tenantId,
          role: 'publisher',
        },
        {
          actor_id: otherBoundActorId,
          tenant_id: otherTenantId,
          role: 'administrator',
        },
      ].toSorted((left, right) => left.actor_id.localeCompare(right.actor_id)),
    );
    const departingSession = await store.issue(
      secondActorId,
      sessionConfiguration,
    );
    const selfRemoval = await app.inject({
      method: 'DELETE',
      url: administratorProvisioningRoutePaths.provision,
      headers: {
        origin: 'https://service.example',
        cookie: `__Host-kusanya_admin_session=${browserSession.opaqueSession}`,
        'x-csrf-token': browserSession.csrfToken,
      },
      payload: { subject: 'current-administrator' },
    });
    assert.equal(selfRemoval.statusCode, 503);
    const removed = await app.inject({
      method: 'DELETE',
      url: administratorProvisioningRoutePaths.provision,
      headers: {
        origin: 'https://service.example',
        cookie: `__Host-kusanya_admin_session=${browserSession.opaqueSession}`,
        'x-csrf-token': browserSession.csrfToken,
      },
      payload: { subject: 'departing-same-tenant' },
    });
    assert.equal(removed.statusCode, 204);
    assert.equal(
      await store.authenticate(
        departingSession.opaqueSession,
        sessionConfiguration,
      ),
      undefined,
    );
    await assert.rejects(store.issue(secondActorId, sessionConfiguration), {
      message: 'ADMINISTRATOR_SESSION_ABSENT',
    });
    await assert.rejects(
      store.provision({ ...provisioned, actorId: secondActorId }),
      { message: 'ADMINISTRATOR_SESSION_CONFLICT' },
    );
    await assert.rejects(
      store.provision({
        ...provisioned,
        actorId: secondActorId,
        tenantId: otherTenantId,
        expectedSalesforceOrgId: otherBoundOrgId,
      }),
      { message: 'ADMINISTRATOR_SESSION_CONFLICT' },
    );
    assert.deepEqual(
      (
        await pool.query<{
          actor_id: string;
          active: boolean;
          deprovisioned: boolean;
          sessions: number;
        }>(
          `SELECT b.actor_id, b.active,
                  (b.deprovisioned_at IS NOT NULL) AS deprovisioned,
                  count(s.actor_id)::integer AS sessions
           FROM tenant_administrator_bindings b
           LEFT JOIN administrator_sessions s ON s.actor_id = b.actor_id
           WHERE b.actor_id = $1
           GROUP BY b.actor_id, b.active, b.deprovisioned_at`,
          [secondActorId],
        )
      ).rows,
      [
        {
          actor_id: secondActorId,
          active: false,
          deprovisioned: true,
          sessions: 0,
        },
      ],
    );
    assert.deepEqual(
      (
        await pool.query<{
          performed_by_actor_id: string;
          target_actor_id: string;
          action: string;
          previous_role: string | null;
          new_role: string;
        }>(
          `SELECT performed_by_actor_id, target_actor_id, action,
                  previous_role, new_role
           FROM tenant_administrator_role_audits
           WHERE tenant_id = $1::uuid
           ORDER BY administrator_role_audit_id`,
          [tenantId],
        )
      ).rows,
      [
        {
          performed_by_actor_id: actorId,
          target_actor_id: secondActorId,
          action: 'enrol',
          previous_role: null,
          new_role: 'administrator',
        },
        {
          performed_by_actor_id: enrolledActorId,
          target_actor_id: enrolledActorId,
          action: 'enrol',
          previous_role: null,
          new_role: 'reviewer',
        },
        {
          performed_by_actor_id: actorId,
          target_actor_id: enrolledActorId,
          action: 'change',
          previous_role: 'reviewer',
          new_role: 'publisher',
        },
      ],
    );
    assert.deepEqual(
      (
        await pool.query<{
          performed_by_actor_id: string;
          target_actor_id: string;
          action: string;
        }>(
          `SELECT performed_by_actor_id, target_actor_id, action
           FROM tenant_administrator_lifecycle_audits
           WHERE tenant_id = $1::uuid`,
          [tenantId],
        )
      ).rows,
      [
        {
          performed_by_actor_id: actorId,
          target_actor_id: actorId,
          action: 'bootstrap',
        },
        {
          performed_by_actor_id: actorId,
          target_actor_id: secondActorId,
          action: 'deprovision',
        },
      ],
    );
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

void test(
  'administrator invitations are private, expiring, revocable and atomically single-use',
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
    const administratorId = `administrator:${randomUUID()}`;
    const otherAdministratorId = `administrator:${randomUUID()}`;
    const crossTenantActorId = `administrator:${randomUUID()}`;
    const wrongTargetId = `administrator:${randomUUID()}`;
    const wrongPresenterId = `administrator:${randomUUID()}`;
    const revokedTargetId = `administrator:${randomUUID()}`;
    const expiredTargetId = `administrator:${randomUUID()}`;
    const raceTargetId = `administrator:${randomUUID()}`;
    const lowerRoleTargetId = `administrator:${randomUUID()}`;
    const secondAdministratorId = `administrator:${randomUUID()}`;
    const staleIssuerTargetId = `administrator:${randomUUID()}`;
    const actorIds = [
      administratorId,
      otherAdministratorId,
      crossTenantActorId,
      wrongTargetId,
      wrongPresenterId,
      revokedTargetId,
      expiredTargetId,
      raceTargetId,
      lowerRoleTargetId,
      secondAdministratorId,
      staleIssuerTargetId,
    ];
    context.after(async () => {
      try {
        await pool.query(
          'DELETE FROM administrator_sessions WHERE actor_id = ANY($1::varchar[])',
          [actorIds],
        );
        await pool.query(
          `DELETE FROM tenant_administrator_invitations
           WHERE tenant_id = ANY($1::uuid[])`,
          [[tenantId, otherTenantId]],
        );
        await pool.query(
          `DELETE FROM tenant_administrator_role_audits
           WHERE tenant_id = ANY($1::uuid[])`,
          [[tenantId, otherTenantId]],
        );
        await pool.query(
          `DELETE FROM tenant_administrator_lifecycle_audits
           WHERE tenant_id = ANY($1::uuid[])`,
          [[tenantId, otherTenantId]],
        );
        await pool.query(
          'DELETE FROM tenant_administrator_bindings WHERE actor_id = ANY($1::varchar[])',
          [actorIds],
        );
        await pool.query(
          `DELETE FROM tenant_administrator_tenants
           WHERE tenant_id = ANY($1::uuid[])`,
          [[tenantId, otherTenantId]],
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
    };
    const sessions = new AdministratorSessionStore(queryExecutor);
    const invitations = new AdministratorInvitationStore(queryExecutor);
    const sessionConfiguration = Object.freeze({
      sessionSecret: Buffer.alloc(32, 27).toString('base64'),
      ttlSeconds: 900,
    });
    const invitationConfiguration = Object.freeze({ ttlSeconds: 3600 });
    await sessions.bootstrap({
      actorId: administratorId,
      tenantId,
      expectedSalesforceOrgId: '00D000000000005',
      authorizationOrigin: 'https://login.salesforce.com',
      namespacePrefix: '',
    });
    await sessions.bootstrap({
      actorId: otherAdministratorId,
      tenantId: otherTenantId,
      expectedSalesforceOrgId: '00D000000000006',
      authorizationOrigin: 'https://login.salesforce.com',
      namespacePrefix: '',
    });
    await sessions.provision({
      actorId: crossTenantActorId,
      performedByActorId: otherAdministratorId,
      tenantId: otherTenantId,
      expectedSalesforceOrgId: '00D000000000006',
      authorizationOrigin: 'https://login.salesforce.com',
      namespacePrefix: '',
      role: 'reviewer',
    });
    await sessions.provision({
      actorId: secondAdministratorId,
      performedByActorId: administratorId,
      tenantId,
      expectedSalesforceOrgId: '00D000000000005',
      authorizationOrigin: 'https://login.salesforce.com',
      namespacePrefix: '',
      role: 'administrator',
    });

    const crossTenant = await invitations.issue(
      {
        performedByActorId: administratorId,
        targetActorId: crossTenantActorId,
        tenantId,
        role: 'publisher',
      },
      invitationConfiguration,
    );
    assert.match(crossTenant.invitationToken, /^[A-Za-z0-9_-]{43}$/);
    await assert.rejects(
      invitations.accept(
        {
          actorId: crossTenantActorId,
          invitationToken: crossTenant.invitationToken,
        },
        sessionConfiguration,
      ),
      (error: unknown) =>
        error instanceof AdministratorInvitationError &&
        error.code === 'ADMINISTRATOR_INVITATION_REJECTED',
    );

    const wrongSubject = await invitations.issue(
      {
        performedByActorId: administratorId,
        targetActorId: wrongTargetId,
        tenantId,
        role: 'reviewer',
      },
      invitationConfiguration,
    );
    await assert.rejects(
      invitations.accept(
        {
          actorId: wrongPresenterId,
          invitationToken: wrongSubject.invitationToken,
        },
        sessionConfiguration,
      ),
      { message: 'ADMINISTRATOR_INVITATION_REJECTED' },
    );

    const revoked = await invitations.issue(
      {
        performedByActorId: administratorId,
        targetActorId: revokedTargetId,
        tenantId,
        role: 'reviewer',
      },
      invitationConfiguration,
    );
    await invitations.revoke({
      performedByActorId: administratorId,
      invitationId: revoked.invitationId,
      tenantId,
    });
    await assert.rejects(
      invitations.accept(
        {
          actorId: revokedTargetId,
          invitationToken: revoked.invitationToken,
        },
        sessionConfiguration,
      ),
      { message: 'ADMINISTRATOR_INVITATION_REJECTED' },
    );

    const expired = Object.freeze({
      invitationId: randomUUID(),
      invitationToken: 'e'.repeat(43),
    });
    await pool.query(
      `INSERT INTO tenant_administrator_invitations (
         invitation_id, token_digest, tenant_id, issued_by_actor_id,
         target_actor_id, role, issued_at, expires_at
       ) VALUES (
         $1::uuid, $2, $3::uuid, $4, $5, 'reviewer',
         clock_timestamp() - interval '2 hours',
         clock_timestamp() - interval '1 hour'
       )`,
      [
        expired.invitationId,
        createHash('sha256')
          .update(expired.invitationToken, 'ascii')
          .digest('hex'),
        tenantId,
        administratorId,
        expiredTargetId,
      ],
    );
    await assert.rejects(
      invitations.accept(
        {
          actorId: expiredTargetId,
          invitationToken: expired.invitationToken,
        },
        sessionConfiguration,
      ),
      { message: 'ADMINISTRATOR_INVITATION_REJECTED' },
    );

    const racing = await invitations.issue(
      {
        performedByActorId: administratorId,
        targetActorId: raceTargetId,
        tenantId,
        role: 'reviewer',
      },
      invitationConfiguration,
    );
    const race = await Promise.allSettled([
      invitations.accept(
        { actorId: raceTargetId, invitationToken: racing.invitationToken },
        sessionConfiguration,
      ),
      invitations.accept(
        { actorId: raceTargetId, invitationToken: racing.invitationToken },
        sessionConfiguration,
      ),
    ]);
    assert.equal(
      race.filter((result) => result.status === 'fulfilled').length,
      1,
    );
    assert.equal(
      race.filter(
        (result) =>
          result.status === 'rejected' &&
          result.reason instanceof AdministratorInvitationError &&
          result.reason.code === 'ADMINISTRATOR_INVITATION_REJECTED',
      ).length,
      1,
    );
    await assert.rejects(
      invitations.accept(
        { actorId: raceTargetId, invitationToken: racing.invitationToken },
        sessionConfiguration,
      ),
      { message: 'ADMINISTRATOR_INVITATION_REJECTED' },
    );

    const terminal = await pool.query<{
      bindings: number;
      sessions: number;
      audits: number;
      accepted: boolean;
      role: string;
    }>(
      `SELECT
         (SELECT count(*)::integer FROM tenant_administrator_bindings
          WHERE actor_id = $1) AS bindings,
         (SELECT count(*)::integer FROM administrator_sessions
          WHERE actor_id = $1) AS sessions,
         (SELECT count(*)::integer FROM tenant_administrator_role_audits
          WHERE target_actor_id = $1 AND action = 'enrol') AS audits,
         (SELECT accepted_at IS NOT NULL
          FROM tenant_administrator_invitations
          WHERE invitation_id = $2::uuid) AS accepted,
         (SELECT role FROM tenant_administrator_bindings
          WHERE actor_id = $1) AS role`,
      [raceTargetId, racing.invitationId],
    );
    assert.deepEqual(terminal.rows, [
      {
        bindings: 1,
        sessions: 1,
        audits: 1,
        accepted: true,
        role: 'reviewer',
      },
    ]);

    await assert.rejects(
      invitations.issue(
        {
          performedByActorId: raceTargetId,
          targetActorId: lowerRoleTargetId,
          tenantId,
          role: 'reviewer',
        },
        invitationConfiguration,
      ),
      { message: 'ADMINISTRATOR_INVITATION_REJECTED' },
    );

    const staleIssuer = await invitations.issue(
      {
        performedByActorId: administratorId,
        targetActorId: staleIssuerTargetId,
        tenantId,
        role: 'publisher',
      },
      invitationConfiguration,
    );
    const blocker = await pool.connect();
    const accepter = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        `SELECT pg_advisory_xact_lock(
           hashtextextended('tenant:' || $1::text, 0)
         )`,
        [tenantId],
      );
      const accepterPid = (
        await accepter.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      ).rows[0]!.pid;
      const acceptanceStore = new AdministratorInvitationStore({
        async query<Row>(text: string, values: unknown[] = []) {
          const result = await accepter.query(text, values);
          return { rows: result.rows as Row[], rowCount: result.rowCount };
        },
      });
      const acceptance = acceptanceStore
        .accept(
          {
            actorId: staleIssuerTargetId,
            invitationToken: staleIssuer.invitationToken,
          },
          sessionConfiguration,
        )
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const activity = await pool.query<{ waiting: boolean }>(
          `SELECT wait_event_type = 'Lock' AS waiting
           FROM pg_stat_activity WHERE pid = $1`,
          [accepterPid],
        );
        waiting = activity.rows[0]?.waiting === true;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(waiting, true);
      await blocker.query(
        `UPDATE tenant_administrator_bindings
         SET role = 'reviewer'
         WHERE actor_id = $1 AND tenant_id = $2::uuid`,
        [administratorId, tenantId],
      );
      await blocker.query('COMMIT');
      const acceptanceError = await acceptance;
      assert.ok(acceptanceError instanceof AdministratorInvitationError);
      assert.equal(acceptanceError.code, 'ADMINISTRATOR_INVITATION_REJECTED');
    } finally {
      try {
        await blocker.query('ROLLBACK');
      } catch {
        // A successful COMMIT leaves no transaction to roll back.
      }
      blocker.release();
      accepter.release();
    }
    await pool.query(
      `UPDATE tenant_administrator_bindings
       SET role = 'administrator'
       WHERE actor_id = $1 AND tenant_id = $2::uuid`,
      [administratorId, tenantId],
    );
    assert.equal(
      (
        await pool.query<{ count: number }>(
          `SELECT count(*)::integer AS count
           FROM tenant_administrator_bindings
           WHERE actor_id = ANY($1::varchar[])`,
          [
            [
              wrongTargetId,
              wrongPresenterId,
              revokedTargetId,
              expiredTargetId,
              lowerRoleTargetId,
              staleIssuerTargetId,
            ],
          ],
        )
      ).rows[0]?.count,
      0,
    );
    const rawInvitations = await pool.query(
      `SELECT * FROM tenant_administrator_invitations
       WHERE tenant_id = $1::uuid`,
      [tenantId],
    );
    const serialized = JSON.stringify(rawInvitations.rows);
    for (const token of [
      crossTenant.invitationToken,
      wrongSubject.invitationToken,
      revoked.invitationToken,
      expired.invitationToken,
      racing.invitationToken,
      staleIssuer.invitationToken,
    ])
      assert.doesNotMatch(serialized, new RegExp(token));
    await assert.rejects(
      pool.query(
        `UPDATE tenant_administrator_invitations
         SET role = 'administrator'
         WHERE invitation_id = $1::uuid`,
        [wrongSubject.invitationId],
      ),
      (error: unknown) =>
        error !== null &&
        typeof error === 'object' &&
        Object.getOwnPropertyDescriptor(error, 'code')?.value === '23514',
    );
  },
);
