import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  createSalesforceSubmissionDelivery,
  SalesforceSubmissionTransportError,
} from '../../src/submission/salesforce-submission-transport.js';
import type { ClaimedSubmission } from '../../src/submission/submission-relay-store.js';
import type { TenantSalesforceSession } from '../../src/tenant/salesforce-session.js';

const tenantId = '10000000-0000-4000-8000-000000000001';
const orgId = '00D000000000001EAA';

function submission(
  suffix: string,
  rawXml = new TextEncoder().encode('<data/>'),
): ClaimedSubmission {
  return Object.freeze({
    relayId: `20000000-0000-4000-8000-${suffix.padStart(12, '0')}`,
    tenantId,
    salesforceOrgId: orgId,
    authorizationOrigin: 'https://login.salesforce.com',
    namespacePrefix: 'ksny__',
    formVersionId: 'a2h000000000001AAA',
    instanceId: `uuid:123e4567-e89b-42d3-a456-${suffix.padStart(12, '0')}`,
    channel: 'phone',
    rawXml,
    xmlSha256: createHash('sha256').update(rawXml).digest('hex'),
    attempt: 1,
  });
}

function session(namespacePrefix = 'ksny__'): TenantSalesforceSession {
  const value = {
    tenantId,
    salesforceOrgId: orgId,
    instanceOrigin: 'https://tenant.my.salesforce.com',
    namespacePrefix,
    credentialVersion: 1,
  } as Omit<TenantSalesforceSession, 'getAccessToken'> & {
    getAccessToken?: () => Promise<string>;
  };
  Object.defineProperty(value, 'getAccessToken', {
    enumerable: false,
    value: async () => 'attempt-scoped-token',
  });
  return Object.freeze(value) as TenantSalesforceSession;
}

function request(
  submissions: readonly ClaimedSubmission[],
  namespacePrefix = 'ksny__',
) {
  return Object.freeze({
    session: session(namespacePrefix),
    submissions,
    signal: new AbortController().signal,
  });
}

const response = (outcomes: unknown): Response =>
  new Response(JSON.stringify({ schemaVersion: 1, outcomes }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function requestBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string')
    throw new TypeError('Expected string body');
  return init.body;
}

void test('sends one namespace-aware batch and maps only mapped to committed', async () => {
  const rows = [submission('1'), submission('2')];
  const calls: { url: string; init: RequestInit }[] = [];
  const deliver = createSalesforceSubmissionDelivery(async (input, init) => {
    calls.push({ url: requestUrl(input), init: init! });
    return response([
      { relayId: rows[0]!.relayId, status: 'mapped', code: 'MAPPED' },
      { relayId: rows[1]!.relayId, status: 'received', code: 'RECEIVED' },
    ]);
  });
  assert.deepEqual(await deliver(request(rows)), [
    { relayId: rows[0]!.relayId, disposition: 'committed' },
    { relayId: rows[1]!.relayId, disposition: 'retry' },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]!.url,
    'https://tenant.my.salesforce.com/services/apexrest/ksny/v1/submissions/ingest',
  );
  assert.equal(calls[0]!.init.method, 'POST');
  assert.equal(calls[0]!.init.redirect, 'manual');
  assert.equal(calls[0]!.init.credentials, 'omit');
  const body = JSON.parse(requestBody(calls[0]!.init)) as {
    schemaVersion: number;
    submissions: { rawXmlBase64: string }[];
  };
  assert.equal(body.schemaVersion, 1);
  assert.equal(body.submissions.length, 2);
  assert.equal(
    body.submissions[0]!.rawXmlBase64,
    Buffer.from(rows[0]!.rawXml).toString('base64'),
  );

  let emptyPath = '';
  await createSalesforceSubmissionDelivery(async (input) => {
    emptyPath = requestUrl(input);
    return response([
      { relayId: rows[0]!.relayId, status: 'retry', code: 'RETRY' },
    ]);
  })(request([rows[0]!], ''));
  assert.equal(
    emptyPath,
    'https://tenant.my.salesforce.com/services/apexrest/v1/submissions/ingest',
  );
});

void test('keeps one API call under the request bound and retries deferred rows', async () => {
  const rows = [
    submission('3', new Uint8Array(750_000).fill(1)),
    submission('4', new Uint8Array(750_000).fill(2)),
  ];
  let sent = 0;
  const result = await createSalesforceSubmissionDelivery(
    async (_input, init) => {
      sent++;
      const requestJson = requestBody(init);
      const body = JSON.parse(requestJson) as {
        submissions: { relayId: string }[];
      };
      assert.ok(Buffer.byteLength(requestJson) < 1_500_000);
      assert.ok(Buffer.byteLength(requestJson) > 1_000_000);
      assert.deepEqual(
        body.submissions.map((item) => item.relayId),
        [rows[0]!.relayId],
      );
      return response([
        { relayId: rows[0]!.relayId, status: 'received', code: 'RECEIVED' },
      ]);
    },
  )(request(rows));
  assert.equal(sent, 1);
  assert.deepEqual(result, [
    { relayId: rows[0]!.relayId, disposition: 'retry' },
    { relayId: rows[1]!.relayId, disposition: 'retry' },
  ]);
});

void test('refuses malformed response shapes and unknown closed values', async () => {
  const row = submission('5');
  for (const outcomes of [
    [],
    [{ relayId: row.relayId, status: 'unknown', code: 'MAPPED' }],
    [{ relayId: row.relayId, status: 'mapped', code: 'bad' }],
    [
      {
        relayId: row.relayId,
        status: 'mapped',
        code: 'MAPPED',
        extra: true,
      },
    ],
  ])
    await assert.rejects(
      createSalesforceSubmissionDelivery(async () => response(outcomes))(
        request([row]),
      ),
      SalesforceSubmissionTransportError,
    );
});

void test('fails closed on transport, media type and cancellation errors', async () => {
  const row = submission('6');
  for (const fetcher of [
    async () => new Response('{}', { status: 503 }),
    async () =>
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    async () => {
      throw new Error('private transport detail');
    },
  ])
    await assert.rejects(
      createSalesforceSubmissionDelivery(fetcher)(request([row])),
      (error: unknown) =>
        error instanceof SalesforceSubmissionTransportError &&
        error.message === 'SALESFORCE_SUBMISSION_TRANSPORT',
    );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    createSalesforceSubmissionDelivery()(
      Object.freeze({
        session: session(),
        submissions: [row],
        signal: controller.signal,
      }),
    ),
    SalesforceSubmissionTransportError,
  );
});
