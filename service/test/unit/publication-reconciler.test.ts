import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  reconcilePublicationAttempt,
  type PublicationReconcilerConfiguration,
} from '../../src/publication/publication-reconciler.js';
import type {
  PublicationAttemptStore,
  ReconcilablePublicationAttempt,
} from '../../src/publication/publication-attempt-store.js';
import type { TenantConnection } from '../../src/tenant/connection-store.js';
import type { TenantConnectionSessionStore } from '../../src/tenant/salesforce-session.js';

const tenantId = '10000000-0000-4000-8000-000000000001';
const orgId = '00D000000000001EAA';
const userId = '005000000000001';
const attemptId = '10000000-0000-4000-8000-000000000009';
const formVersionId = 'a0B000000000001AAA';
const xformVersionId = '068000000000001AAA';
const xlsformVersionId = '068000000000002AAA';
const digest = 'd'.repeat(64);
const context = Object.freeze({
  actorId: 'oidc:synthetic',
  tenantId,
  expectedSalesforceOrgId: orgId,
  authorizationOrigin: 'https://login.salesforce.com',
  namespacePrefix: '',
  role: 'administrator' as const,
  csrfToken: 'c'.repeat(43),
});
const configuration: PublicationReconcilerConfiguration = Object.freeze({
  clientId: 'client',
  clientSecret: 'secret',
  refreshTimeoutMs: 1_000,
  perRequestTimeoutMs: 1_000,
  overallTimeoutMs: 5_000,
});

const partial: ReconcilablePublicationAttempt = Object.freeze({
  outcome: 'partial',
  formVersionId,
  publicationDigest: digest,
  xformVersionId,
  xlsformVersionId,
});

function attemptStore(
  loaded: ReconcilablePublicationAttempt,
  resolve: PublicationAttemptStore['resolve'] = async (
    _context,
    _attemptId,
    _outcome,
    status,
    requestCount,
  ) => ({ status, requestCount }),
) {
  const calls: unknown[][] = [];
  return {
    calls,
    value: {
      async loadReconcilable(...args: unknown[]) {
        calls.push(['load', ...args]);
        return loaded;
      },
      async resolve(...args: Parameters<PublicationAttemptStore['resolve']>) {
        calls.push(['resolve', ...args]);
        return await resolve(...args);
      },
    } as Pick<PublicationAttemptStore, 'loadReconcilable' | 'resolve'>,
  };
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

function connectionStore(
  onSelect: () => void = () => {},
): TenantConnectionSessionStore {
  return {
    async withRefreshLock(_tenant, operation) {
      onSelect();
      const selected = connection();
      const result = await operation(selected);
      return { value: result.value, connection: selected };
    },
  };
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

void test('resolves a started row as indeterminate with zero Salesforce or credential access', async () => {
  const store = attemptStore({ outcome: 'started', formVersionId });
  let selected = false;
  let fetched = false;
  const result = await reconcilePublicationAttempt(
    store.value,
    connectionStore(() => {
      selected = true;
    }),
    context,
    attemptId,
    configuration,
    async () => {
      fetched = true;
      throw new Error('must not run');
    },
  );
  assert.deepEqual(result, {
    ok: true,
    status: 'indeterminate',
    salesforceRequestCount: 0,
  });
  assert.equal(selected, false);
  assert.equal(fetched, false);
  assert.deepEqual(store.calls[1], [
    'resolve',
    context,
    attemptId,
    'started',
    'indeterminate',
    0,
  ]);
});

void test('returns an existing immutable resolution without OAuth or Salesforce I/O', async () => {
  const store = attemptStore({
    outcome: 'reconciled',
    status: 'unlinked',
    requestCount: 2,
  });
  let selected = false;
  const result = await reconcilePublicationAttempt(
    store.value,
    connectionStore(() => {
      selected = true;
    }),
    context,
    attemptId,
    configuration,
  );
  assert.deepEqual(result, {
    ok: true,
    status: 'unlinked',
    salesforceRequestCount: 2,
  });
  assert.equal(selected, false);
  assert.equal(store.calls.length, 1);
});

void test('inspects a partial attempt read-only and resolves exact committed evidence', async () => {
  const store = attemptStore(partial);
  const requests: { url: string; method: string }[] = [];
  const result = await reconcilePublicationAttempt(
    store.value,
    connectionStore(),
    context,
    attemptId,
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
    ok: true,
    status: 'committed',
    salesforceRequestCount: 1,
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
  assert.deepEqual(store.calls[1], [
    'resolve',
    context,
    attemptId,
    'partial',
    'committed',
    1,
  ]);
});

void test('inspection refusal preserves partial and never calls resolve', async () => {
  const store = attemptStore(partial);
  const result = await reconcilePublicationAttempt(
    store.value,
    connectionStore(),
    context,
    attemptId,
    configuration,
    async (input) =>
      requestUrl(input).endsWith('/services/oauth2/token')
        ? json({
            access_token: 'access-token',
            instance_url: 'https://tenant.my.salesforce.com',
            id: `https://login.salesforce.com/id/${orgId}/${userId}`,
            token_type: 'Bearer',
          })
        : json({ unexpected: true }),
  );
  assert.deepEqual(result, {
    ok: false,
    code: 'PUBLICATION_RECONCILIATION_INSPECTION',
    salesforceRequestCount: 1,
  });
  assert.equal(store.calls.length, 1);
});

void test('a racing resolver returns the winner and cannot overwrite it', async () => {
  const store = attemptStore(
    { outcome: 'started', formVersionId },
    async () => ({ status: 'indeterminate', requestCount: 0 }),
  );
  const results = await Promise.all([
    reconcilePublicationAttempt(
      store.value,
      connectionStore(),
      context,
      attemptId,
      configuration,
    ),
    reconcilePublicationAttempt(
      store.value,
      connectionStore(),
      context,
      attemptId,
      configuration,
    ),
  ]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(store.calls.filter(([kind]) => kind === 'resolve').length, 2);
});
