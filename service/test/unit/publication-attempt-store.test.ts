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
  role: 'administrator' as const,
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

void test('loads only exact reconcilable evidence and records one-way resolution', async () => {
  const queries: { text: string; values: unknown[] }[] = [];
  const rows = [
    {
      outcome: 'partial',
      form_version_id: 'a0B000000000001AAA',
      publication_digest: 'd'.repeat(64),
      xform_version_id: '068000000000001AAA',
      xlsform_version_id: '068000000000002AAA',
      reconciliation_status: null,
      reconciliation_request_count: null,
    },
  ];
  const store = new PublicationAttemptStore({
    async query<Row>(text: string, values: unknown[] = []) {
      queries.push({ text, values });
      if (/^\s*SELECT/.test(text)) return { rowCount: 1, rows: rows as Row[] };
      return { rowCount: 1, rows: [] as Row[] };
    },
  });
  const id = '10000000-0000-4000-8000-000000000009';
  assert.deepEqual(await store.loadReconcilable(context, id), {
    outcome: 'partial',
    formVersionId: 'a0B000000000001AAA',
    publicationDigest: 'd'.repeat(64),
    xformVersionId: '068000000000001AAA',
    xlsformVersionId: '068000000000002AAA',
  });
  assert.deepEqual(await store.resolve(context, id, 'partial', 'unlinked', 2), {
    status: 'unlinked',
    requestCount: 2,
  });
  assert.match(queries[0]!.text, /tenant\.authorization_origin = \$5/);
  assert.match(queries[1]!.text, /reconciliation_status IS NULL/);
  assert.deepEqual(queries[1]!.values.slice(0, 5), [
    id,
    tenantId,
    'partial',
    'unlinked',
    2,
  ]);
});

void test('returns the immutable winner after a reconciliation race', async () => {
  const store = new PublicationAttemptStore({
    async query<Row>(text: string) {
      if (/^\s*UPDATE/.test(text)) return { rowCount: 0, rows: [] as Row[] };
      return {
        rowCount: 1,
        rows: [
          {
            outcome: 'partial',
            form_version_id: 'a0B000000000001AAA',
            publication_digest: 'd'.repeat(64),
            xform_version_id: '068000000000001AAA',
            xlsform_version_id: '068000000000002AAA',
            reconciliation_status: 'committed',
            reconciliation_request_count: 1,
          } as Row,
        ],
      };
    },
  });
  assert.deepEqual(
    await store.resolve(
      context,
      '10000000-0000-4000-8000-000000000009',
      'partial',
      'unlinked',
      2,
    ),
    { status: 'committed', requestCount: 1 },
  );
});

void test('refuses terminal attempts and invalid outcome/status combinations', async () => {
  const store = new PublicationAttemptStore({
    async query<Row>() {
      return {
        rowCount: 1,
        rows: [
          {
            outcome: 'succeeded',
            form_version_id: 'a0B000000000001AAA',
            publication_digest: 'd'.repeat(64),
            xform_version_id: null,
            xlsform_version_id: null,
            reconciliation_status: null,
            reconciliation_request_count: null,
          } as Row,
        ],
      };
    },
  });
  await assert.rejects(
    store.loadReconcilable(context, '10000000-0000-4000-8000-000000000009'),
    PublicationAttemptError,
  );
  await assert.rejects(
    store.resolve(
      context,
      '10000000-0000-4000-8000-000000000009',
      'started',
      'committed',
      1,
    ),
    PublicationAttemptError,
  );
});

void test('refuses persisted reconciliation states that contradict their outcome', async () => {
  for (const row of [
    {
      outcome: 'started',
      reconciliation_status: 'committed',
      reconciliation_request_count: 1,
    },
    {
      outcome: 'partial',
      reconciliation_status: 'indeterminate',
      reconciliation_request_count: 0,
    },
    {
      outcome: 'partial',
      reconciliation_status: 'artifacts_missing',
      reconciliation_request_count: 0,
    },
  ]) {
    const store = new PublicationAttemptStore({
      async query<Row>() {
        return {
          rowCount: 1,
          rows: [
            {
              form_version_id: 'a0B000000000001AAA',
              publication_digest: null,
              xform_version_id: null,
              xlsform_version_id: null,
              ...row,
            } as Row,
          ],
        };
      },
    });
    await assert.rejects(
      store.loadReconcilable(context, '10000000-0000-4000-8000-000000000009'),
      PublicationAttemptError,
    );
  }
});

