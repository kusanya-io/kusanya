import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PublicationMaintenanceStore,
  runPublicationMaintenance,
  startPublicationMaintenanceScheduler,
  type PublicationMaintenanceCandidate,
  type PublicationMaintenanceConfiguration,
} from '../../src/publication/publication-maintenance.js';
import type {
  QueryConnection,
  QueryExecutor,
  QueryResult,
  TenantConnection,
} from '../../src/tenant/connection-store.js';
import type { TenantConnectionSessionStore } from '../../src/tenant/salesforce-session.js';

const tenantId = '10000000-0000-4000-8000-000000000001';
const attemptId = '10000000-0000-4000-8000-000000000009';
const orgId = '00D000000000001EAA';
const userId = '005000000000001';
const formVersionId = 'a0B000000000001AAA';
const xformVersionId = '068000000000001AAA';
const xlsformVersionId = '068000000000002AAA';
const digest = 'd'.repeat(64);

const configuration: PublicationMaintenanceConfiguration = Object.freeze({
  intervalMs: 3_600_000,
  staleAfterMs: 900_000,
  runTimeoutMs: 10_000,
  maxAttempts: 25,
  publisher: Object.freeze({
    clientId: 'client',
    clientSecret: 'secret',
    refreshTimeoutMs: 1_000,
    perRequestTimeoutMs: 1_000,
    overallTimeoutMs: 5_000,
  }),
});

function selected(
  outcome: 'started' | 'partial',
): PublicationMaintenanceCandidate {
  return Object.freeze({
    attemptId,
    tenantId,
    expectedSalesforceOrgId: orgId,
    authorizationOrigin: 'https://login.salesforce.com',
    namespacePrefix: '',
    outcome,
    formVersionId,
    publicationDigest: outcome === 'partial' ? digest : null,
    xformVersionId: outcome === 'partial' ? xformVersionId : null,
    xlsformVersionId: outcome === 'partial' ? xlsformVersionId : null,
  });
}

function maintenanceStore(
  candidates: readonly PublicationMaintenanceCandidate[],
) {
  const calls: unknown[][] = [];
  const value = {
    async withExclusiveRun<Value>(operation: () => Promise<Value>) {
      calls.push(['lock']);
      return { acquired: true as const, value: await operation() };
    },
    async listCandidates(staleAfterMs: number, maximum: number) {
      calls.push(['list', staleAfterMs, maximum]);
      return candidates;
    },
    async resolve(
      candidate: PublicationMaintenanceCandidate,
      status: string,
      requestCount: number,
    ) {
      calls.push(['resolve', candidate, status, requestCount]);
    },
    async applyScheduledRetention() {
      calls.push(['retain']);
      return 3;
    },
  } as unknown as PublicationMaintenanceStore;
  return { calls, value };
}

function connection(): TenantConnection {
  const value = {
    tenantId,
    salesforceOrgId: orgId,
    authorizationOrigin: 'https://login.salesforce.com',
    instanceOrigin: 'https://tenant.my.salesforce.com',
    namespacePrefix: '',
    credentialVersion: 1,
    needsEncryptionRotation: false,
  } as Record<string, unknown>;
  Object.defineProperty(value, 'getRefreshToken', {
    enumerable: false,
    value: () => 'refresh-token',
  });
  return Object.freeze(value) as unknown as TenantConnection;
}

