import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  dispatchTenantSubmissionBatch,
  SubmissionDispatcherError,
  type SubmissionDispatcherStore,
} from '../../src/submission/submission-dispatcher.js';
import type { ClaimedSubmission } from '../../src/submission/submission-relay-store.js';
import {
  normalizeSalesforceOrgId,
  type TenantConnection,
} from '../../src/tenant/connection-store.js';
import type { TenantConnectionSessionStore } from '../../src/tenant/salesforce-session.js';

const tenantId = '10000000-0000-4000-8000-000000000001';
const orgId = normalizeSalesforceOrgId('00D000000000001');
const otherOrgId = normalizeSalesforceOrgId('00D000000000002');
const userId = '005000000000001';
const now = new Date('2026-11-16T10:00:00.000Z');
const configuration = Object.freeze({
  clientId: 'synthetic-client',
  clientSecret: 'synthetic-secret',
  refreshTimeoutMs: 100,
  dispatchTimeoutMs: 50,
  leaseTimeoutMs: 2_000,
  retryDelayMs: 5_000,
  batchLimit: 200,
});

function claimed(
  relayId: string,
  attempt: number,
  overrides: Partial<ClaimedSubmission> = {},
): ClaimedSubmission {
  return Object.freeze({
    relayId,
    tenantId,
    salesforceOrgId: orgId,
    authorizationOrigin: 'https://login.salesforce.com',
    namespacePrefix: 'ksny__',
    formVersionId: 'a2h000000000001AAA',
    instanceId: `uuid:123e4567-e89b-12d3-a456-${relayId.replaceAll('-', '').slice(0, 12)}`,
    channel: 'phone' as const,
    rawXml: new TextEncoder().encode('<data/>'),
    xmlSha256: 'a'.repeat(64),
    attempt,
    ...overrides,
  });
}

function connection(
  overrides: Partial<TenantConnection> = {},
): TenantConnection {
  const value = {
    tenantId,
    salesforceOrgId: orgId,
    authorizationOrigin: 'https://login.salesforce.com',
    instanceOrigin: 'https://tenant.my.salesforce.com',
    namespacePrefix: 'ksny__',
    credentialVersion: 1,
    needsEncryptionRotation: false,
    ...overrides,
  } as Record<string, unknown>;
  Object.defineProperty(value, 'getRefreshToken', {
    enumerable: false,
    value: () => 'synthetic-refresh-token',
  });
  return Object.freeze(value) as unknown as TenantConnection;
}

function connectionStore(
  selected: TenantConnection | null = connection(),
): TenantConnectionSessionStore {
  return {
    async withRefreshLock(selectedTenantId, operation) {
      assert.equal(selectedTenantId, tenantId);
      if (selected === null) return undefined;
      const result = await operation(selected);
      return { value: result.value, connection: selected };
    },
  };
}

