import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AdministratorInvitationError,
  AdministratorInvitationStore,
} from '../../src/tenant/administrator-invitation.js';
import type { QueryExecutor } from '../../src/tenant/connection-store.js';

const tenantId = '10000000-0000-4000-8000-000000000001';
const performer = 'oidc:performer';
const target = 'oidc:target';
const sessionConfiguration = Object.freeze({
  sessionSecret: Buffer.alloc(32, 41).toString('base64'),
  ttlSeconds: 900,
});

interface QueryCall {
  readonly text: string;
  readonly values: unknown[];
}

function executor(
  handler: (call: QueryCall, index: number) => unknown = () => ({
    rows: [{ accepted: true }],
    rowCount: 1,
  }),
): { readonly database: QueryExecutor; readonly calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  return {
    calls,
    database: {
      async query<Row>(text: string, values: unknown[] = []) {
        const call = { text, values };
        calls.push(call);
        return handler(call, calls.length - 1) as {
          rows: Row[];
          rowCount: number | null;
        };
      },
    },
  };
}

void test('issues unguessable tenant-bound tokens without probing target membership', async () => {
  const setup = executor();
  const store = new AdministratorInvitationStore(setup.database);
  const first = await store.issue(
    {
      performedByActorId: performer,
      targetActorId: target,
      tenantId,
      role: 'publisher',
    },
    { ttlSeconds: 3600 },
  );
  const second = await store.issue(
    {
      performedByActorId: performer,
      targetActorId: target,
      tenantId,
      role: 'publisher',
    },
    { ttlSeconds: 3600 },
  );
  assert.match(first.invitationId, /^[0-9a-f-]{36}$/);
  assert.match(first.invitationToken, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.invitationToken, second.invitationToken);
  assert.equal(first.expiresInSeconds, 3600);
  assert.deepEqual(setup.calls[0]?.values.slice(0, 3), [
    performer,
    target,
    tenantId,
  ]);
  assert.equal(setup.calls[0]?.values[5], 'publisher');
  assert.equal(setup.calls[0]?.values[6], 3600);
  assert.match(setup.calls[0].text, /binding\.role = 'administrator'/);
  assert.match(setup.calls[0].text, /FOR UPDATE OF binding/);
  assert.doesNotMatch(
    setup.calls[0].text,
    /NOT EXISTS[\s\S]*tenant_administrator_bindings[\s\S]*actor_id = \$2/,
  );
  assert.doesNotMatch(JSON.stringify(setup.calls), /invitationToken/);
});

void test('accepts from the stored role in one statement and never accepts a request role', async () => {
  const setup = executor();
  const store = new AdministratorInvitationStore(setup.database);
  const issued = await store.accept(
    { actorId: target, invitationToken: 'i'.repeat(43) },
    sessionConfiguration,
  );
  assert.match(issued.opaqueSession, /^[A-Za-z0-9_-]{43}$/);
  assert.match(issued.csrfToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.expiresInSeconds, 900);
  assert.equal(setup.calls.length, 1);
  assert.match(setup.calls[0]!.text, /pending\.role/);
  assert.match(
    setup.calls[0]!.text,
    /INSERT INTO tenant_administrator_bindings/,
  );
  assert.match(setup.calls[0]!.text, /UPDATE tenant_administrator_invitations/);
  assert.match(setup.calls[0]!.text, /tenant_administrator_role_audits/);
  assert.match(setup.calls[0]!.text, /INSERT INTO administrator_sessions/);
  assert.match(setup.calls[0]!.text, /FOR UPDATE OF pending, issuer/);
  assert.match(String(setup.calls[0]?.values[0]), /^[0-9a-f]{64}$/);
  assert.equal(setup.calls[0]?.values[1], target);
  assert.equal(setup.calls[0]?.values.length, 4);
});

void test('treats replay, expiry, revocation, wrong subject and binding conflicts as the same rejection', async () => {
  for (const response of [
    { rows: [], rowCount: 0 },
    Object.assign(new Error('duplicate private row'), { code: '23505' }),
  ]) {
    const setup = executor(() => {
      if (response instanceof Error) throw response;
      return response;
    });
    const store = new AdministratorInvitationStore(setup.database);
    await assert.rejects(
      store.accept(
        { actorId: target, invitationToken: 'i'.repeat(43) },
        sessionConfiguration,
      ),
      (error: unknown) =>
        error instanceof AdministratorInvitationError &&
        error.code === 'ADMINISTRATOR_INVITATION_REJECTED',
    );
  }
});

void test('revocation is idempotent and scoped by performer, tenant and invitation id', async () => {
  for (const rowCount of [0, 1]) {
    const setup = executor(() => ({
      rows: rowCount === 1 ? [{ invitation_id: 'private' }] : [],
      rowCount,
    }));
    const store = new AdministratorInvitationStore(setup.database);
    await store.revoke({
      performedByActorId: performer,
      invitationId: '10000000-0000-4000-8000-000000000001',
      tenantId,
    });
    assert.deepEqual(setup.calls[0]?.values, [
      performer,
      '10000000-0000-4000-8000-000000000001',
      tenantId,
    ]);
    assert.match(setup.calls[0].text, /binding\.role = 'administrator'/);
    assert.match(setup.calls[0].text, /FOR UPDATE OF binding/);
    assert.match(
      setup.calls[0].text,
      /pending\.tenant_id = performer\.tenant_id/,
    );
  }
});

void test('refuses hostile shapes, accessors and out-of-range configurations before SQL', async () => {
  const setup = executor();
  const store = new AdministratorInvitationStore(setup.database);
  let getterCalls = 0;
  const hostile = Object.defineProperty({}, 'actorId', {
    enumerable: true,
    get() {
      getterCalls++;
      return target;
    },
  });
  for (const operation of [
    () =>
      store.issue(
        {
          performedByActorId: performer,
          targetActorId: target,
          tenantId,
          role: 'owner' as never,
        },
        { ttlSeconds: 3600 },
      ),
    () =>
      store.issue(
        {
          performedByActorId: performer,
          targetActorId: target,
          tenantId,
          role: 'reviewer',
        },
        { ttlSeconds: 299 },
      ),
    () => store.accept(hostile as never, sessionConfiguration),
    () =>
      store.accept(
        { actorId: target, invitationToken: 'short' },
        sessionConfiguration,
      ),
  ])
    await assert.rejects(operation(), {
      message: 'ADMINISTRATOR_INVITATION_INPUT',
    });
  assert.equal(getterCalls, 0);
  assert.equal(setup.calls.length, 0);
});