void test('lists a bounded least-data operator view with human-judgement states', async () => {
  const started = new Date('2026-10-22T10:00:00.000Z');
  const completed = new Date('2026-10-22T10:01:00.000Z');
  const reconciled = new Date('2026-10-22T10:02:00.000Z');
  const states = [
    ['started', null, null, null, 'human_judgement_required_unresolved'],
    [
      'started',
      'indeterminate',
      null,
      reconciled,
      'human_judgement_required_indeterminate',
    ],
    ['partial', null, completed, null, 'human_judgement_required_unresolved'],
    ['succeeded', null, completed, null, 'published'],
    ['failed', null, completed, null, 'rejected'],
    ['partial', 'committed', completed, reconciled, 'published_confirmed'],
    [
      'partial',
      'unlinked',
      completed,
      reconciled,
      'unlinked_artifacts_confirmed',
    ],
    [
      'partial',
      'artifacts_missing',
      completed,
      reconciled,
      'artifacts_missing_confirmed',
    ],
  ] as const;
  let queryText = '';
  let queryValues: unknown[] = [];
  const store = new PublicationAttemptStore({
    async query<Row>(text: string, values: unknown[] = []) {
      queryText = text;
      queryValues = values;
      return {
        rowCount: states.length,
        rows: states.map(
          ([outcome, reconciliation, completedAt, reconciledAt], index) =>
            ({
              publication_attempt_id: `10000000-0000-4000-8000-${String(states.length - index).padStart(12, '0')}`,
              form_version_id: 'a0B000000000001AAA',
              outcome,
              reconciliation_status: reconciliation,
              created_at: started,
              created_cursor_at: '2026-10-22T10:00:00.000000Z',
              completed_at: completedAt,
              reconciled_at: reconciledAt,
            }) as Row,
        ),
      };
    },
  });
  const result = await store.listForOperator(context);
  assert.deepEqual(
    result.attempts.map((attempt) => attempt.operatorStatus),
    states.map((state) => state[4]),
  );
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.attempts), true);
  assert.equal(result.nextCursor, null);
  assert.equal(
    result.attempts.every((attempt) => Object.isFrozen(attempt)),
    true,
  );
  assert.deepEqual(queryValues, [
    context.actorId,
    context.tenantId,
    context.expectedSalesforceOrgId,
    context.authorizationOrigin,
    context.namespacePrefix,
    null,
    null,
  ]);
  assert.match(queryText, /LIMIT 100/);
  assert.match(queryText, /binding\.actor_id = \$1/);
  assert.match(queryText, /tenant\.namespace_prefix = \$5/);
  const projection = queryText.slice(0, queryText.indexOf('FROM'));
  for (const excluded of [
    'actor_id',
    'publication_digest',
    'xform_version_id',
    'xlsform_version_id',
    'failure_code',
    'salesforce_request_count',
    'reconciliation_request_count',
  ])
    assert.doesNotMatch(projection, new RegExp(excluded));
});

void test('operator view fails closed on contradictory rows and timestamps', async () => {
  const variants = [
    {
      outcome: 'started',
      reconciliation_status: 'committed',
      completed_at: null,
      reconciled_at: new Date('2026-10-22T10:02:00.000Z'),
    },
    {
      outcome: 'partial',
      reconciliation_status: null,
      completed_at: null,
      reconciled_at: null,
    },
    {
      outcome: 'succeeded',
      reconciliation_status: null,
      completed_at: new Date('2026-10-22T09:59:00.000Z'),
      reconciled_at: null,
    },
  ];
  for (const variant of variants) {
    const store = new PublicationAttemptStore({
      async query<Row>() {
        return {
          rowCount: 1,
          rows: [
            {
              publication_attempt_id: '10000000-0000-4000-8000-000000000009',
              form_version_id: 'a0B000000000001AAA',
              created_at: new Date('2026-10-22T10:00:00.000Z'),
              created_cursor_at: '2026-10-22T10:00:00.000000Z',
              ...variant,
            } as Row,
          ],
        };
      },
    });
    await assert.rejects(
      store.listForOperator(context),
      PublicationAttemptError,
    );
  }
});

void test('operator view refuses executable timestamp properties without invoking them', async () => {
  let calls = 0;
  const hostileDate = new Date('2026-10-22T10:00:00.000Z');
  Object.defineProperty(hostileDate, 'getTime', {
    get() {
      calls++;
      throw new Error('must not run');
    },
  });
  const store = new PublicationAttemptStore({
    async query<Row>() {
      return {
        rowCount: 1,
        rows: [
          {
            publication_attempt_id: '10000000-0000-4000-8000-000000000009',
            form_version_id: 'a0B000000000001AAA',
            outcome: 'started',
            reconciliation_status: null,
            created_at: hostileDate,
            created_cursor_at: '2026-10-22T10:00:00.000000Z',
            completed_at: null,
            reconciled_at: null,
          } as Row,
        ],
      };
    },
  });
  await assert.rejects(store.listForOperator(context), PublicationAttemptError);
  assert.equal(calls, 0);
});

