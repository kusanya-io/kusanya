import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeSalesforceOrgId,
  TenantConnectionError,
  TenantConnectionStore,
  type QueryConnection,
  type QueryExecutor,
  type QueryResult,
} from '../../src/tenant/connection-store.js';
import { createTenantCredentialVault } from '../../src/tenant/credential-vault.js';

const tenantId = '10000000-0000-4000-8000-000000000001';
const orgId = normalizeSalesforceOrgId('00D000000000001');
const vault = createTenantCredentialVault({
  activeKeyId: 'test-key',
  keys: { 'test-key': Buffer.alloc(32, 17).toString('base64') },
});

const input = Object.freeze({
  tenantId,
  salesforceOrgId: '00D000000000001',
  authorizationOrigin: 'https://login.salesforce.com',
  instanceOrigin: 'https://tenant.my.salesforce.com',
  namespacePrefix: '',
  refreshToken: 'synthetic-refresh-token',
});

function connectionRow(token: string, credentialVersion: number) {
  const encrypted = vault.seal({ tenantId, salesforceOrgId: orgId }, token);
  return {
    tenant_id: tenantId,
    salesforce_org_id: orgId,
    authorization_origin: input.authorizationOrigin,
    instance_origin: input.instanceOrigin,
    namespace_prefix: input.namespacePrefix,
    credential_schema_version: encrypted.schemaVersion,
    credential_key_id: encrypted.keyId,
    credential_nonce: encrypted.nonce,
    credential_ciphertext: encrypted.ciphertext,
    credential_tag: encrypted.tag,
    credential_version: credentialVersion,
  };
}

void test('Salesforce org IDs normalize to one checked case-safe identity', () => {
  assert.equal(orgId.length, 18);
  assert.equal(normalizeSalesforceOrgId(orgId), orgId);
  assert.throws(
    () => normalizeSalesforceOrgId(`${orgId.slice(0, 17)}Z`),
    /TENANT_CONNECTION_INPUT/,
  );
  for (const invalid of ['', '00D00000000000', '00D000000000001!'])
    assert.throws(
      () => normalizeSalesforceOrgId(invalid),
      /TENANT_CONNECTION_INPUT/,
    );
  assert.throws(
    () => normalizeSalesforceOrgId('005000000000001'),
    /TENANT_CONNECTION_INPUT/,
  );
});

void test('save parameterizes secrets and returns a non-enumerating token capability', async () => {
  let observedSql = '';
  let observedValues: unknown[] = [];
  const database: QueryExecutor = {
    async query<Row>(text: string, values: unknown[] = []) {
      observedSql = text;
      observedValues = values;
      return {
        rowCount: 1,
        rows: [
          {
            tenant_id: values[0],
            salesforce_org_id: values[1],
            authorization_origin: values[2],
            instance_origin: values[3],
            namespace_prefix: values[4],
            credential_schema_version: values[5],
            credential_key_id: values[6],
            credential_nonce: values[7],
            credential_ciphertext: values[8],
            credential_tag: values[9],
            credential_version: 1,
          } as Row,
        ],
      } satisfies QueryResult<Row>;
    },
  };
  const store = new TenantConnectionStore(database, vault);
  const connection = await store.save(input);
  assert.doesNotMatch(observedSql, /synthetic-refresh-token/);
  assert.doesNotMatch(
    JSON.stringify(observedValues),
    /synthetic-refresh-token/,
  );
  assert.equal(observedValues[0], tenantId);
  assert.equal(observedValues[1], orgId);
  assert.equal(connection.salesforceOrgId, orgId);
  assert.equal(connection.getRefreshToken(), 'synthetic-refresh-token');
  assert.equal(connection.needsEncryptionRotation, false);
  assert.doesNotMatch(JSON.stringify(connection), /synthetic-refresh-token/);
  assert.equal(Object.keys(connection).includes('getRefreshToken'), false);
  assert.ok(Object.isFrozen(connection));
});

