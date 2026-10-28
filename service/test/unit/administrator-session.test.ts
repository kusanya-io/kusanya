import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AdministratorSessionError,
  AdministratorSessionStore,
  decodeTrustedAdministratorContext,
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
const bootstrap = Object.freeze({
  actorId: actor,
  tenantId,
  expectedSalesforceOrgId: '00D000000000001',
  authorizationOrigin: 'https://login.salesforce.com',
  namespacePrefix: 'ksny__',
});
const provisioning = Object.freeze({
  ...bootstrap,
  performedByActorId: actor,
  role: 'administrator' as const,
});

void test('one shared context decoder normalizes IDs and refuses executable shapes', () => {
  const decoded = decodeTrustedAdministratorContext({
    actorId: actor,
    tenantId,
    expectedSalesforceOrgId: '00D000000000001',
    authorizationOrigin: 'https://login.salesforce.com',
    namespacePrefix: 'ksny__',
    role: 'administrator',
    csrfToken: 'c'.repeat(43),
  });
  assert.equal(decoded.expectedSalesforceOrgId, orgId);
  assert.ok(Object.isFrozen(decoded));
  let getters = 0;
  const hostile = Object.defineProperty({}, 'actorId', {
    enumerable: true,
    get() {
      getters++;
      return actor;
    },
  });
  assert.throws(() => decodeTrustedAdministratorContext(hostile), {
    message: 'ADMINISTRATOR_SESSION_INPUT',
  });
  assert.equal(getters, 0);
});

interface BindingRow {
  actor_id: string;
  tenant_id: string;
  active: boolean;
  role: 'administrator' | 'publisher' | 'reviewer';
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
          active: true,
          role: 'administrator',
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
      if (/tenant_administrator_role_audits/.test(text)) {
        const proposed: BindingRow = {
          actor_id: String(values[0]),
          tenant_id: String(values[1]),
          active: true,
          role: String(values[6]) as BindingRow['role'],
        };
        const performer = bindings.get(String(values[5]));
        const tenant = tenants.get(proposed.tenant_id);
        const existing = bindings.get(proposed.actor_id);
        if (
          performer?.tenant_id !== proposed.tenant_id ||
          performer.role !== 'administrator' ||
          tenant === undefined ||
          tenant.expected_salesforce_org_id !== values[2] ||
          tenant.authorization_origin !== values[3] ||
          tenant.namespace_prefix !== values[4] ||
          (existing !== undefined &&
            (existing.tenant_id !== proposed.tenant_id ||
              !existing.active ||
              existing.role !== proposed.role))
        )
          return { rowCount: 0, rows: [] } satisfies QueryResult<Row>;
        if (existing === undefined) bindings.set(proposed.actor_id, proposed);
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
  const targetActor = 'administrator:publisher';
  const targetProvisioning = {
    ...provisioning,
    actorId: targetActor,
    role: 'publisher' as const,
  };
  await store.bootstrap(bootstrap);
  await store.provision(targetProvisioning);
  await store.provision({
    ...targetProvisioning,
    expectedSalesforceOrgId: orgId,
  });
  assert.deepEqual(memory.bindings.get(targetActor), {
    actor_id: targetActor,
    tenant_id: tenantId,
    active: true,
    role: 'publisher',
  });
  assert.deepEqual(memory.tenants.get(tenantId), {
    tenant_id: tenantId,
    expected_salesforce_org_id: orgId,
    authorization_origin: 'https://login.salesforce.com',
    namespace_prefix: 'ksny__',
  });
  for (const changed of [
    { ...targetProvisioning, tenantId: otherTenantId },
    {
      ...targetProvisioning,
      expectedSalesforceOrgId: '00D000000000002EAA',
    },
    {
      ...targetProvisioning,
      authorizationOrigin: 'https://test.salesforce.com',
    },
    { ...targetProvisioning, namespacePrefix: '' },
    { ...targetProvisioning, role: 'reviewer' as const },
  ])
    await assert.rejects(store.provision(changed), {
      message: 'ADMINISTRATOR_SESSION_CONFLICT',
    });
  assert.equal(memory.bindings.get(targetActor)?.tenant_id, tenantId);
});

void test('bootstraps once with database uniqueness plus an atomic lifecycle audit', async () => {
  const queries: { text: string; values: unknown[] }[] = [];
  const store = new AdministratorSessionStore({
    async query<Row>(text: string, values: unknown[] = []) {
      queries.push({ text, values });
      return {
        rowCount: 1,
        rows: [{ administrator_lifecycle_audit_id: '1' } as Row],
      } satisfies QueryResult<Row>;
    },
  });
  await store.bootstrap(bootstrap);
  assert.equal(queries.length, 1);
  assert.doesNotMatch(queries[0]!.text, /pg_advisory_xact_lock/);
  assert.match(
    queries[0]!.text,
    /WHERE tenant_id = \$2::uuid OR actor_id = \$1/,
  );
  assert.match(queries[0]!.text, /tenant_administrator_lifecycle_audits/);
  assert.match(queries[0]!.text, /'bootstrap'/);
  assert.deepEqual(queries[0]!.values, [
    actor,
    tenantId,
    orgId,
    provisioning.authorizationOrigin,
    provisioning.namespacePrefix,
  ]);

  const replay = new AdministratorSessionStore({
    async query<Row>() {
      return { rowCount: 0, rows: [] } satisfies QueryResult<Row>;
    },
  });
  await assert.rejects(replay.bootstrap(bootstrap), {
    message: 'ADMINISTRATOR_SESSION_CONFLICT',
  });
});

