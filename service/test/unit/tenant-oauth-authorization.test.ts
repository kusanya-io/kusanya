import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { test } from 'node:test';
import type {
  TenantConnectionInput,
  TenantConnectionStore,
} from '../../src/tenant/connection-store.js';
import {
  beginTenantSalesforceAuthorization,
  completeTenantSalesforceAuthorization,
  TenantOAuthTransactionStore,
  type TenantOAuthConfiguration,
} from '../../src/tenant/oauth-authorization.js';

const tenantId = '10000000-0000-4000-8000-000000000001';
const orgId = '00D000000000001EAA';
const otherOrgId = '00D000000000002EAA';
const userId = '005000000000001';
const stateSecretBytes = Buffer.alloc(32, 41);
const configuration: TenantOAuthConfiguration = Object.freeze({
  clientId: 'synthetic-client-id',
  clientSecret: 'synthetic-client-secret',
  redirectUri: 'https://service.example/oauth/salesforce/callback',
  stateSecret: stateSecretBytes.toString('base64'),
  timeoutMs: 1_000,
  transactionTtlSeconds: 300,
});
const startInput = Object.freeze({
  trustedTenantId: tenantId,
  expectedSalesforceOrgId: orgId,
  authorizationOrigin: 'https://login.salesforce.com',
  namespacePrefix: 'ksny__',
});

interface StoredTransaction {
  state_digest: unknown;
  tenant_id: unknown;
  expected_salesforce_org_id: unknown;
  authorization_origin: unknown;
  namespace_prefix: unknown;
}

function memoryStore() {
  const rows = new Map<string, StoredTransaction>();
  const observed: { text: string; values: unknown[] }[] = [];
  const store = new TenantOAuthTransactionStore({
    async query<Row>(text: string, values: unknown[] = []) {
      observed.push({ text, values });
      if (/^\s*INSERT/.test(text)) {
        for (const [digest, row] of rows)
          if (row.tenant_id === values[1]) rows.delete(digest);
        rows.set(String(values[0]), {
          state_digest: values[0],
          tenant_id: values[1],
          expected_salesforce_org_id: values[2],
          authorization_origin: values[3],
          namespace_prefix: values[4],
        });
        return { rowCount: 1, rows: [] };
      }
      if (/^\s*DELETE/.test(text)) {
        const digest = String(values[0]);
        const row = rows.get(digest);
        if (row === undefined) return { rowCount: 0, rows: [] };
        rows.delete(digest);
        return { rowCount: 1, rows: [row as Row] };
      }
      throw new Error('unexpected query');
    },
  });
  return { store, rows, observed };
}

function signedResponse(
  overrides: Record<string, unknown> = {},
  status = 200,
): Response {
  const id =
    typeof overrides.id === 'string'
      ? overrides.id
      : `https://login.salesforce.com/id/${orgId}/${userId}`;
  const issuedAt =
    typeof overrides.issued_at === 'string'
      ? overrides.issued_at
      : '1790000000000';
  const signature = createHmac('sha256', configuration.clientSecret)
    .update(id + issuedAt)
    .digest('base64');
  return new Response(
    JSON.stringify({
      access_token: 'synthetic-access-token',
      refresh_token: 'synthetic-refresh-token',
      signature,
      scope: 'api refresh_token',
      instance_url: 'https://tenant.my.salesforce.com',
      id,
      token_type: 'Bearer',
      issued_at: issuedAt,
      ...overrides,
    }),
    { status, headers: { 'content-type': 'application/json; charset=UTF-8' } },
  );
}

async function started(store: TenantOAuthTransactionStore) {
  const result = await beginTenantSalesforceAuthorization(
    store,
    startInput,
    configuration,
  );
  const url = new URL(result.authorizationUrl);
  return { result, url, state: url.searchParams.get('state')! };
}

function connectionStore(onSave: (value: Record<string, unknown>) => void) {
  return {
    async save(value: TenantConnectionInput) {
      onSave({ ...value });
      return Object.freeze({
        tenantId,
        salesforceOrgId: orgId,
        authorizationOrigin: 'https://login.salesforce.com',
        instanceOrigin: 'https://tenant.my.salesforce.com',
        namespacePrefix: 'ksny__',
        credentialVersion: 1,
        needsEncryptionRotation: false,
        getRefreshToken: () => 'synthetic-refresh-token',
      });
    },
  } satisfies Pick<TenantConnectionStore, 'save'>;
}

