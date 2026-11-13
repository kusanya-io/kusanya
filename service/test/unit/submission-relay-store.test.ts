import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  SubmissionRelayError,
  SubmissionRelayStore,
} from '../../src/submission/submission-relay-store.js';
import {
  normalizeSalesforceOrgId,
  type QueryExecutor,
  type QueryResult,
} from '../../src/tenant/connection-store.js';

const tenantId = '10000000-0000-4000-8000-000000000001';
const orgId = normalizeSalesforceOrgId('00D000000000001');
const formVersionId = 'a2h000000000001AAA';
const relayId = '20000000-0000-4000-8000-000000000002';
const instanceId = 'uuid:123e4567-e89b-12d3-a456-426614174000';
const xml = `<data id="hwws" version="3"><station>alpha</station><meta><instanceID>${instanceId}</instanceID></meta></data>`;
const xmlBytes = new TextEncoder().encode(xml);
const digest = createHash('sha256').update(xmlBytes).digest('hex');

const input = Object.freeze({
  tenantId,
  salesforceOrgId: orgId,
  formVersionId,
  channel: 'phone' as const,
  rawXml: xmlBytes,
});

function result<Row>(rows: Row[], rowCount = rows.length): QueryResult<Row> {
  return { rows, rowCount };
}

void test('enqueue parameterizes immutable XML and returns a new relay identity', async () => {
  let sql = '';
  let values: unknown[] = [];
  const database: QueryExecutor = {
    async query<Row>(text: string, parameters: unknown[] = []) {
      sql = text;
      values = parameters;
      return result([
        {
          relay_id: relayId,
          tenant_id: tenantId,
          salesforce_org_id: orgId,
          form_version_id: formVersionId,
          instance_id: instanceId,
          channel: 'phone',
          xml_sha256: digest,
          state: 'queued',
          attempts: 0,
        } as Row,
      ]);
    },
  };
  const saved = await new SubmissionRelayStore(database).enqueue(input);
  assert.deepEqual(saved, {
    relayId,
    instanceId,
    duplicate: false,
    state: 'queued',
  });
  assert.match(sql, /ON CONFLICT \(tenant_id, instance_id\) DO NOTHING/);
  assert.equal(values[1], tenantId);
  assert.equal(values[2], orgId);
  assert.equal(values[3], formVersionId);
  assert.equal(values[4], 'hwws');
  assert.equal(values[5], 3);
  assert.equal(values[6], instanceId);
  assert.equal(values[7], 'phone');
  assert.ok(values[8] instanceof Uint8Array);
  assert.deepEqual(values[8], Buffer.from(xmlBytes));
  assert.equal(values[9], digest);
  assert.ok(!sql.includes(xml));
  assert.ok(Object.isFrozen(saved));
});

void test('an exact duplicate is idempotent while changed bytes conflict', async () => {
  const existing = {
    relay_id: relayId,
    tenant_id: tenantId,
    salesforce_org_id: orgId,
    form_version_id: formVersionId,
    instance_id: instanceId,
    channel: 'phone',
    xml_sha256: digest,
    state: 'committed',
    attempts: 1,
  };
  const duplicateDatabase: QueryExecutor = {
    async query<Row>(text: string) {
      return text.startsWith('INSERT')
        ? result<Row>([], 0)
        : result([existing as Row]);
    },
  };
  assert.deepEqual(
    await new SubmissionRelayStore(duplicateDatabase).enqueue(input),
    { relayId, instanceId, duplicate: true, state: 'committed' },
  );
  const conflictDatabase: QueryExecutor = {
    async query<Row>(text: string) {
      return text.startsWith('INSERT')
        ? result<Row>([], 0)
        : result([{ ...existing, xml_sha256: '0'.repeat(64) } as Row]);
    },
  };
  await assert.rejects(
    new SubmissionRelayStore(conflictDatabase).enqueue(input),
    (error: unknown) =>
      error instanceof SubmissionRelayError &&
      error.code === 'SUBMISSION_RELAY_CONFLICT',
  );
});