const oauthResponse = (): Response =>
  new Response(
    JSON.stringify({
      access_token: 'attempt-scoped-token',
      instance_url: 'https://tenant.my.salesforce.com',
      id: `https://login.salesforce.com/id/${orgId}/${userId}`,
      token_type: 'Bearer',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

function relayStore(
  submissions: readonly ClaimedSubmission[],
  recovered = 0,
): SubmissionDispatcherStore & {
  calls: { name: string; values: unknown[] }[];
} {
  const calls: { name: string; values: unknown[] }[] = [];
  return {
    calls,
    async recoverStale(...values) {
      calls.push({ name: 'recover', values });
      return recovered;
    },
    async claimBatch(...values) {
      calls.push({ name: 'claim', values });
      return submissions;
    },
    async markCommitted(...values) {
      calls.push({ name: 'committed', values });
    },
    async markFailed(...values) {
      calls.push({ name: 'failed', values });
    },
  };
}

void test('reaps first, revalidates the claimed tuple under the credential lock and settles one batch', async () => {
  const rows = [
    claimed('20000000-0000-4000-8000-000000000001', 2),
    claimed('20000000-0000-4000-8000-000000000002', 3),
    claimed('20000000-0000-4000-8000-000000000003', 4),
  ];
  const store = relayStore(rows, 2);
  let token = '';
  const result = await dispatchTenantSubmissionBatch(
    store,
    connectionStore(),
    tenantId,
    configuration,
    async (request) => {
      assert.equal(request.submissions, rows);
      assert.equal(request.signal.aborted, false);
      token = await request.session.getAccessToken();
      return [
        { relayId: rows[0]!.relayId, disposition: 'committed' },
        { relayId: rows[1]!.relayId, disposition: 'retry' },
        { relayId: rows[2]!.relayId, disposition: 'dead' },
      ];
    },
    now,
    async () => oauthResponse(),
  );
  assert.equal(token, 'attempt-scoped-token');
  assert.deepEqual(result, {
    recovered: 2,
    claimed: 3,
    committed: 1,
    retry: 1,
    dead: 1,
  });
  assert.deepEqual(store.calls[0], {
    name: 'recover',
    values: [tenantId, new Date('2026-11-16T09:59:58.000Z'), now, 200],
  });
  assert.equal(store.calls[1]!.name, 'claim');
  assert.deepEqual(store.calls.slice(2), [
    { name: 'committed', values: [tenantId, rows[0]!.relayId, 2] },
    {
      name: 'failed',
      values: [
        tenantId,
        rows[1]!.relayId,
        3,
        'SALESFORCE_RETRYABLE',
        new Date('2026-11-16T10:00:05.000Z'),
      ],
    },
    {
      name: 'failed',
      values: [tenantId, rows[2]!.relayId, 4, 'SALESFORCE_REFUSED'],
    },
  ]);
  assert.ok(Object.isFrozen(result));
});

void test('a disconnect or rebind after claim fails closed before delivery', async () => {
  const row = claimed('20000000-0000-4000-8000-000000000004', 1);
  for (const selected of [
    null,
    connection({ salesforceOrgId: otherOrgId }),
    connection({ authorizationOrigin: 'https://other.salesforce.com' }),
    connection({ namespacePrefix: '' }),
  ]) {
    const store = relayStore([row]);
    let delivered = 0;
    let fetched = 0;
    const result = await dispatchTenantSubmissionBatch(
      store,
      connectionStore(selected),
      tenantId,
      configuration,
      async () => {
        delivered++;
        return [];
      },
      now,
      async () => {
        fetched++;
        return oauthResponse();
      },
    );
    assert.equal(delivered, 0);
    assert.equal(fetched, 0);
    assert.equal(result.retry, 1);
    assert.deepEqual(store.calls.at(-1), {
      name: 'failed',
      values: [
        tenantId,
        row.relayId,
        1,
        'CONNECTION_RECHECK_FAILED',
        new Date('2026-11-16T10:00:05.000Z'),
      ],
    });
  }
});

void test('credential lock acquisition is bounded before any delivery capability exists', async () => {
  const row = claimed('20000000-0000-4000-8000-000000000009', 1);
  const store = relayStore([row]);
  let delivered = 0;
  const started = performance.now();
  const result = await dispatchTenantSubmissionBatch(
    store,
    {
      async withRefreshLock() {
        return await new Promise<never>(() => {});
      },
    },
    tenantId,
    {
      ...configuration,
      refreshTimeoutMs: 20,
      dispatchTimeoutMs: 20,
      leaseTimeoutMs: 1_100,
    },
    async () => {
      delivered++;
      return [];
    },
    now,
  );
  assert.ok(performance.now() - started < 250);
  assert.equal(delivered, 0);
  assert.equal(result.retry, 1);
  assert.equal(store.calls.at(-1)!.values[3], 'CONNECTION_RECHECK_FAILED');
});

void test('the local deadline releases work even when delivery ignores abort', async () => {
  const row = claimed('20000000-0000-4000-8000-000000000005', 7);
  const store = relayStore([row]);
  let signal: AbortSignal | undefined;
  const started = performance.now();
  const result = await dispatchTenantSubmissionBatch(
    store,
    connectionStore(),
    tenantId,
    { ...configuration, dispatchTimeoutMs: 20 },
    async (request) => {
      signal = request.signal;
      return await new Promise<never>(() => {});
    },
    now,
    async () => oauthResponse(),
  );
  assert.ok(performance.now() - started < 250);
  assert.equal(signal?.aborted, true);
  assert.equal(result.retry, 1);
  assert.equal(store.calls.at(-1)!.values[3], 'DISPATCH_TIMEOUT');
});

void test('malformed, duplicate and incomplete outcomes retry the entire claimed set', async () => {
  const rows = [
    claimed('20000000-0000-4000-8000-000000000006', 1),
    claimed('20000000-0000-4000-8000-000000000007', 1),
  ];
  let reads = 0;
  const accessor = [
    { relayId: rows[0]!.relayId, disposition: 'committed' },
    { relayId: rows[1]!.relayId, disposition: 'committed' },
  ];
  Object.defineProperty(accessor, '0', {
    get() {
      reads++;
      return { relayId: rows[0]!.relayId, disposition: 'committed' };
    },
  });
  const executableDisposition = {
    [Symbol.toPrimitive]() {
      reads++;
      return 'committed';
    },
  };
  const invalidResults: unknown[] = [
    [],
    [{ relayId: rows[0]!.relayId, disposition: 'committed' }],
    [
      { relayId: rows[0]!.relayId, disposition: 'committed' },
      { relayId: rows[0]!.relayId, disposition: 'committed' },
    ],
    [
      { relayId: rows[0]!.relayId, disposition: 'committed', extra: true },
      { relayId: rows[1]!.relayId, disposition: 'committed' },
    ],
    accessor,
    [
      { relayId: rows[0]!.relayId, disposition: executableDisposition },
      { relayId: rows[1]!.relayId, disposition: 'committed' },
    ],
  ];
  for (const invalid of invalidResults) {
    const store = relayStore(rows);
    const result = await dispatchTenantSubmissionBatch(
      store,
      connectionStore(),
      tenantId,
      configuration,
      async () => invalid as readonly never[],
      now,
      async () => oauthResponse(),
    );
    assert.equal(result.retry, 2);
    assert.deepEqual(
      store.calls.slice(-2).map((call) => call.values[3]),
      ['DISPATCH_RESULT_INVALID', 'DISPATCH_RESULT_INVALID'],
    );
  }
  assert.equal(reads, 0);
});

void test('attempt one hundred becomes terminal even when delivery asks to retry', async () => {
  const row = claimed('20000000-0000-4000-8000-000000000010', 100);
  const store = relayStore([row]);
  const result = await dispatchTenantSubmissionBatch(
    store,
    connectionStore(),
    tenantId,
    configuration,
    async () => [{ relayId: row.relayId, disposition: 'retry' }],
    now,
    async () => oauthResponse(),
  );
  assert.deepEqual(result, {
    recovered: 0,
    claimed: 1,
    committed: 0,
    retry: 0,
    dead: 1,
  });
  assert.deepEqual(store.calls.at(-1), {
    name: 'failed',
    values: [
      tenantId,
      row.relayId,
      100,
      'SALESFORCE_RETRYABLE',
      new Date('2026-11-16T10:00:05.000Z'),
    ],
  });
});

void test('configuration and executable shapes fail before storage or credentials', async () => {
  let calls = 0;
  const store = relayStore([]);
  store.recoverStale = async () => {
    calls++;
    return 0;
  };
  for (const invalid of [
    { ...configuration, leaseTimeoutMs: configuration.dispatchTimeoutMs },
    { ...configuration, batchLimit: 201 },
    { ...configuration, extra: true },
    Object.defineProperty({ ...configuration }, 'clientSecret', {
      get() {
        calls++;
        return 'private';
      },
    }),
  ])
    await assert.rejects(
      dispatchTenantSubmissionBatch(
        store,
        connectionStore(),
        tenantId,
        invalid,
        async () => [],
        now,
      ),
      (error: unknown) =>
        error instanceof SubmissionDispatcherError &&
        error.code === 'SUBMISSION_DISPATCH_INPUT',
    );
  assert.equal(calls, 0);
});
