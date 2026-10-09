import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  attestSalesforcePublicationArtifacts,
  salesforceArtifactApiVersion,
  type SalesforceArtifactConfiguration,
} from '../../src/publication/salesforce-artifact-transport.js';

const versionIds = ['068000000000001AAA', '068000000000002AAA'] as const;
const documentIds = ['069000000000001AAA', '069000000000002AAA'] as const;
const xml = '<data><answer>safe</answer></data>';
const workbook = Uint8Array.from([80, 75, 3, 4, 1, 2, 3]);
const digest = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

function identity(
  xform = xml,
  xlsform = workbook,
): { packageJson: string; packageSha256: string } {
  const packageJson = JSON.stringify({
    schemaVersion: 2,
    kind: 'kusanya-publication-package',
    audience: 'publisher-only',
    authoring: {},
    targetSchema: {},
    targetObjects: [],
    submissionPolicy: {},
    warnings: [],
    xform: { xml: xform, sha256: digest(xform) },
    xlsform: {
      base64: Buffer.from(xlsform).toString('base64'),
      sha256: digest(xlsform),
    },
  });
  return { packageJson, packageSha256: digest(packageJson) };
}

const configuration = (
  extra: Partial<SalesforceArtifactConfiguration> = {},
): SalesforceArtifactConfiguration => ({
  instanceOrigin: 'https://example.my.salesforce.com',
  getAccessToken: async () => 'PRIVATE_TOKEN',
  perRequestTimeoutMs: 100,
  overallTimeoutMs: 1000,
  ...extra,
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

const saves = versionIds.map((id) => ({ id, success: true, errors: [] }));
const metadata = versionIds.map((Id, index) => ({
  attributes: { type: 'ContentVersion' },
  Id,
  ContentDocumentId: documentIds[index],
  IsLatest: true,
  FileExtension: index === 0 ? 'xml' : 'xlsx',
}));

void test('uploads atomically and returns exact version IDs only after byte readback', async () => {
  assert.equal(salesforceArtifactApiVersion, '64.0');
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let tokens = 0;
  const responses = [
    jsonResponse(saves),
    jsonResponse(metadata),
    new Response(xml),
    new Response(workbook),
  ];
  const result = await attestSalesforcePublicationArtifacts(
    configuration({ getAccessToken: async () => `token-${++tokens}` }),
    identity(),
    async (input, init) => {
      calls.push({ url: requestUrl(input), init });
      return responses.shift()!;
    },
  );
  assert.deepEqual(result, {
    ok: true,
    xformVersionId: versionIds[0],
    xlsformVersionId: versionIds[1],
    requestCount: 4,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(tokens, 4);
  assert.match(calls[0]!.url, /\/v64\.0\/composite\/sobjects$/u);
  assert.equal(typeof calls[0]!.init!.body, 'string');
  const upload = JSON.parse(calls[0]!.init!.body as string) as {
    allOrNone: boolean;
    records: Array<{ PathOnClient: string; VersionData: string }>;
  };
  assert.equal(upload.allOrNone, true);
  assert.equal(upload.records.length, 2);
  assert.deepEqual(
    upload.records.map((item: Record<string, unknown>) => item.PathOnClient),
    [`${identity().packageSha256}.xml`, `${identity().packageSha256}.xlsx`],
  );
  assert.equal(
    upload.records[0]!.VersionData,
    Buffer.from(xml).toString('base64'),
  );
  assert.equal(
    upload.records[1]!.VersionData,
    Buffer.from(workbook).toString('base64'),
  );
  assert.match(
    calls[1]!.url,
    /fields=Id,ContentDocumentId,IsLatest,FileExtension$/u,
  );
  assert.match(calls[2]!.url, new RegExp(`${versionIds[0]}/VersionData$`, 'u'));
  assert.match(calls[3]!.url, new RegExp(`${versionIds[1]}/VersionData$`, 'u'));
  for (const [index, call] of calls.entries()) {
    assert.equal(call.init?.cache, 'no-store');
    assert.equal(call.init?.credentials, 'omit');
    assert.equal(call.init?.redirect, 'manual');
    assert.equal(
      (call.init?.headers as Record<string, string>).authorization,
      `Bearer token-${index + 1}`,
    );
  }
});

void test('refuses malformed packages and hostile configuration before token or network I/O', async () => {
  let tokenCalls = 0;
  let fetchCalls = 0;
  const valid = identity();
  const accessor = { ...valid } as Record<string, unknown>;
  Object.defineProperty(accessor, 'packageJson', {
    enumerable: true,
    get() {
      throw new Error('PRIVATE_ACCESSOR');
    },
  });
  const invalid: unknown[] = [
    null,
    new Proxy(valid, {}),
    accessor,
    { ...valid, packageSha256: '0'.repeat(64) },
    { ...valid, extra: true },
  ];
  for (const packageValue of invalid) {
    const result = await attestSalesforcePublicationArtifacts(
      configuration({
        getAccessToken: async () => {
          tokenCalls++;
          return 'token';
        },
      }),
      packageValue as typeof valid,
      async () => {
        fetchCalls++;
        return jsonResponse(saves);
      },
    );
    assert.deepEqual(result, {
      ok: false,
      diagnostic: {
        code: 'PUBLICATION_ARTIFACT_PACKAGE',
        location: 'artifacts',
      },
      requestCount: 0,
    });
  }
  assert.equal(tokenCalls, 0);
  assert.equal(fetchCalls, 0);
});

void test('cleans both uploaded documents after an exact-byte mismatch', async () => {
  const calls: string[] = [];
  const responses = [
    jsonResponse(saves),
    jsonResponse(metadata),
    new Response('different'),
    new Response(null, { status: 204 }),
    new Response(null, { status: 204 }),
  ];
  const result = await attestSalesforcePublicationArtifacts(
    configuration(),
    identity(),
    async (input, init) => {
      calls.push(`${init?.method} ${requestUrl(input)}`);
      return responses.shift()!;
    },
  );
  assert.deepEqual(result, {
    ok: false,
    diagnostic: {
      code: 'PUBLICATION_ARTIFACT_MISMATCH',
      location: 'artifacts',
    },
    requestCount: 5,
  });
  assert.match(calls[3]!, new RegExp(`DELETE .*${documentIds[0]}$`, 'u'));
  assert.match(calls[4]!, new RegExp(`DELETE .*${documentIds[1]}$`, 'u'));
});

void test('reports cleanup failure without provider or token disclosure', async () => {
  const responses = [
    jsonResponse(saves),
    jsonResponse(metadata),
    new Response('different'),
    new Response('PRIVATE_PROVIDER', { status: 500 }),
    new Response(null, { status: 204 }),
  ];
  const result = await attestSalesforcePublicationArtifacts(
    configuration({ getAccessToken: async () => 'PRIVATE_TOKEN' }),
    identity(),
    async () => responses.shift()!,
  );
  assert.equal(result.ok, false);
  if (!result.ok)
    assert.equal(result.diagnostic.code, 'PUBLICATION_ARTIFACT_CLEANUP');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/iu);
});

void test('fails closed on malformed upload and metadata responses', async () => {
  for (const first of [
    jsonResponse([{ id: versionIds[0], success: true, errors: [] }]),
    jsonResponse([{ id: 'PRIVATE_ID', success: true, errors: [] }, saves[1]]),
    new Response('PRIVATE_PROVIDER', { status: 503 }),
  ]) {
    const result = await attestSalesforcePublicationArtifacts(
      configuration(),
      identity(),
      async () => first,
    );
    assert.equal(result.ok, false);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/iu);
  }
});

void test('bounds token acquisition and the shared attempt deadline', async () => {
  const result = await attestSalesforcePublicationArtifacts(
    configuration({
      getAccessToken: async () => await new Promise<never>(() => undefined),
      perRequestTimeoutMs: 10,
      overallTimeoutMs: 20,
    }),
    identity(),
  );
  assert.equal(result.ok, false);
  if (!result.ok)
    assert.equal(result.diagnostic.code, 'PUBLICATION_ARTIFACT_UPLOAD');
});
