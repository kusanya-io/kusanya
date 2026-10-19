import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AdministratorSessionError,
  AdministratorSessionStore,
} from '../../src/tenant/administrator-session.js';
import type {
  QueryExecutor,
  QueryResult,
} from '../../src/tenant/connection-store.js';

const tenantId = '10000000-0000-4000-8000-000000000001';
const otherTenantId = '20000000-0000-4000-8000-000000000002';
const orgId = '00D000000000001EAA';
const actor = 'administrator:synthetic';
const sessionSecret = Buffer.alloc(32, 61).toString('base64');
const configuration = Object.freeze({ sessionSecret, ttlSeconds: 900 });
const provisioning = Object.freeze({
  actorId: actor,
  tenantId,
  expectedSalesforceOrgId: '00D000000000001',
  authorizationOrigin: 'https://login.salesforce.com',
  namespacePrefix: 'ksny__',
});

interface BindingRow {
  actor_id: string;
  tenant_id: string;
}

interface TenantRow {
  tenant_id: string;
  expected_salesforce_org_id: string;
  authorization_origin: string;
  namespace_prefix: string;
}

interface SessionRow {
  session_digest: string;
  actor_id: string;
  expires_at: number;
}

function memoryDatabase() {
  const bindings = new Map<string, BindingRow>();
  const tenants = new Map<string, TenantRow>();
  const sessions = new Map<string, SessionRow>();
  const observed: { text: string; values: unknown[] }[] = [];
  let now = Date.now();
  const database: QueryExecutor = {
    async query<Row>(text: string, values: unknown[] = []) {
      observed.push({ text, values });
      if (/INSERT INTO tenant_administrator_tenants/.test(text)) {
        const proposedTenant: TenantRow = {
          tenant_id: String(values[1]),
          expected_salesforce_org_id: String(values[2]),
          authorization_origin: String(values[3]),
          namespace_prefix: String(values[4]),
        };
        const existingTenant = tenants.get(proposedTenant.tenant_id);
        if (
          existingTenant !== undefined &&
          JSON.stringify(existingTenant) !== JSON.stringify(proposedTenant)
        )
          return { rowCount: 0, rows: [] } satisfies QueryResult<Row>;
        const proposed: BindingRow = {
          actor_id: String(values[0]),
          tenant_id: String(values[1]),
        };
        const existing = bindings.get(proposed.actor_id);
        if (
          existing !== undefined &&
          JSON.stringify(existing) !== JSON.stringify(proposed)
        )
          return { rowCount: 0, rows: [] } satisfies QueryResult<Row>;
        tenants.set(proposedTenant.tenant_id, proposedTenant);
        bindings.set(proposed.actor_id, proposed);
        return {
          rowCount: 1,
          rows: [{ actor_id: proposed.actor_id } as Row],
        } satisfies QueryResult<Row>;
      }
      if (/INSERT INTO administrator_sessions/.test(text)) {
        const digest = String(values[0]);
        const actorId = String(values[1]);
        const binding = bindings.get(actorId);
        if (binding === undefined)
          return { rowCount: 0, rows: [] } satisfies QueryResult<Row>;
        for (const [key, session] of sessions)
          if (session.actor_id === actorId) sessions.delete(key);
        sessions.set(digest, {
          session_digest: digest,
          actor_id: actorId,
          expires_at: now + Number(values[2]) * 1000,
        });
        return {
          rowCount: 1,
          rows: [{ session_digest: digest } as Row],
        } satisfies QueryResult<Row>;
      }
      if (/WITH expired AS/.test(text)) {
        const digest = String(values[0]);
        const session = sessions.get(digest);
        if (session === undefined)
          return { rowCount: 0, rows: [] } satisfies QueryResult<Row>;
        if (session.expires_at <= now) {
          sessions.delete(digest);
          return { rowCount: 0, rows: [] } satisfies QueryResult<Row>;
        }
        const binding = bindings.get(session.actor_id);
        const tenant =
          binding === undefined ? undefined : tenants.get(binding.tenant_id);
        return {
          rowCount: binding === undefined || tenant === undefined ? 0 : 1,
          rows:
            binding === undefined || tenant === undefined
              ? []
              : [{ ...binding, ...tenant } as Row],
        } satisfies QueryResult<Row>;
      }
      if (
        /DELETE FROM administrator_sessions WHERE session_digest/.test(text)
      ) {
        const deleted = sessions.delete(String(values[0]));
        return {
          rowCount: deleted ? 1 : 0,
          rows: [],
        } satisfies QueryResult<Row>;
      }
      if (/DELETE FROM administrator_sessions WHERE actor_id/.test(text)) {
        const entry = [...sessions].find(
          ([, session]) => session.actor_id === values[0],
        );
        if (entry !== undefined) sessions.delete(entry[0]);
        return {
          rowCount: entry === undefined ? 0 : 1,
          rows: [],
        } satisfies QueryResult<Row>;
      }
      throw new Error('unexpected query');
    },
  };
  return {
    database,
    bindings,
    tenants,
    sessions,
    observed,
    advance(milliseconds: number) {
      now += milliseconds;
    },
  };
}

