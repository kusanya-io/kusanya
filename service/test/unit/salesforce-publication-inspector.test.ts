import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  inspectSalesforcePublication,
  type SalesforcePublicationInspectionRequest,
} from '../../src/publication/salesforce-publication-inspector.js';
import type { TenantSalesforceSession } from '../../src/tenant/salesforce-session.js';

const formVersionId = 'a0B000000000001AAA';
const xformVersionId = '068000000000001AAA';
const xlsformVersionId = '068000000000002AAA';
const digest = 'd'.repeat(64);
const selected: SalesforcePublicationInspectionRequest = Object.freeze({
  formVersionId,
  publicationDigest: digest,
  xformVersionId,
  xlsformVersionId,
});

function session(prefix = ''): TenantSalesforceSession {
  const value = {
    tenantId: '10000000-0000-4000-8000-000000000001',
    salesforceOrgId: '00D000000000001EAA',
    instanceOrigin: 'https://tenant.my.salesforce.com',
    namespacePrefix: prefix,
    credentialVersion: 1,
  } as Record<string, unknown>;
  Object.defineProperty(value, 'getAccessToken', {
    enumerable: false,
    value: async () => 'attempt-scoped-token',
  });
  return Object.freeze(value) as unknown as TenantSalesforceSession;
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=UTF-8' },
  });
}

function requestUrl(input: string | URL | Request): string {
  return typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}

function form(prefix: string, status: string, identities: boolean) {
  return {
    attributes: { type: `${prefix}Form_Version__c` },
    Id: formVersionId,
    [`${prefix}Status__c`]: status,
    [`${prefix}Publication_Digest__c`]: identities ? digest : null,
    [`${prefix}XForm_Version__c`]: identities ? xformVersionId : null,
    [`${prefix}XLSForm_Version__c`]: identities ? xlsformVersionId : null,
  };
}

function version(id: string, documentId: string, kind: 'xform' | 'xlsform') {
  return {
    attributes: { type: 'ContentVersion' },
    Id: id,
    ContentDocumentId: documentId,
    Title: `kusanya-${digest}-${kind}`,
    FileExtension: kind === 'xform' ? 'xml' : 'xlsx',
  };
}

void test('recognizes an exact committed publication with one read-only request', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const result = await inspectSalesforcePublication(
    session('ksny__'),
    selected,
    1_000,
    5_000,
    async (input, init = {}) => {
      requests.push({ url: requestUrl(input), init });
      return json(form('ksny__', 'Published', true));
    },
  );
  assert.deepEqual(result, { ok: true, status: 'committed', requestCount: 1 });
  assert.equal(requests.length, 1);
  assert.match(requests[0]!.url, /sobjects\/ksny__Form_Version__c\//);
  assert.equal(requests[0]!.init.method, 'GET');
  assert.equal(requests[0]!.init.body, undefined);
});

void test('distinguishes exact unlinked artifacts from no remaining artifacts', async () => {
  for (const [records, expected] of [
    [
      [
        version(xlsformVersionId, '069000000000002AAA', 'xlsform'),
        version(xformVersionId, '069000000000001AAA', 'xform'),
      ],
      'unlinked',
    ],
    [[], 'artifacts_missing'],
  ] as const) {
    const methods: string[] = [];
    const result = await inspectSalesforcePublication(
      session(),
      selected,
      1_000,
      5_000,
      async (input, init = {}) => {
        methods.push(String(init.method));
        if (requestUrl(input).includes('/sobjects/Form_Version__c/'))
          return json(form('', 'Draft', false));
        assert.match(decodeURIComponent(requestUrl(input)), /WHERE Id IN/);
        return json({ totalSize: records.length, done: true, records });
      },
    );
    assert.deepEqual(result, { ok: true, status: expected, requestCount: 2 });
    assert.deepEqual(methods, ['GET', 'GET']);
  }
});

void test('refuses mixed, mismatched and contradictory remote evidence without mutation', async () => {
  const variants = [
    [version(xformVersionId, '069000000000001AAA', 'xform')],
    [
      version(xformVersionId, '069000000000001AAA', 'xform'),
      {
        ...version(xlsformVersionId, '069000000000002AAA', 'xlsform'),
        Title: 'wrong',
      },
    ],
  ];
  for (const records of variants) {
    const result = await inspectSalesforcePublication(
      session(),
      selected,
      1_000,
      5_000,
      async (input) =>
        requestUrl(input).includes('/sobjects/Form_Version__c/')
          ? json(form('', 'Draft', false))
          : json({ totalSize: records.length, done: true, records }),
    );
    assert.deepEqual(result, {
      ok: false,
      code: 'PUBLICATION_RECONCILIATION_INSPECTION',
      requestCount: 2,
    });
  }
  const contradictory = await inspectSalesforcePublication(
    session(),
    selected,
    1_000,
    5_000,
    async () =>
      json({
        ...form('', 'Published', true),
        Publication_Digest__c: '0'.repeat(64),
      }),
  );
  assert.equal(contradictory.ok, false);
});

void test('refuses hostile inputs before token or network access', async () => {
  let calls = 0;
  const hostile = new Proxy(selected, {});
  const result = await inspectSalesforcePublication(
    session(),
    hostile,
    1_000,
    5_000,
    async () => {
      calls++;
      throw new Error('must not run');
    },
  );
  assert.deepEqual(result, {
    ok: false,
    code: 'PUBLICATION_RECONCILIATION_INSPECTION',
    requestCount: 0,
  });
  assert.equal(calls, 0);

  let traps = 0;
  const hostileSession = new Proxy(session(), {
    ownKeys() {
      traps++;
      throw new Error('must not inspect');
    },
  });
  const sessionResult = await inspectSalesforcePublication(
    hostileSession,
    selected,
    1_000,
    5_000,
    async () => {
      calls++;
      throw new Error('must not run');
    },
  );
  assert.deepEqual(sessionResult, {
    ok: false,
    code: 'PUBLICATION_RECONCILIATION_INSPECTION',
    requestCount: 0,
  });
  assert.equal(traps, 0);
  assert.equal(calls, 0);
});
