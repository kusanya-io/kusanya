import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deleteSalesforcePublicationArtifacts } from '../../src/publication/salesforce-artifact-cleaner.js';
import type { TenantSalesforceSession } from '../../src/tenant/salesforce-session.js';

const request = Object.freeze({
  formVersionId: 'a0B000000000001AAA',
  publicationDigest: 'd'.repeat(64),
  xformVersionId: '068000000000001AAA',
  xlsformVersionId: '068000000000002AAA',
});

function session(namespacePrefix = ''): TenantSalesforceSession {
  const value = {
    tenantId: '10000000-0000-4000-8000-000000000001',
    salesforceOrgId: '00D000000000001EAA',
    instanceOrigin: 'https://tenant.my.salesforce.com',
    namespacePrefix,
    credentialVersion: 1,
  } as Omit<TenantSalesforceSession, 'getAccessToken'> & {
    getAccessToken?: () => Promise<string>;
  };
  Object.defineProperty(value, 'getAccessToken', {
    enumerable: false,
    value: async () => 'access-token',
  });
  return Object.freeze(value) as TenantSalesforceSession;
}

void test('calls only the namespaced atomic cleanup resource with exact evidence', async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const result = await deleteSalesforcePublicationArtifacts(
    session('ksny__'),
    request,
    1000,
    5000,
    async (input, init) => {
      calls.push({
        url:
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        init,
      });
      return new Response(JSON.stringify({ schemaVersion: 1, deleted: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  );
  assert.deepEqual(result, { ok: true, requestCount: 1 });
  assert.equal(
    calls[0]!.url,
    'https://tenant.my.salesforce.com/services/apexrest/ksny/v1/publications/artifacts/cleanup',
  );
  assert.equal(calls[0]!.init?.method, 'POST');
  const body = calls[0]!.init?.body;
  if (typeof body !== 'string') assert.fail('cleanup body must be text');
  assert.deepEqual(JSON.parse(body), {
    schemaVersion: 1,
    ...request,
  });
  assert.equal(
    (calls[0]!.init?.headers as Record<string, string>).authorization,
    'Bearer access-token',
  );
});

void test('fails closed on hostile input and malformed or oversized responses', async () => {
  let calls = 0;
  const invalid = await deleteSalesforcePublicationArtifacts(
    session(),
    { ...request, publicationDigest: 'wrong' },
    1000,
    5000,
    async () => {
      calls++;
      throw new Error('not reached');
    },
  );
  assert.deepEqual(invalid, {
    ok: false,
    code: 'PUBLICATION_ARTIFACT_CLEANUP',
    requestCount: 0,
  });
  assert.equal(calls, 0);

  for (const response of [
    new Response('[]', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    new Response(JSON.stringify({ schemaVersion: 1, deleted: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    new Response('x'.repeat(4097), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    new Response('{}', {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }),
  ]) {
    const result = await deleteSalesforcePublicationArtifacts(
      session(),
      request,
      1000,
      5000,
      async () => response,
    );
    assert.deepEqual(result, {
      ok: false,
      code: 'PUBLICATION_ARTIFACT_CLEANUP',
      requestCount: 1,
    });
  }
});

void test('refuses executable or malformed session capabilities before access', async () => {
  let getterCalls = 0;
  let fetchCalls = 0;
  const accessorSession = {
    tenantId: '10000000-0000-4000-8000-000000000001',
    salesforceOrgId: '00D000000000001EAA',
    instanceOrigin: 'https://tenant.my.salesforce.com',
    namespacePrefix: '',
    credentialVersion: 1,
  } as Record<string, unknown>;
  Object.defineProperty(accessorSession, 'getAccessToken', {
    enumerable: false,
    get() {
      getterCalls++;
      return async () => 'access-token';
    },
  });
  for (const hostile of [
    accessorSession,
    new Proxy(session(), {}),
    Object.freeze({
      ...session(),
      instanceOrigin: 'https://user:password@tenant.my.salesforce.com',
    }),
  ]) {
    const result = await deleteSalesforcePublicationArtifacts(
      hostile as unknown as TenantSalesforceSession,
      request,
      1000,
      5000,
      async () => {
        fetchCalls++;
        throw new Error('not reached');
      },
    );
    assert.deepEqual(result, {
      ok: false,
      code: 'PUBLICATION_ARTIFACT_CLEANUP',
      requestCount: 0,
    });
  }
  assert.equal(getterCalls, 0);
  assert.equal(fetchCalls, 0);
});