function connectionStore(onSelect: () => void = () => {}) {
  return {
    async withRefreshLock<Value>(
      _tenant: string,
      operation: (
        selected: TenantConnection,
      ) => Promise<{ value: Value; rotatedRefreshToken?: string }>,
    ) {
      onSelect();
      const current = connection();
      const result = await operation(current);
      return { value: result.value, connection: current };
    },
  } satisfies TenantConnectionSessionStore;
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function requestUrl(input: string | URL | Request): string {
  return typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}

void test('marks stale started attempts indeterminate without credentials or Salesforce', async () => {
  const store = maintenanceStore([selected('started')]);
  let selectedConnection = false;
  let fetched = false;
  const result = await runPublicationMaintenance(
    store.value,
    connectionStore(() => {
      selectedConnection = true;
    }),
    configuration,
    async () => {
      fetched = true;
      throw new Error('must not run');
    },
  );
  assert.deepEqual(result, {
    acquired: true,
    selected: 1,
    reconciled: 0,
    indeterminate: 1,
    failed: 0,
    deferred: 0,
    retained: 3,
  });
  assert.equal(selectedConnection, false);
  assert.equal(fetched, false);
  assert.deepEqual(store.calls[2], [
    'resolve',
    selected('started'),
    'indeterminate',
    0,
  ]);
});

void test('inspects partial attempts read-only and never invokes publication endpoints', async () => {
  const store = maintenanceStore([selected('partial')]);
  const requests: { url: string; method: string }[] = [];
  const result = await runPublicationMaintenance(
    store.value,
    connectionStore(),
    configuration,
    async (input, init = {}) => {
      const url = requestUrl(input);
      requests.push({ url, method: String(init.method) });
      if (url.endsWith('/services/oauth2/token'))
        return json({
          access_token: 'access-token',
          instance_url: 'https://tenant.my.salesforce.com',
          id: `https://login.salesforce.com/id/${orgId}/${userId}`,
          token_type: 'Bearer',
        });
      return json({
        attributes: { type: 'Form_Version__c' },
        Id: formVersionId,
        Status__c: 'Published',
        Publication_Digest__c: digest,
        XForm_Version__c: xformVersionId,
        XLSForm_Version__c: xlsformVersionId,
      });
    },
  );
  assert.deepEqual(result, {
    acquired: true,
    selected: 1,
    reconciled: 1,
    indeterminate: 0,
    failed: 0,
    deferred: 0,
    retained: 3,
  });
  assert.deepEqual(
    requests.map(({ method }) => method),
    ['POST', 'GET'],
  );
  assert.equal(
    requests.some(({ url }) =>
      /publications\/commit|composite\/sobjects|ContentDocument/.test(url),
    ),
    false,
  );
  assert.deepEqual(store.calls[2], [
    'resolve',
    selected('partial'),
    'committed',
    1,
  ]);
});

void test('a failed inspection remains unresolved while safe retention still runs', async () => {
  const store = maintenanceStore([selected('partial')]);
  const result = await runPublicationMaintenance(
    store.value,
    connectionStore(),
    configuration,
    async (input) =>
      requestUrl(input).endsWith('/services/oauth2/token')
        ? json({
            access_token: 'access-token',
            instance_url: 'https://tenant.my.salesforce.com',
            id: `https://login.salesforce.com/id/${orgId}/${userId}`,
            token_type: 'Bearer',
          })
        : json({ hostile: true }),
  );
  assert.equal(result.failed, 1);
  assert.equal(result.reconciled, 0);
  assert.equal(
    store.calls.some(([kind]) => kind === 'resolve'),
    false,
  );
  assert.deepEqual(store.calls.at(-1), ['retain']);
});

void test('a concurrent replica performs no reads, OAuth or retention', async () => {
  let touched = false;
  const store = {
    async withExclusiveRun() {
      return { acquired: false as const };
    },
    async listCandidates() {
      touched = true;
      return [];
    },
  } as unknown as PublicationMaintenanceStore;
  const result = await runPublicationMaintenance(
    store,
    connectionStore(() => {
      touched = true;
    }),
    configuration,
  );
  assert.equal(result.acquired, false);
  assert.equal(touched, false);
});

void test('store session lock is released after failure and a loser does no work', async () => {
  const statements: string[] = [];
  let acquired = true;
  const connection: QueryConnection = {
    async query<Row>(text: string): Promise<QueryResult<Row>> {
      statements.push(text);
      if (text.includes('pg_try_advisory_lock'))
        return { rows: [{ acquired }] as Row[], rowCount: 1 };
      if (text.includes('pg_advisory_unlock'))
        return { rows: [{ released: true }] as Row[], rowCount: 1 };
      throw new Error('unexpected query');
    },
    release() {
      statements.push('RELEASE');
    },
  };
  const store = new PublicationMaintenanceStore({
    async query() {
      throw new Error('pool query must not run');
    },
    async connect() {
      return connection;
    },
  });
  await assert.rejects(
    store.withExclusiveRun(async () => {
      throw new Error('operation failed');
    }),
    /operation failed/,
  );
  assert.deepEqual(
    statements.map((statement) =>
      statement === 'RELEASE'
        ? statement
        : statement.includes('pg_try_advisory_lock')
          ? 'LOCK'
          : 'UNLOCK',
    ),
    ['LOCK', 'UNLOCK', 'RELEASE'],
  );

  statements.length = 0;
  acquired = false;
  let operated = false;
  assert.deepEqual(
    await store.withExclusiveRun(async () => {
      operated = true;
    }),
    { acquired: false },
  );
  assert.equal(operated, false);
  assert.deepEqual(
    statements.map((statement) =>
      statement === 'RELEASE' ? statement : 'LOCK',
    ),
    ['LOCK', 'RELEASE'],
  );
});

void test('store selection is globally bounded and rejects malformed rows', async () => {
  const queries: { text: string; values: unknown[] }[] = [];
  const row = {
    publication_attempt_id: attemptId,
    tenant_id: tenantId,
    expected_salesforce_org_id: orgId,
    authorization_origin: 'https://login.salesforce.com',
    namespace_prefix: '',
    outcome: 'partial',
    form_version_id: formVersionId,
    publication_digest: digest,
    xform_version_id: xformVersionId,
    xlsform_version_id: xlsformVersionId,
  };
  const executor: QueryExecutor = {
    async query<Row>(text: string, values: unknown[] = []) {
      queries.push({ text, values });
      return { rows: [row] as Row[], rowCount: 1 };
    },
  };
  const store = new PublicationMaintenanceStore(executor);
  assert.deepEqual(await store.listCandidates(900_000, 25), [
    selected('partial'),
  ]);
  assert.match(queries[0]!.text, /reconciliation_status IS NULL/);
  assert.match(queries[0]!.text, /LIMIT \$2/);
  assert.deepEqual(queries[0]!.values, [900_000, 25]);
  row.publication_digest = 'invalid';
  await assert.rejects(store.listCandidates(900_000, 25));
});

void test('store resolution refuses incoherent outcome evidence before querying', async () => {
  const queries: { text: string; values: unknown[] }[] = [];
  const store = new PublicationMaintenanceStore({
    async query<Row>(text: string, values: unknown[] = []) {
      queries.push({ text, values });
      return { rows: [] as Row[], rowCount: 1 };
    },
  });

  await assert.rejects(store.resolve(selected('started'), 'indeterminate', 1));
  await assert.rejects(store.resolve(selected('partial'), 'indeterminate', 1));
  await assert.rejects(store.resolve(selected('partial'), 'committed', 0));
  assert.equal(queries.length, 0);

  await store.resolve(selected('started'), 'indeterminate', 0);
  await store.resolve(selected('partial'), 'committed', 1);
  assert.equal(queries.length, 2);
});

void test('scheduled retention uses its own audit source in one transaction', async () => {
  const statements: string[] = [];
  const connection: QueryConnection = {
    async query<Row>(text: string): Promise<QueryResult<Row>> {
      statements.push(text);
      if (text.includes('deleted_count'))
        return { rows: [{ deleted_count: 2 }] as Row[], rowCount: 1 };
      if (text.includes('set_config'))
        return { rows: [{ set_config: '' }] as Row[], rowCount: 1 };
      return { rows: [], rowCount: null };
    },
    release() {
      statements.push('RELEASE');
    },
  };
  const store = new PublicationMaintenanceStore({
    async query() {
      throw new Error('pool query must not run');
    },
    async connect() {
      return connection;
    },
  });
  assert.equal(await store.applyScheduledRetention(), 2);
  assert.equal(statements[0], 'BEGIN');
  assert.match(statements[1]!, /publication_retention_actor/);
  assert.match(statements[2]!, /publication_retention_mode.*scheduled/s);
  assert.match(statements[3]!, /LIMIT \$1/);
  assert.match(statements[3]!, /'committed',\s*'artifacts_missing'/);
  assert.doesNotMatch(statements[3]!, /'unlinked'/);
  assert.equal(statements[4], 'COMMIT');
  assert.equal(statements[5], 'RELEASE');
});

void test('scheduler prevents local overlap and reports failed or deferred work', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  let failures = 0;
  const originalSetInterval = globalThis.setInterval;
  let unrefs = 0;
  globalThis.setInterval = ((callback: () => void, delay: number) => {
    const timer = originalSetInterval(callback, delay);
    const originalUnref = timer.unref.bind(timer);
    timer.unref = () => {
      unrefs += 1;
      return originalUnref();
    };
    return timer;
  }) as typeof setInterval;
  const scheduler = (() => {
    try {
      return startPublicationMaintenanceScheduler(
        60_000,
        async () => {
          calls += 1;
          await blocked;
          return {
            acquired: true,
            selected: 1,
            reconciled: 0,
            indeterminate: 0,
            failed: 1,
            deferred: 0,
            retained: 0,
          };
        },
        () => {
          failures += 1;
        },
      );
    } finally {
      globalThis.setInterval = originalSetInterval;
    }
  })();
  try {
    assert.equal(unrefs, 1);
    const first = scheduler.runNow();
    assert.equal(await scheduler.runNow(), undefined);
    release();
    await first;
    assert.equal(calls, 1);
    assert.equal(failures, 1);
  } finally {
    release();
    await scheduler.stop();
  }
  assert.equal(await scheduler.runNow(), undefined);
});