void test('operator pagination is opaque, keyset-bounded and cannot widen tenant scope', async () => {
  const createdAt = new Date('2026-10-22T10:00:00.123Z');
  const createdCursorAt = '2026-10-22T10:00:00.123456Z';
  const rows = Array.from({ length: 100 }, (_, index) => ({
    publication_attempt_id: `10000000-0000-4000-8000-${String(100 - index).padStart(12, '0')}`,
    form_version_id: 'a0B000000000001AAA',
    outcome: 'failed',
    reconciliation_status: null,
    created_at: createdAt,
    completed_at: createdAt,
    reconciled_at: null,
    created_cursor_at: createdCursorAt,
  }));
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const store = new PublicationAttemptStore({
    async query<Row>(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      return {
        rowCount: calls.length === 1 ? rows.length : 0,
        rows: (calls.length === 1 ? rows : []) as Row[],
      };
    },
  });
  const first = await store.listForOperator(context);
  assert.equal(first.attempts.length, 100);
  assert.match(first.nextCursor ?? '', /^[A-Za-z0-9_-]{86}$/);
  assert.match(calls[0]!.text, /LIMIT 100/);
  assert.match(calls[0]!.text, /attempt\.tenant_id = \$2/);
  assert.match(calls[0]!.text, /binding\.actor_id = \$1/);
  assert.match(calls[0]!.text, /\$6::timestamptz/);

  const second = await store.listForOperator(context, first.nextCursor!);
  assert.deepEqual(second, { attempts: [], nextCursor: null });
  assert.deepEqual(calls[1]!.values, [
    context.actorId,
    context.tenantId,
    context.expectedSalesforceOrgId,
    context.authorizationOrigin,
    context.namespacePrefix,
    createdCursorAt,
    '10000000-0000-4000-8000-000000000001',
  ]);

  const before = calls.length;
  for (const invalid of [
    '',
    'x'.repeat(86),
    Buffer.from(
      `${createdCursorAt}\0${'20000000-0000-2000-8000-000000000001'}`,
    ).toString('base64url'),
    `${first.nextCursor}=`,
  ])
    await assert.rejects(
      store.listForOperator(context, invalid),
      PublicationAttemptError,
    );
  assert.equal(calls.length, before);
});

void test('retention is transactional, tenant-bound and exposes no caller cutoff', async () => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  let released = false;
  const store = new PublicationAttemptStore({
    async query<Row>() {
      return { rowCount: 0, rows: [] as Row[] };
    },
    async connect() {
      return {
        async query<Row>(text: string, values: unknown[] = []) {
          calls.push({ text, values });
          if (text === 'BEGIN' || text === 'COMMIT')
            return { rowCount: null, rows: [] as Row[] };
          if (text.includes('set_config'))
            return {
              rowCount: 1,
              rows: [{ set_config: context.actorId }] as Row[],
            };
          return {
            rowCount: 1,
            rows: [{ deleted_count: 100 }] as Row[],
          };
        },
        release() {
          released = true;
        },
      };
    },
  });
  assert.deepEqual(await store.applyRetention(context), { deletedCount: 100 });
  assert.equal(released, true);
  assert.deepEqual(
    calls.map((call) =>
      call.text === 'BEGIN' || call.text === 'COMMIT' ? call.text : 'SQL',
    ),
    ['BEGIN', 'SQL', 'SQL', 'COMMIT'],
  );
  assert.deepEqual(calls[1]!.values, [context.actorId]);
  assert.deepEqual(calls[2]!.values, [
    context.actorId,
    context.tenantId,
    context.expectedSalesforceOrgId,
    context.authorizationOrigin,
    context.namespacePrefix,
  ]);
  assert.match(calls[2]!.text, /LIMIT 100/);
  assert.match(calls[2]!.text, /binding\.role = 'administrator'/);
  assert.match(calls[2]!.text, /publication_attempt_retention_days/);
  assert.match(calls[2]!.text, /'committed', 'artifacts_missing'/);
  assert.doesNotMatch(calls[2]!.text, /'unlinked'/);
});

void test('retention refuses non-administrators and rolls back malformed storage results', async () => {
  let connected = 0;
  const publisher = { ...context, role: 'publisher' as const };
  const denied = new PublicationAttemptStore({
    async query<Row>() {
      return { rowCount: 0, rows: [] as Row[] };
    },
    async connect() {
      connected++;
      throw new Error('must not connect');
    },
  });
  await assert.rejects(
    denied.applyRetention(publisher),
    PublicationAttemptError,
  );
  assert.equal(connected, 0);

  const calls: string[] = [];
  const malformed = new PublicationAttemptStore({
    async query<Row>() {
      return { rowCount: 0, rows: [] as Row[] };
    },
    async connect() {
      return {
        async query<Row>(text: string) {
          calls.push(text);
          if (text.includes('set_config'))
            return { rowCount: 1, rows: [{}] as Row[] };
          if (text.includes('WITH candidates'))
            return { rowCount: 1, rows: [{ deleted_count: 101 }] as Row[] };
          return { rowCount: null, rows: [] as Row[] };
        },
        release() {},
      };
    },
  });
  await assert.rejects(
    malformed.applyRetention(context),
    PublicationAttemptError,
  );
  assert.equal(calls.at(-1), 'ROLLBACK');
});