void test('starts a server-bound one-time PKCE authorization without storing browser secrets', async () => {
  const memory = memoryStore();
  const { result, url, state } = await started(memory.store);
  assert.equal(url.origin, 'https://login.salesforce.com');
  assert.equal(url.pathname, '/services/oauth2/authorize');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    response_type: 'code',
    client_id: configuration.clientId,
    redirect_uri: configuration.redirectUri,
    scope: 'api refresh_token',
    state,
    code_challenge: createHash('sha256')
      .update(
        createHmac('sha256', stateSecretBytes)
          .update('kusanya:tenant-oauth-pkce:v1\0')
          .update(state)
          .digest('base64url'),
      )
      .digest('base64url'),
    code_challenge_method: 'S256',
  });
  assert.equal(state.length, 43);
  assert.ok(Object.isFrozen(result));
  assert.equal(memory.rows.size, 1);
  const [digest, row] = [...memory.rows.entries()][0]!;
  assert.equal(digest, createHash('sha256').update(state).digest('hex'));
  assert.doesNotMatch(JSON.stringify(row), new RegExp(state));
  assert.doesNotMatch(
    JSON.stringify(memory.observed[0]?.values),
    /code_verifier|synthetic-client-secret/,
  );
  assert.equal(row.tenant_id, tenantId);
  assert.equal(row.expected_salesforce_org_id, orgId);
  assert.equal(memory.observed[0]?.values[5], 300);
});

void test('a new trusted start invalidates the prior pending state for that tenant', async () => {
  const memory = memoryStore();
  const first = await started(memory.store);
  const second = await started(memory.store);
  assert.notEqual(first.state, second.state);
  assert.equal(memory.rows.size, 1);
  let exchanges = 0;
  await assert.rejects(
    completeTenantSalesforceAuthorization(
      memory.store,
      connectionStore(() => assert.fail('must not save')),
      { state: first.state, code: 'synthetic-authorization-code' },
      configuration,
      async () => {
        exchanges++;
        return signedResponse();
      },
    ),
    { message: 'TENANT_OAUTH_STATE' },
  );
  assert.equal(exchanges, 0);
  assert.equal(
    [...memory.rows.keys()][0],
    createHash('sha256').update(second.state).digest('hex'),
  );
});

void test('exchanges once, verifies the signed org identity and saves only the final binding', async () => {
  const memory = memoryStore();
  const { state } = await started(memory.store);
  const requests: { url: string; init: RequestInit }[] = [];
  const saves: Record<string, unknown>[] = [];
  const result = await completeTenantSalesforceAuthorization(
    memory.store,
    connectionStore((value) => saves.push(value)),
    { state, code: 'synthetic-authorization-code' },
    configuration,
    async (input, init = {}) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      requests.push({ url, init });
      return signedResponse();
    },
  );
  assert.equal(memory.rows.size, 0);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0]?.url,
    'https://login.salesforce.com/services/oauth2/token',
  );
  const firstRequest = requests[0];
  assert.ok(firstRequest);
  const request = firstRequest.init;
  assert.equal(request.method, 'POST');
  assert.equal(request.cache, 'no-store');
  assert.equal(request.credentials, 'omit');
  assert.equal(request.redirect, 'manual');
  assert.equal(
    (request.headers as Record<string, string>)['content-type'],
    'application/x-www-form-urlencoded; charset=UTF-8',
  );
  const form = Object.fromEntries(new URLSearchParams(request.body as string));
  assert.deepEqual(form, {
    grant_type: 'authorization_code',
    client_id: configuration.clientId,
    client_secret: configuration.clientSecret,
    redirect_uri: configuration.redirectUri,
    code: 'synthetic-authorization-code',
    code_verifier: createHmac('sha256', stateSecretBytes)
      .update('kusanya:tenant-oauth-pkce:v1\0')
      .update(state)
      .digest('base64url'),
  });
  assert.deepEqual(saves, [
    {
      tenantId,
      salesforceOrgId: orgId,
      authorizationOrigin: 'https://login.salesforce.com',
      instanceOrigin: 'https://tenant.my.salesforce.com',
      namespacePrefix: 'ksny__',
      refreshToken: 'synthetic-refresh-token',
    },
  ]);
  assert.deepEqual(result, {
    tenantId,
    salesforceOrgId: orgId,
    instanceOrigin: 'https://tenant.my.salesforce.com',
    namespacePrefix: 'ksny__',
    credentialVersion: 1,
  });
  assert.doesNotMatch(JSON.stringify(result), /token|secret/i);
  assert.ok(Object.isFrozen(result));
});

