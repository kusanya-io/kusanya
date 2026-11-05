import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanupPublicationArtifacts } from '../../src/publication/publication-artifact-cleanup.js';
import type { PublicationAttemptStore } from '../../src/publication/publication-attempt-store.js';
import type { TenantConnection } from '../../src/tenant/connection-store.js';
import type { TenantConnectionSessionStore } from '../../src/tenant/salesforce-session.js';

const tenantId = '10000000-0000-4000-8000-000000000001';
const orgId = '00D000000000001EAA';
const userId = '005000000000001';
const sourceAttemptId = '10000000-0000-4000-8000-000000000009';
const cleanupAttemptId = '20000000-0000-4000-8000-000000000009';
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
const configuration = Object.freeze({
  clientId: 'client',
  clientSecret: 'secret',
  refreshTimeoutMs: 1000,
  perRequestTimeoutMs: 1000,
  overallTimeoutMs: 5000,
});

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

const connectionStore: TenantConnectionSessionStore = {
  async withRefreshLock(_tenant, operation) {
    const selected = connection();
    const result = await operation(selected);
    return { value: result.value, connection: selected };
  },
};

function store() {
  const calls: unknown[][] = [];
  const value = {
    async startArtifactCleanup(...args: unknown[]) {
      calls.push(['start', ...args]);
      return {
        cleanupAttemptId,
        formVersionId,
        publicationDigest: digest,
        xformVersionId,
        xlsformVersionId,
        priorOutcome: 'started' as const,
      };
    },
    async completeArtifactCleanup(
      ...args: Parameters<PublicationAttemptStore['completeArtifactCleanup']>
    ) {
      calls.push(['complete', ...args]);
      return args[2];
    },
  };
  return {
    calls,
    value: value as Pick<
      PublicationAttemptStore,
      'startArtifactCleanup' | 'completeArtifactCleanup'
    >,
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function form() {
  return {
    attributes: { type: 'Form_Version__c' },
    Id: formVersionId,
    Status__c: 'Draft',
    Publication_Digest__c: null,
    XForm_Version__c: null,
    XLSForm_Version__c: null,
  };
}

function versions(records = true) {
  return {
    totalSize: records ? 2 : 0,
    done: true,
    records: records
      ? [
          {
            attributes: { type: 'ContentVersion' },
            Id: xformVersionId,
            ContentDocumentId: '069000000000001AAA',
            Title: `kusanya-${digest}-xform`,
            FileExtension: 'xml',
          },
          {
            attributes: { type: 'ContentVersion' },
            Id: xlsformVersionId,
            ContentDocumentId: '069000000000002AAA',
            Title: `kusanya-${digest}-xlsform`,
            FileExtension: 'xlsx',
          },
        ]
      : [],
  };
}

function oauth() {
  return json({
    access_token: 'access-token',
    instance_url: 'https://tenant.my.salesforce.com',
    id: `https://login.salesforce.com/id/${orgId}/${userId}`,
    token_type: 'Bearer',
  });
}

void test('deletes only after exact unlinked inspection and records success', async () => {
  const setup = store();
  const methods: string[] = [];
  const result = await cleanupPublicationArtifacts(
    setup.value,
    connectionStore,
    context,
    sourceAttemptId,
    configuration,
    async (input, init = {}) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      methods.push(String(init.method));
      if (url.endsWith('/services/oauth2/token')) return oauth();
      if (url.includes('/sobjects/')) return json(form());
      if (url.includes('/query?')) return json(versions());
      if (url.includes('/artifacts/cleanup'))
        return json({ schemaVersion: 1, deleted: true });
      throw new Error('unexpected request');
    },
  );
  assert.deepEqual(result, { ok: true, outcome: 'succeeded' });
  assert.deepEqual(methods, ['POST', 'GET', 'GET', 'POST']);
  assert.deepEqual(setup.calls.at(-1), [
    'complete',
    context,
    cleanupAttemptId,
    'succeeded',
    3,
  ]);
});

void test('an uncertain delete is reconciled to success only when both artifacts are absent', async () => {
  const setup = store();
  let formReads = 0;
  let queryReads = 0;
  const result = await cleanupPublicationArtifacts(
    setup.value,
    connectionStore,
    context,
    sourceAttemptId,
    configuration,
    async (input) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.endsWith('/services/oauth2/token')) return oauth();
      if (url.includes('/sobjects/')) {
        formReads++;
        return json(form());
      }
      if (url.includes('/query?')) {
        queryReads++;
        return json(versions(queryReads === 1));
      }
      if (url.includes('/artifacts/cleanup')) return json({}, 503);
      throw new Error('unexpected request');
    },
  );
  assert.deepEqual(result, { ok: true, outcome: 'succeeded' });
  assert.equal(formReads, 2);
  assert.equal(queryReads, 2);
  assert.deepEqual(setup.calls.at(-1), [
    'complete',
    context,
    cleanupAttemptId,
    'succeeded',
    5,
  ]);
});

void test('committed evidence refuses before the cleanup mutation', async () => {
  const setup = store();
  let deleted = false;
  const result = await cleanupPublicationArtifacts(
    setup.value,
    connectionStore,
    context,
    sourceAttemptId,
    configuration,
    async (input) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.endsWith('/services/oauth2/token')) return oauth();
      if (url.includes('/sobjects/'))
        return json({
          attributes: { type: 'Form_Version__c' },
          Id: formVersionId,
          Status__c: 'Published',
          Publication_Digest__c: digest,
          XForm_Version__c: xformVersionId,
          XLSForm_Version__c: xlsformVersionId,
        });
      deleted = true;
      throw new Error('not reached');
    },
  );
  assert.deepEqual(result, { ok: false, outcome: 'failed' });
  assert.equal(deleted, false);
});

void test('hostile configuration fails before storage, credentials or network', async () => {
  let starts = 0;
  let connections = 0;
  let fetches = 0;
  let getterCalls = 0;
  const hostile = {
    clientId: 'client',
    clientSecret: 'secret',
    refreshTimeoutMs: 1000,
    perRequestTimeoutMs: 1000,
    overallTimeoutMs: 5000,
  } as Record<string | symbol, unknown>;
  Object.defineProperty(hostile, Symbol('hidden'), {
    get() {
      getterCalls++;
      return 'hidden';
    },
  });
  const result = await cleanupPublicationArtifacts(
    {
      async startArtifactCleanup() {
        starts++;
        throw new Error('not reached');
      },
      async completeArtifactCleanup() {
        throw new Error('not reached');
      },
    },
    {
      async withRefreshLock() {
        connections++;
        return undefined;
      },
    },
    context,
    sourceAttemptId,
    hostile as unknown as typeof configuration,
    async () => {
      fetches++;
      throw new Error('not reached');
    },
  );
  assert.deepEqual(result, { ok: false, outcome: 'failed' });
  assert.equal(getterCalls, 0);
  assert.equal(starts, 0);
  assert.equal(connections, 0);
  assert.equal(fetches, 0);
});