void test('provisions an exact immutable actor binding and normalizes the org ID', async () => {
  const memory = memoryDatabase();
  const store = new AdministratorSessionStore(memory.database);
  await store.provision(provisioning);
  await store.provision({
    ...provisioning,
    expectedSalesforceOrgId: orgId,
  });
  assert.deepEqual(memory.bindings.get(actor), {
    actor_id: actor,
    tenant_id: tenantId,
  });
  assert.deepEqual(memory.tenants.get(tenantId), {
    tenant_id: tenantId,
    expected_salesforce_org_id: orgId,
    authorization_origin: 'https://login.salesforce.com',
    namespace_prefix: 'ksny__',
  });
  for (const changed of [
    { ...provisioning, tenantId: otherTenantId },
    {
      ...provisioning,
      expectedSalesforceOrgId: '00D000000000002EAA',
    },
    { ...provisioning, authorizationOrigin: 'https://test.salesforce.com' },
    { ...provisioning, namespacePrefix: '' },
  ])
    await assert.rejects(store.provision(changed), {
      message: 'ADMINISTRATOR_SESSION_CONFLICT',
    });
  assert.equal(memory.bindings.get(actor)?.tenant_id, tenantId);
});

void test('refuses invalid namespaces and tenant-wide Salesforce disagreements before issuing a session', async () => {
  const memory = memoryDatabase();
  const store = new AdministratorSessionStore(memory.database);
  for (const namespacePrefix of ['MyNs__', 'my_ns__', 'Evil__'])
    await assert.rejects(
      store.provision({ ...provisioning, namespacePrefix }),
      {
        message: 'ADMINISTRATOR_SESSION_INPUT',
      },
    );
  assert.equal(memory.bindings.size, 0);
  assert.equal(memory.tenants.size, 0);

  await store.provision(provisioning);
  const otherActor = 'administrator:other';
  for (const changed of [
    { expectedSalesforceOrgId: '00D000000000002EAA' },
    { authorizationOrigin: 'https://test.salesforce.com' },
    { namespacePrefix: '' },
  ])
    await assert.rejects(
      store.provision({ ...provisioning, ...changed, actorId: otherActor }),
      { message: 'ADMINISTRATOR_SESSION_CONFLICT' },
    );
  await assert.rejects(store.issue(otherActor, configuration), {
    message: 'ADMINISTRATOR_SESSION_ABSENT',
  });
  assert.equal(memory.bindings.size, 1);
  assert.equal(memory.tenants.size, 1);
});

void test('maps only a direct PostgreSQL uniqueness code to a provisioning conflict', async () => {
  const conflict = new AdministratorSessionStore({
    async query() {
      throw Object.defineProperty(
        new Error('private database detail'),
        'code',
        {
          enumerable: true,
          value: '23505',
        },
      ) as Error & { code: string };
    },
  });
  await assert.rejects(conflict.provision(provisioning), {
    message: 'ADMINISTRATOR_SESSION_CONFLICT',
  });

  let getters = 0;
  const accessorError = Object.defineProperty(
    new Error('private accessor detail'),
    'code',
    {
      enumerable: true,
      get() {
        getters++;
        return '23505';
      },
    },
  );
  const storage = new AdministratorSessionStore({
    async query() {
      throw accessorError;
    },
  });
  await assert.rejects(storage.provision(provisioning), {
    message: 'ADMINISTRATOR_SESSION_STORAGE',
  });
  assert.equal(getters, 0);
});

