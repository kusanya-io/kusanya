import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bootstrapAdministratorFromInput } from '../../src/bootstrap-administrator.js';
import { AdministratorSessionError } from '../../src/tenant/administrator-session.js';
import { administratorOidcActorId } from '../../src/tenant/oidc-login.js';

const issuer = 'https://login.example/tenant/v2.0';
const document = Object.freeze({
  subject: 'first-administrator',
  tenantId: '10000000-0000-4000-8000-000000000001',
  expectedSalesforceOrgId: '00D000000000001',
  authorizationOrigin: 'https://login.salesforce.com',
  namespacePrefix: 'ksny__',
});

async function* input(value: string): AsyncGenerator<Buffer> {
  const bytes = Buffer.from(value, 'utf8');
  yield bytes.subarray(0, Math.floor(bytes.length / 2));
  yield bytes.subarray(Math.floor(bytes.length / 2));
}

void test('maps the server-only bootstrap document through the configured OIDC issuer', async () => {
  const observed: unknown[] = [];
  await bootstrapAdministratorFromInput(
    input(JSON.stringify(document)),
    issuer,
    {
      async bootstrap(value) {
        observed.push(value);
      },
    },
  );
  assert.deepEqual(observed, [
    {
      actorId: administratorOidcActorId(issuer, document.subject),
      tenantId: document.tenantId,
      expectedSalesforceOrgId: document.expectedSalesforceOrgId,
      authorizationOrigin: document.authorizationOrigin,
      namespacePrefix: document.namespacePrefix,
    },
  ]);
});

void test('refuses extra selectors, malformed UTF-8 and oversized input before storage', async () => {
  let calls = 0;
  const store = {
    async bootstrap() {
      calls++;
    },
  };
  for (const value of [
    JSON.stringify({ ...document, actorId: 'forged' }),
    JSON.stringify({ ...document, tenantId: undefined }),
    '{',
  ])
    await assert.rejects(
      bootstrapAdministratorFromInput(input(value), issuer, store),
      { message: 'ADMINISTRATOR_SESSION_INPUT' },
    );
  async function* invalidUtf8() {
    yield Buffer.from([0xc3, 0x28]);
  }
  await assert.rejects(
    bootstrapAdministratorFromInput(invalidUtf8(), issuer, store),
    { message: 'ADMINISTRATOR_SESSION_INPUT' },
  );
  await assert.rejects(
    bootstrapAdministratorFromInput(input(' '.repeat(16_385)), issuer, store),
    { message: 'ADMINISTRATOR_SESSION_INPUT' },
  );
  assert.equal(calls, 0);
});

void test('propagates one fixed replay refusal without exposing the document', async () => {
  await assert.rejects(
    bootstrapAdministratorFromInput(input(JSON.stringify(document)), issuer, {
      async bootstrap() {
        throw new AdministratorSessionError('ADMINISTRATOR_SESSION_CONFLICT');
      },
    }),
    (error: unknown) =>
      error instanceof AdministratorSessionError &&
      error.code === 'ADMINISTRATOR_SESSION_CONFLICT' &&
      !error.stack?.includes(document.subject),
  );
});