void test('claim verifies stored bytes and exposes only a bounded tenant batch', async () => {
  let observedValues: unknown[] = [];
  const database: QueryExecutor = {
    async query<Row>(text: string, values: unknown[] = []) {
      assert.match(text, /FOR UPDATE SKIP LOCKED/);
      assert.match(text, /JOIN tenant_connections AS connection/);
      assert.match(text, /tenant\.salesforce_connection_state = 'connected'/);
      observedValues = values;
      return result([
        {
          relay_id: relayId,
          tenant_id: tenantId,
          salesforce_org_id: orgId,
          form_version_id: formVersionId,
          instance_id: instanceId,
          channel: 'phone',
          raw_xml: Buffer.from(xmlBytes),
          xml_sha256: digest,
          state: 'dispatching',
          attempts: 1,
        } as Row,
      ]);
    },
  };
  const now = new Date('2026-11-13T10:00:00.000Z');
  const claimed = await new SubmissionRelayStore(database).claimBatch(
    tenantId,
    200,
    now,
  );
  assert.equal(observedValues[0], tenantId);
  assert.deepEqual(observedValues[1], now);
  assert.equal(observedValues[2], 200);
  assert.deepEqual(claimed, [
    {
      relayId,
      tenantId,
      salesforceOrgId: orgId,
      formVersionId,
      instanceId,
      channel: 'phone',
      rawXml: xmlBytes,
      xmlSha256: digest,
      attempt: 1,
    },
  ]);
  assert.ok(Object.isFrozen(claimed));
  assert.ok(Object.isFrozen(claimed[0]));
});

void test('state transitions are tenant-scoped and refuse missing rows', async () => {
  const calls: { text: string; values: unknown[] }[] = [];
  const database: QueryExecutor = {
    async query<Row>(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      return result<Row>([], 1);
    },
  };
  const store = new SubmissionRelayStore(database);
  await store.markFailed(
    tenantId,
    relayId,
    'SALESFORCE_UNAVAILABLE',
    new Date('2026-11-13T10:01:00.000Z'),
  );
  await store.markFailed(tenantId, relayId, 'MAPPING_REFUSED');
  await store.markCommitted(tenantId, relayId);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.match(call.text, /tenant_id = \$1 AND relay_id = \$2/);
    assert.equal(call.values[0], tenantId);
    assert.equal(call.values[1], relayId);
  }
  assert.match(calls[0]!.text, /state = 'queued'/);
  assert.match(calls[1]!.text, /state = 'dead'/);
  assert.match(calls[2]!.text, /state = 'committed'/);

  const missing = new SubmissionRelayStore({
    async query<Row>() {
      return result<Row>([], 0);
    },
  });
  await assert.rejects(
    missing.markCommitted(tenantId, relayId),
    /SUBMISSION_RELAY_STATE/,
  );
});

void test('hostile inputs and driver failures stay fixed-code and non-disclosing', async () => {
  const hostileDriverError = new Error('synthetic driver failure');
  Object.defineProperty(hostileDriverError, 'message', {
    get() {
      throw new Error('secret must not be read');
    },
  });
  const store = new SubmissionRelayStore({
    async query() {
      throw hostileDriverError;
    },
  });
  await assert.rejects(store.enqueue(input), /SUBMISSION_RELAY_STORAGE/);
  for (const invalid of [
    { ...input, tenantId: 'other' },
    { ...input, channel: 'email' },
    { ...input, formVersionId: 'not-an-id' },
    { ...input, extra: true },
  ])
    await assert.rejects(
      store.enqueue(invalid as never),
      /SUBMISSION_RELAY_INPUT/,
    );
  let reads = 0;
  const accessor = Object.defineProperty({ ...input }, 'rawXml', {
    get() {
      reads++;
      return xmlBytes;
    },
  });
  await assert.rejects(store.enqueue(accessor), /SUBMISSION_RELAY_INPUT/);
  assert.equal(reads, 0);
});
