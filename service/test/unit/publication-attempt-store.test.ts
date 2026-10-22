import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PublicationAttemptError,
  PublicationAttemptStore,
} from '../../src/publication/publication-attempt-store.js';

const tenantId = '10000000-0000-4000-8000-000000000001';
const context = Object.freeze({
  actorId: 'oidc:synthetic',
  tenantId,
  expectedSalesforceOrgId: '00D000000000001EAA',
  authorizationOrigin: 'https://login.salesforce.com',
  namespacePrefix: 'ksny__',
  csrfToken: 'c'.repeat(43),
});

void test('starts from the complete trusted tuple and completes only the same tenant once', async () => {
  const queries: { text: string; values: unknown[] }[] = [];
  const store = new PublicationAttemptStore({
    async query<Row>(text: string, values: unknown[] = []) {
      queries.push({ text, values });
      return { rowCount: 1, rows: [] as Row[] };
    },
  });
  const id = await store.start(context, 'a0B000000000001AAA');
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(queries[0]!.values.slice(1), [
    context.actorId,
    tenantId,
    'a0B000000000001AAA',
    context.expectedSalesforceOrgId,
    context.authorizationOrigin,
    context.namespacePrefix,
  ]);
  assert.match(queries[0]!.text, /binding\.tenant_id = \$3/);
  await store.complete(id, tenantId, {
    outcome: 'partial',
    publicationDigest: 'd'.repeat(64),
    xformVersionId: '068000000000001AAA',
    xlsformVersionId: '068000000000002AAA',
    failureCode: 'PUBLICATION_PUBLISHER_PARTIAL',
    salesforceRequestCount: 8,
  });
  assert.match(queries[1]!.text, /outcome = 'started'/);
  assert.deepEqual(queries[1]!.values.slice(1), [
    tenantId,
    'partial',
    'd'.repeat(64),
    '068000000000001AAA',
    '068000000000002AAA',
    'PUBLICATION_PUBLISHER_PARTIAL',
    8,
  ]);
});

void test('refuses absent provisioning, cross-tenant completion and hostile shapes with one fixed code', async () => {
  const store = new PublicationAttemptStore({
    async query<Row>() {
      return { rowCount: 0, rows: [] as Row[] };
    },
  });
  await assert.rejects(
    store.start(context, 'a0B000000000001AAA'),
    (error: unknown) =>
      error instanceof PublicationAttemptError &&
      error.message === 'PUBLICATION_ATTEMPT_STORAGE',
  );
  await assert.rejects(
    store.complete('10000000-0000-4000-8000-000000000009', tenantId, {
      outcome: 'failed',
      failureCode: 'PUBLICATION_REJECTED',
      salesforceRequestCount: 0,
    }),
    PublicationAttemptError,
  );
  await assert.rejects(
    store.complete('10000000-0000-4000-8000-000000000009', tenantId, {
      outcome: 'partial',
      failureCode: 'PUBLICATION_PUBLISHER_PARTIAL',
      publicationDigest: 'not-a-digest',
      xformVersionId: '068000000000001AAA',
      xlsformVersionId: '068000000000002AAA',
      salesforceRequestCount: 8,
    }),
    PublicationAttemptError,
  );
});