void test('atomically consumes state so replay and concurrent callbacks cannot exchange twice', async () => {
  const memory = memoryStore();
  const { state } = await started(memory.store);
  let exchanges = 0;
  let saves = 0;
  const complete = () =>
    completeTenantSalesforceAuthorization(
      memory.store,
      connectionStore(() => saves++),
      { state, code: 'synthetic-authorization-code' },
      configuration,
      async () => {
        exchanges++;
        return signedResponse();
      },
    );
  const outcomes = await Promise.allSettled([complete(), complete()]);
  assert.equal(
    outcomes.filter((value) => value.status === 'fulfilled').length,
    1,
  );
  const rejected = outcomes.find((value) => value.status === 'rejected');
  assert.equal(rejected?.status, 'rejected');
  if (rejected?.status === 'rejected') {
    assert.ok(rejected.reason instanceof Error);
    assert.equal(rejected.reason.message, 'TENANT_OAUTH_STATE');
  }
  assert.equal(exchanges, 1);
  assert.equal(saves, 1);
  await assert.rejects(complete(), { message: 'TENANT_OAUTH_STATE' });
  assert.equal(exchanges, 1);
});

void test('consumes provider-error callbacks and never contacts Salesforce', async () => {
  const memory = memoryStore();
  const { state } = await started(memory.store);
  let exchanges = 0;
  await assert.rejects(
    completeTenantSalesforceAuthorization(
      memory.store,
      connectionStore(() => assert.fail('must not save')),
      { state, error: 'access_denied' },
      configuration,
      async () => {
        exchanges++;
        return signedResponse();
      },
    ),
    { message: 'TENANT_OAUTH_PROVIDER' },
  );
  assert.equal(exchanges, 0);
  assert.equal(memory.rows.size, 0);
});

void test('refuses wrong-org, bad-signature and partial grants without a half-written connection', async () => {
  const cases = [
    () =>
      signedResponse({
        id: `https://login.salesforce.com/id/${otherOrgId}/${userId}`,
      }),
    () =>
      signedResponse({
        signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      }),
    () => signedResponse({ refresh_token: null }),
    () => signedResponse({ instance_url: 'https://example.com' }),
    () => signedResponse({ unexpected: true }),
    () => signedResponse({}, 400),
  ];
  for (const response of cases) {
    const memory = memoryStore();
    const { state } = await started(memory.store);
    let saves = 0;
    await assert.rejects(
      completeTenantSalesforceAuthorization(
        memory.store,
        connectionStore(() => saves++),
        { state, code: 'synthetic-authorization-code' },
        configuration,
        async () => response(),
      ),
      /TENANT_OAUTH_(?:BINDING|PROVIDER)/,
    );
    assert.equal(saves, 0);
    assert.equal(memory.rows.size, 0);
  }
});