void test('load is tenant-keyed, absent-safe and rejects malformed identities before I/O', async () => {
  let calls = 0;
  const database: QueryExecutor = {
    async query<Row>() {
      calls++;
      return { rowCount: 0, rows: [] } satisfies QueryResult<Row>;
    },
  };
  const store = new TenantConnectionStore(database, vault);
  assert.equal(await store.load(tenantId), undefined);
  assert.equal(calls, 1);
  await assert.rejects(
    store.load("10000000-0000-4000-8000-000000000001' OR true"),
    /TENANT_CONNECTION_INPUT/,
  );
  assert.equal(calls, 1);
});

void test('connection inputs reject untrusted origins, namespaces and object shapes', async () => {
  let calls = 0;
  const store = new TenantConnectionStore(
    {
      async query<Row>() {
        calls++;
        return { rowCount: 0, rows: [] } satisfies QueryResult<Row>;
      },
    },
    vault,
  );
  for (const invalid of [
    { ...input, authorizationOrigin: 'http://login.salesforce.com' },
    { ...input, instanceOrigin: 'https://example.com' },
    { ...input, instanceOrigin: 'https://tenant.my.salesforce.com/path' },
    { ...input, namespacePrefix: 'ksny' },
    { ...input, refreshToken: '' },
    { ...input, refreshToken: 'line\nbreak' },
    { ...input, extra: true },
  ])
    await assert.rejects(store.save(invalid), {
      message: 'TENANT_CONNECTION_INPUT',
    });
  assert.equal(calls, 0);
  await assert.rejects(
    store.save({ ...input, refreshToken: 'bad token' }),
    (error: unknown) =>
      error instanceof TenantConnectionError &&
      error.code === 'TENANT_CONNECTION_INPUT',
  );
});

void test('refresh lock pins one transaction and persists rotation before commit', async () => {
  const queries: string[] = [];
  let released = false;
  const client: QueryConnection = {
    async query<Row>(text: string) {
      queries.push(text.trim().split(/\s+/, 1)[0]!);
      if (/^SELECT/.test(text.trim()))
        return {
          rowCount: 1,
          rows: [connectionRow('old-synthetic-token', 4) as Row],
        } satisfies QueryResult<Row>;
      if (/^UPDATE/.test(text.trim()))
        return {
          rowCount: 1,
          rows: [connectionRow('new-synthetic-token', 5) as Row],
        } satisfies QueryResult<Row>;
      return { rowCount: null, rows: [] } satisfies QueryResult<Row>;
    },
    release() {
      released = true;
    },
  };
  const store = new TenantConnectionStore(
    {
      async query() {
        throw new Error('unpooled query not expected');
      },
      async connect() {
        return client;
      },
    },
    vault,
  );
  const result = await store.withRefreshLock(tenantId, async (selected) => {
    assert.equal(selected.getRefreshToken(), 'old-synthetic-token');
    return {
      value: 'access-result',
      rotatedRefreshToken: 'new-synthetic-token',
    };
  });
  assert.deepEqual(queries, ['BEGIN', 'SELECT', 'UPDATE', 'COMMIT']);
  assert.equal(result?.value, 'access-result');
  assert.equal(result?.connection.credentialVersion, 5);
  assert.equal(result?.connection.getRefreshToken(), 'new-synthetic-token');
  assert.equal(released, true);
});

void test('refresh lock rolls back and preserves operation errors', async () => {
  const queries: string[] = [];
  let released = false;
  const client: QueryConnection = {
    async query<Row>(text: string) {
      queries.push(text.trim().split(/\s+/, 1)[0]!);
      if (/^SELECT/.test(text.trim()))
        return {
          rowCount: 1,
          rows: [connectionRow('old-synthetic-token', 4) as Row],
        } satisfies QueryResult<Row>;
      return { rowCount: null, rows: [] } satisfies QueryResult<Row>;
    },
    release() {
      released = true;
    },
  };
  const store = new TenantConnectionStore(
    {
      async query() {
        throw new Error('unpooled query not expected');
      },
      async connect() {
        return client;
      },
    },
    vault,
  );
  await assert.rejects(
    store.withRefreshLock(tenantId, async () => {
      throw new Error('operation classification');
    }),
    /operation classification/,
  );
  assert.deepEqual(queries, ['BEGIN', 'SELECT', 'ROLLBACK']);
  assert.equal(released, true);
});
