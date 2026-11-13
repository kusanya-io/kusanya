import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createPostgresPool, createQueryExecutor } from '../../src/database.js';
import { readConfig } from '../../src/config.js';
import { applyMigrations } from '../../src/migrations.js';
import {
  SubmissionRelayError,
  SubmissionRelayStore,
} from '../../src/submission/submission-relay-store.js';
import { normalizeSalesforceOrgId } from '../../src/tenant/connection-store.js';

const databaseUrl = process.env.DATABASE_URL;
const databaseRequired = process.env.REQUIRE_DATABASE_TESTS === 'true';

const instanceId = 'uuid:123e4567-e89b-12d3-a456-426614174000';
const xml = (answer: string, id = instanceId) =>
  `<data id="phase2_probe" version="1"><answer>${answer}</answer>` +
  `<meta><instanceID>${id}</instanceID></meta></data>`;
const bytes = (value: string) => new TextEncoder().encode(value);

void test(
  'submission relays are durable, idempotent, tenant-scoped and one-way in PostgreSQL',
  {
    timeout: 20_000,
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
    const orgId = normalizeSalesforceOrgId(
      `00D${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    );
    const otherOrgId = normalizeSalesforceOrgId(
      `00D${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    );
    const formVersionId = `a2h${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const otherFormVersionId = `a2h${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    context.after(async () => {
      await pool.query(
        `DELETE FROM tenant_submission_relays WHERE tenant_id = ANY($1::uuid[])`,
        [[tenantId, otherTenantId]],
      );
      await pool.query(
        `DELETE FROM tenant_connections WHERE tenant_id = ANY($1::uuid[])`,
        [[tenantId, otherTenantId]],
      );
      await pool.query(
        `DELETE FROM tenant_administrator_tenants
         WHERE tenant_id = ANY($1::uuid[])`,
        [[tenantId, otherTenantId]],
      );
      await pool.end();
    });
    await applyMigrations(pool);
    for (const [tenant, org] of [
      [tenantId, orgId],
      [otherTenantId, otherOrgId],
    ]) {
      await pool.query(
        `INSERT INTO tenant_administrator_tenants
           (tenant_id, expected_salesforce_org_id, authorization_origin,
            namespace_prefix, salesforce_connection_state)
         VALUES ($1, $2, 'https://login.salesforce.com', 'ksny__', 'connected')`,
        [tenant, org],
      );
      await pool.query(
        `INSERT INTO tenant_connections
           (tenant_id, salesforce_org_id, authorization_origin, instance_origin,
            namespace_prefix, credential_schema_version, credential_key_id,
            credential_nonce, credential_ciphertext, credential_tag)
         VALUES ($1, $2, 'https://login.salesforce.com',
                 'https://tenant.my.salesforce.com', 'ksny__', 1,
                 'test-key', 'bm9uY2U=', 'Y2lwaGVydGV4dA==', 'dGFn')`,
        [tenant, org],
      );
    }

    const store = new SubmissionRelayStore(createQueryExecutor(pool));
    await assert.rejects(
      store.enqueue({
        tenantId,
        salesforceOrgId: otherOrgId,
        formVersionId,
        channel: 'phone',
        rawXml: bytes(
          xml('wrong-org', 'uuid:123e4567-e89b-12d3-a456-426614174099'),
        ),
      }),
      (error: unknown) =>
        error instanceof SubmissionRelayError &&
        error.code === 'SUBMISSION_RELAY_STORAGE',
    );
    const first = await store.enqueue({
      tenantId,
      salesforceOrgId: orgId,
      formVersionId,
      channel: 'phone',
      rawXml: bytes(xml('yes')),
    });
    assert.equal(first.duplicate, false);
    const duplicate = await store.enqueue({
      tenantId,
      salesforceOrgId: orgId,
      formVersionId,
      channel: 'phone',
      rawXml: bytes(xml('yes')),
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.relayId, first.relayId);
    await assert.rejects(
      store.enqueue({
        tenantId,
        salesforceOrgId: orgId,
        formVersionId,
        channel: 'phone',
        rawXml: bytes(xml('changed')),
      }),
      (error: unknown) =>
        error instanceof SubmissionRelayError &&
        error.code === 'SUBMISSION_RELAY_CONFLICT',
    );
    const other = await store.enqueue({
      tenantId: otherTenantId,
      salesforceOrgId: otherOrgId,
      formVersionId: otherFormVersionId,
      channel: 'phone',
      rawXml: bytes(xml('yes')),
    });
    assert.notEqual(other.relayId, first.relayId);

    await pool.query(
      `UPDATE tenant_administrator_tenants
       SET salesforce_connection_state = 'disconnected'
       WHERE tenant_id = $1`,
      [tenantId],
    );
    assert.deepEqual(await store.claimBatch(tenantId, 200, new Date()), []);
    await pool.query(
      `UPDATE tenant_administrator_tenants
       SET salesforce_connection_state = 'connected'
       WHERE tenant_id = $1`,
      [tenantId],
    );
    const claimed = await store.claimBatch(tenantId, 200, new Date());
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]!.relayId, first.relayId);
    assert.deepEqual(claimed[0]!.rawXml, bytes(xml('yes')));
    assert.deepEqual(await store.claimBatch(tenantId, 200, new Date()), []);
    assert.equal(
      (await store.claimBatch(otherTenantId, 200, new Date()))[0]!.relayId,
      other.relayId,
    );

    await store.markFailed(
      tenantId,
      first.relayId,
      'SALESFORCE_UNAVAILABLE',
      new Date(Date.now() - 1_000),
    );
    const retried = await store.claimBatch(tenantId, 1, new Date());
    assert.equal(retried[0]!.attempt, 2);
    await store.markCommitted(tenantId, first.relayId);
    await store.markFailed(otherTenantId, other.relayId, 'MAPPING_REFUSED');

    const states = await pool.query<{
      tenant_id: string;
      state: string;
      attempts: number;
      has_ack: boolean;
    }>(
      `SELECT tenant_id, state, attempts, acknowledged_at IS NOT NULL AS has_ack
       FROM tenant_submission_relays
       WHERE tenant_id = ANY($1::uuid[])
       ORDER BY tenant_id`,
      [[tenantId, otherTenantId]],
    );
    assert.deepEqual(
      states.rows.map((row) => [row.state, row.attempts, row.has_ack]).sort(),
      [
        ['committed', 2, true],
        ['dead', 1, false],
      ],
    );

    await assert.rejects(
      pool.query(
        `UPDATE tenant_submission_relays SET raw_xml = $3
         WHERE tenant_id = $1 AND relay_id = $2`,
        [tenantId, first.relayId, Buffer.from('<changed/>')],
      ),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        Object.getOwnPropertyDescriptor(error, 'code')?.value === '23514',
    );
    await assert.rejects(
      pool.query(
        `UPDATE tenant_submission_relays SET state = 'queued',
                acknowledged_at = NULL, next_attempt_at = clock_timestamp()
         WHERE tenant_id = $1 AND relay_id = $2`,
        [tenantId, first.relayId],
      ),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        Object.getOwnPropertyDescriptor(error, 'code')?.value === '23514',
    );
  },
);