void test('refuses malformed and oversized provider responses after consuming state', async () => {
  const responses = [
    () =>
      new Response('not-json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    () =>
      new Response('x', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': '65537',
        },
      }),
    () =>
      new Response(new Uint8Array([0xff]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    () =>
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
  ];
  for (const response of responses) {
    const memory = memoryStore();
    const { state } = await started(memory.store);
    await assert.rejects(
      completeTenantSalesforceAuthorization(
        memory.store,
        connectionStore(() => assert.fail('must not save')),
        { state, code: 'synthetic-authorization-code' },
        configuration,
        async () => response(),
      ),
      { message: 'TENANT_OAUTH_PROVIDER' },
    );
    assert.equal(memory.rows.size, 0);
  }
});

void test('normalizes connection failures after consuming state without leaking credentials', async () => {
  const memory = memoryStore();
  const { state } = await started(memory.store);
  let error: Error | undefined;
  try {
    await completeTenantSalesforceAuthorization(
      memory.store,
      {
        async save() {
          throw new Error('synthetic-refresh-token private database detail');
        },
      } satisfies Pick<TenantConnectionStore, 'save'>,
      { state, code: 'synthetic-authorization-code' },
      configuration,
      async () => signedResponse(),
    );
  } catch (caught) {
    assert.ok(caught instanceof Error);
    error = caught;
  }
  assert.ok(error);
  assert.equal(error.message, 'TENANT_OAUTH_CONNECTION');
  assert.doesNotMatch(
    `${error.message}\n${error.stack ?? ''}`,
    /synthetic-refresh-token|private database detail/,
  );
  assert.equal(memory.rows.size, 0);
});

void test('enforces a fetch-independent deadline and ignores a late valid grant', async () => {
  const memory = memoryStore();
  const { state } = await started(memory.store);
  let resolveFetch!: (value: Response) => void;
  let signal: AbortSignal | undefined;
  let saves = 0;
  const startedAt = performance.now();
  await assert.rejects(
    completeTenantSalesforceAuthorization(
      memory.store,
      connectionStore(() => saves++),
      { state, code: 'synthetic-authorization-code' },
      { ...configuration, timeoutMs: 25 },
      async (_input, init) => {
        signal = init?.signal ?? undefined;
        return await new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        });
      },
    ),
    { message: 'TENANT_OAUTH_PROVIDER' },
  );
  assert.ok(performance.now() - startedAt < 1_000);
  assert.equal(signal?.aborted, true);
  assert.equal(memory.rows.size, 0);
  resolveFetch(signedResponse());
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(saves, 0);
});

void test('rejects hostile inputs and accessors before storage or network use', async () => {
  const memory = memoryStore();
  let getters = 0;
  const hostile = Object.defineProperty({}, 'trustedTenantId', {
    enumerable: true,
    get() {
      getters++;
      return tenantId;
    },
  });
  await assert.rejects(
    beginTenantSalesforceAuthorization(
      memory.store,
      hostile as never,
      configuration,
    ),
    { message: 'TENANT_OAUTH_INPUT' },
  );
  assert.equal(getters, 0);
  assert.equal(memory.observed.length, 0);
  const callbackMemory = memoryStore();
  const callbackState = (await started(callbackMemory.store)).state;
  const hostileCallback = Object.defineProperty(
    { state: callbackState },
    'code',
    {
      enumerable: true,
      get() {
        getters++;
        return 'synthetic-authorization-code';
      },
    },
  );
  await assert.rejects(
    completeTenantSalesforceAuthorization(
      callbackMemory.store,
      connectionStore(() => assert.fail('must not save')),
      hostileCallback as never,
      configuration,
    ),
    { message: 'TENANT_OAUTH_INPUT' },
  );
  assert.equal(getters, 0);
  assert.equal(callbackMemory.rows.size, 1);
  for (const invalid of [
    { ...startInput, trustedTenantId: `${tenantId}x` },
    { ...startInput, authorizationOrigin: 'https://example.com' },
    { ...startInput, expectedSalesforceOrgId: otherOrgId.slice(0, 17) + 'Z' },
    { ...startInput, namespacePrefix: 'ksny' },
    { ...startInput, extra: true },
  ])
    await assert.rejects(
      beginTenantSalesforceAuthorization(memory.store, invalid, configuration),
      { message: 'TENANT_OAUTH_INPUT' },
    );
  for (const invalid of [
    { ...configuration, redirectUri: 'http://service.example/callback' },
    { ...configuration, stateSecret: Buffer.alloc(31).toString('base64') },
    { ...configuration, timeoutMs: 0 },
    { ...configuration, transactionTtlSeconds: 901 },
  ])
    await assert.rejects(
      beginTenantSalesforceAuthorization(memory.store, startInput, invalid),
      { message: 'TENANT_OAUTH_INPUT' },
    );
});

void test('transaction store distinguishes absence from malformed or failed storage', async () => {
  const absent = new TenantOAuthTransactionStore({
    async query() {
      return { rowCount: 0, rows: [] };
    },
  });
  assert.equal(await absent.consume('a'.repeat(64)), undefined);
  await assert.rejects(absent.consume('not-a-digest'), {
    message: 'TENANT_OAUTH_INPUT',
  });
  const failed = new TenantOAuthTransactionStore({
    async query() {
      throw new Error('private database detail');
    },
  });
  await assert.rejects(failed.consume('a'.repeat(64)), {
    message: 'TENANT_OAUTH_STORAGE',
  });
});