void test('issues only fresh random sessions, stores only digests and derives CSRF', async () => {
  const memory = memoryDatabase();
  const store = new AdministratorSessionStore(memory.database);
  await store.provision(provisioning);
  const first = await store.issue(actor, configuration);
  assert.match(first.opaqueSession, /^[A-Za-z0-9_-]{43}$/);
  assert.match(first.csrfToken, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(Object.isFrozen(first));
  assert.equal(first.expiresInSeconds, 900);
  const serializedValues = JSON.stringify(memory.observed);
  assert.doesNotMatch(serializedValues, new RegExp(first.opaqueSession));
  assert.doesNotMatch(serializedValues, new RegExp(first.csrfToken));
  const authenticated = await store.authenticate(
    first.opaqueSession,
    configuration,
  );
  assert.deepEqual(authenticated, {
    actorId: actor,
    tenantId,
    expectedSalesforceOrgId: orgId,
    authorizationOrigin: 'https://login.salesforce.com',
    namespacePrefix: 'ksny__',
    csrfToken: first.csrfToken,
  });
  assert.ok(Object.isFrozen(authenticated));

  const second = await store.issue(actor, configuration);
  assert.notEqual(second.opaqueSession, first.opaqueSession);
  assert.equal(
    await store.authenticate(first.opaqueSession, configuration),
    undefined,
  );
  assert.equal(
    (await store.authenticate(second.opaqueSession, configuration))?.actorId,
    actor,
  );
});

void test('revokes immediately, idempotently, by session or trusted actor', async () => {
  const memory = memoryDatabase();
  const store = new AdministratorSessionStore(memory.database);
  await store.provision(provisioning);
  const first = await store.issue(actor, configuration);
  assert.equal(await store.revoke(first.opaqueSession), true);
  assert.equal(await store.revoke(first.opaqueSession), false);
  assert.equal(
    await store.authenticate(first.opaqueSession, configuration),
    undefined,
  );
  const second = await store.issue(actor, configuration);
  assert.equal(await store.revokeActor(actor), true);
  assert.equal(await store.revokeActor(actor), false);
  assert.equal(
    await store.authenticate(second.opaqueSession, configuration),
    undefined,
  );
});

void test('self-cleans expired sessions and never upgrades caller-supplied tokens', async () => {
  const memory = memoryDatabase();
  const store = new AdministratorSessionStore(memory.database);
  await store.provision(provisioning);
  const fixedPreloginToken = 'f'.repeat(43);
  assert.equal(
    await store.authenticate(fixedPreloginToken, configuration),
    undefined,
  );
  const issued = await store.issue(actor, configuration);
  assert.notEqual(issued.opaqueSession, fixedPreloginToken);
  memory.advance(901_000);
  assert.equal(
    await store.authenticate(issued.opaqueSession, configuration),
    undefined,
  );
  assert.equal(memory.sessions.size, 0);
});

void test('refuses absent actors, hostile inputs and malformed storage without leaking details', async () => {
  let calls = 0;
  const store = new AdministratorSessionStore({
    async query<Row>() {
      calls++;
      return { rowCount: 0, rows: [] } satisfies QueryResult<Row>;
    },
  });
  await assert.rejects(store.issue(actor, configuration), {
    message: 'ADMINISTRATOR_SESSION_ABSENT',
  });
  assert.equal(calls, 1);
  let getters = 0;
  const hostile = Object.defineProperty({}, 'actorId', {
    enumerable: true,
    get() {
      getters++;
      return actor;
    },
  });
  await assert.rejects(store.provision(hostile as never), {
    message: 'ADMINISTRATOR_SESSION_INPUT',
  });
  assert.equal(getters, 0);
  assert.equal(calls, 1);
  const hostileConfiguration = Object.defineProperty({}, 'sessionSecret', {
    enumerable: true,
    get() {
      getters++;
      return sessionSecret;
    },
  });
  await assert.rejects(store.issue(actor, hostileConfiguration as never), {
    message: 'ADMINISTRATOR_SESSION_INPUT',
  });
  assert.equal(getters, 0);
  for (const invalid of [
    { ...configuration, sessionSecret: Buffer.alloc(31).toString('base64') },
    { ...configuration, ttlSeconds: 299 },
    { ...provisioning, authorizationOrigin: 'https://example.com' },
    { ...provisioning, extra: true },
  ])
    await assert.rejects(
      'sessionSecret' in invalid || 'ttlSeconds' in invalid
        ? store.issue(actor, invalid as never)
        : store.provision(invalid),
      { message: 'ADMINISTRATOR_SESSION_INPUT' },
    );
  assert.equal(calls, 1);

  const malformed = new AdministratorSessionStore({
    async query<Row>() {
      return {
        rowCount: 1,
        rows: [{ actor_id: 'private-malformed-value' } as Row],
      } satisfies QueryResult<Row>;
    },
  });
  const opaque = 'x'.repeat(43);
  await assert.rejects(
    malformed.authenticate(opaque, configuration),
    (error: unknown) =>
      error instanceof AdministratorSessionError &&
      error.code === 'ADMINISTRATOR_SESSION_STORAGE' &&
      !error.stack?.includes('private-malformed-value'),
  );

  const accessorRow = new AdministratorSessionStore({
    async query<Row>() {
      return {
        rowCount: 1,
        rows: [
          Object.defineProperty({}, 'actor_id', {
            enumerable: true,
            get() {
              getters++;
              return actor;
            },
          }) as Row,
        ],
      } satisfies QueryResult<Row>;
    },
  });
  await assert.rejects(accessorRow.authenticate(opaque, configuration), {
    message: 'ADMINISTRATOR_SESSION_STORAGE',
  });
  assert.equal(getters, 0);
});