void test('deprovisions atomically without permitting self-removal or rebinding', async () => {
  const queries: string[] = [];
  const store = new AdministratorSessionStore({
    async query<Row>(text: string) {
      queries.push(text);
      return {
        rowCount: 1,
        rows: [{ administrator_lifecycle_audit_id: '2' } as Row],
      } satisfies QueryResult<Row>;
    },
  });
  await store.deprovision({
    performedByActorId: actor,
    targetActorId: 'administrator:departing',
    tenantId,
  });
  assert.equal(queries.length, 1);
  assert.match(queries[0]!, /FOR UPDATE OF binding/);
  assert.match(queries[0]!, /SELECT count\(\*\) FROM locked/);
  assert.match(queries[0]!, /SET active = false/);
  assert.match(queries[0]!, /DELETE FROM administrator_sessions/);
  assert.match(queries[0]!, /tenant_administrator_lifecycle_audits/);
  assert.match(queries[0]!, /'deprovision'/);

  await assert.rejects(
    store.deprovision({
      performedByActorId: actor,
      targetActorId: actor,
      tenantId,
    }),
    { message: 'ADMINISTRATOR_SESSION_CONFLICT' },
  );
  assert.equal(queries.length, 1);

  const absent = new AdministratorSessionStore({
    async query<Row>() {
      return { rowCount: 0, rows: [] } satisfies QueryResult<Row>;
    },
  });
  await assert.rejects(
    absent.deprovision({
      performedByActorId: actor,
      targetActorId: 'administrator:absent',
      tenantId,
    }),
    { message: 'ADMINISTRATOR_SESSION_CONFLICT' },
  );
});

void test('changes a peer role atomically while protecting self and the last administrator', async () => {
  const queries: { text: string; values: unknown[] }[] = [];
  const store = new AdministratorSessionStore({
    async query<Row>(text: string, values: unknown[] = []) {
      queries.push({ text, values });
      return {
        rowCount: 1,
        rows: [{ administrator_role_audit_id: '3' } as Row],
      } satisfies QueryResult<Row>;
    },
  });
  await store.changeRole({
    performedByActorId: actor,
    targetActorId: 'administrator:peer',
    tenantId,
    role: 'publisher',
  });
  assert.equal(queries.length, 1);
  assert.match(queries[0]!.text, /FOR UPDATE OF binding/);
  assert.match(queries[0]!.text, /performer\.role = 'administrator'/);
  assert.match(queries[0]!.text, /SELECT count\(\*\) FROM locked/);
  assert.match(queries[0]!.text, /SET role = \$4/);
  assert.match(queries[0]!.text, /tenant_administrator_role_audits/);
  assert.match(queries[0]!.text, /'change'/);
  assert.deepEqual(queries[0]!.values, [
    actor,
    'administrator:peer',
    tenantId,
    'publisher',
  ]);

  await assert.rejects(
    store.changeRole({
      performedByActorId: actor,
      targetActorId: actor,
      tenantId,
      role: 'reviewer',
    }),
    { message: 'ADMINISTRATOR_SESSION_CONFLICT' },
  );
  assert.equal(queries.length, 1);

  const refused = new AdministratorSessionStore({
    async query<Row>() {
      return { rowCount: 0, rows: [] } satisfies QueryResult<Row>;
    },
  });
  await assert.rejects(
    refused.changeRole({
      performedByActorId: actor,
      targetActorId: 'administrator:last-peer',
      tenantId,
      role: 'reviewer',
    }),
    { message: 'ADMINISTRATOR_SESSION_CONFLICT' },
  );
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
  await assert.rejects(
    store.provision({ ...provisioning, role: 'owner' as never }),
    { message: 'ADMINISTRATOR_SESSION_INPUT' },
  );
  await assert.rejects(
    store.changeRole({
      performedByActorId: actor,
      targetActorId: 'administrator:peer',
      tenantId,
      role: 'owner' as never,
    }),
    { message: 'ADMINISTRATOR_SESSION_INPUT' },
  );
  assert.equal(memory.bindings.size, 0);
  assert.equal(memory.tenants.size, 0);

  await store.bootstrap(bootstrap);
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
  await store.bootstrap(bootstrap);
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
    role: 'administrator',
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
  await store.bootstrap(bootstrap);
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
  await store.bootstrap(bootstrap);
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
