import assert from 'node:assert/strict';
import { test } from 'node:test';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { exportXlsFormWorkbook } from '../../src/interchange/xlsx-workbook.js';
import { verifySalesforceXlsFormRoundTrip } from '../../src/interchange/salesforce-roundtrip.js';
import { reviewerFixture } from '../fixtures/print.js';

const versionId = 'a01AA0000000001YAA';
const configuration = {
  instanceOrigin: 'https://synthetic.my.salesforce.com',
  getAccessToken: async () => 'synthetic-token',
  perRequestTimeoutMs: 1000,
  overallTimeoutMs: 3000,
};

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=UTF-8' },
  });
}

function workbook(): Uint8Array {
  const fixture = reviewerFixture();
  const result = exportXlsFormWorkbook(fixture.form, fixture.mappings);
  assert.ok(result.ok);
  return result.workbook;
}

function editedWorkbook(): Uint8Array {
  const entries = unzipSync(workbook());
  const path = 'xl/worksheets/sheet1.xml';
  const xml = strFromU8(entries[path]!);
  assert.ok(xml.includes('School name'));
  entries[path] = strToU8(xml.replace('School name', 'Edited school name'));
  return zipSync(entries, { level: 6, mtime: new Date(1980, 0, 1) });
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  const body = init?.body;
  if (typeof body !== 'string') assert.fail('expected string request body');
  return JSON.parse(body) as Record<string, unknown>;
}

void test('imports, snapshots and proves normalized compiled XML byte equality', async () => {
  let requests = 0;
  const result = await verifySalesforceXlsFormRoundTrip(
    configuration,
    editedWorkbook(),
    async (input, init) => {
      requests++;
      assert.equal(init?.method, 'POST');
      assert.equal(init?.redirect, 'manual');
      assert.equal(init?.credentials, 'omit');
      assert.equal(
        (init?.headers as Record<string, string>).authorization,
        'Bearer synthetic-token',
      );
      const request = requestBody(init);
      if (requestUrl(input).endsWith('/v1/definitions/import')) {
        assert.deepEqual(Object.keys(request).sort(), [
          'definition',
          'mappingBundle',
          'schemaVersion',
        ]);
        return json({ schemaVersion: 1, formVersionId: versionId }, 201);
      }
      assert.ok(requestUrl(input).endsWith('/v1/publications/definition'));
      assert.deepEqual(request, { schemaVersion: 1, formVersionId: versionId });
      const fixture = reviewerFixture();
      fixture.form.questions[1]!.label = 'Edited school name';
      return json(
        {
          schemaVersion: 1,
          definition: {
            ...fixture.form,
            form: { ...fixture.form.form, key: 'fresh_org_identity' },
          },
          mappingBundle: fixture.mappings,
        },
        200,
      );
    },
  );
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(requests, 2);
  assert.equal(result.requestCount, 2);
  assert.equal(result.formVersionId, versionId);
  assert.equal(result.sourceSha256, result.importedSha256);
  assert.match(result.sourceSha256, /^[0-9a-f]{64}$/);
});

void test('refuses a fresh-org definition whose compiled XML differs', async () => {
  const fixture = reviewerFixture();
  const result = await verifySalesforceXlsFormRoundTrip(
    configuration,
    workbook(),
    async (input) => {
      if (requestUrl(input).endsWith('/v1/definitions/import'))
        return json({ schemaVersion: 1, formVersionId: versionId }, 201);
      const changed = structuredClone(fixture.form);
      changed.questions[0]!.label = 'Changed after persistence';
      return json(
        {
          schemaVersion: 1,
          definition: { ...changed, form: { ...changed.form, key: 'fresh' } },
          mappingBundle: fixture.mappings,
        },
        200,
      );
    },
  );
  assert.deepEqual(result, {
    ok: false,
    diagnostics: [
      { code: 'XLSFORM_SALESFORCE_MISMATCH', location: 'roundtrip' },
    ],
  });
});

void test('fails closed for hostile configuration, responses and deadlines', async () => {
  let calls = 0;
  const hostile = await verifySalesforceXlsFormRoundTrip(
    { ...configuration, instanceOrigin: 'https://example.invalid' },
    workbook(),
    async () => {
      calls++;
      return json({}, 200);
    },
  );
  assert.equal(hostile.ok, false);
  assert.equal(calls, 0);

  const extra = await verifySalesforceXlsFormRoundTrip(
    configuration,
    workbook(),
    async () =>
      json({ schemaVersion: 1, formVersionId: versionId, extra: true }, 201),
  );
  assert.equal(extra.ok, false);

  const timeout = await verifySalesforceXlsFormRoundTrip(
    { ...configuration, perRequestTimeoutMs: 10, overallTimeoutMs: 20 },
    workbook(),
    async () => await new Promise<Response>(() => undefined),
  );
  assert.deepEqual(timeout, {
    ok: false,
    diagnostics: [
      { code: 'XLSFORM_SALESFORCE_TIMEOUT', location: 'roundtrip' },
    ],
  });

  let lateCalls = 0;
  const lateToken = await verifySalesforceXlsFormRoundTrip(
    {
      ...configuration,
      getAccessToken: async () =>
        await new Promise<string>((resolve) =>
          setTimeout(() => resolve('synthetic-token'), 30),
        ),
      perRequestTimeoutMs: 10,
      overallTimeoutMs: 20,
    },
    workbook(),
    async () => {
      lateCalls++;
      return json({ schemaVersion: 1, formVersionId: versionId }, 201);
    },
  );
  assert.equal(lateToken.ok, false);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(lateCalls, 0);
});
