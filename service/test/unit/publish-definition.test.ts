import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  PublishCliError,
  publishDefinitionFromCli,
  readPublishCliInput,
} from '../../src/publish-definition.js';

const origin = 'https://service.example';
const accessToken = `${'a'.repeat(24)}.${'b'.repeat(24)}.${'c'.repeat(24)}`;
const formVersionId = 'a0V000000000001EAA';
const opaqueSession = 's'.repeat(43);
const csrfToken = 'c'.repeat(43);
const attemptId = '10000000-0000-4000-8000-000000000001';
const publicationDigest = 'd'.repeat(64);
const cookie = `__Host-kusanya_admin_session=${opaqueSession}`;

const input = Object.freeze({
  accessToken,
  formVersionId,
  serviceOrigin: origin,
});

function loginResponse(extra = ''): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'set-cookie': `__Host-kusanya_admin_session=${opaqueSession}; Path=/; Max-Age=900; Secure; HttpOnly; SameSite=Lax${extra}`,
    },
  });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sequence(
  publishResponse: () => Response,
  logoutResponse: () => Response = () => new Response(null, { status: 204 }),
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const responses = [
    loginResponse,
    () => jsonResponse({ csrfToken }),
    publishResponse,
    logoutResponse,
  ];
  const fetchImplementation = async (
    url: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> => {
    calls.push({
      url:
        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
      init,
    });
    const response = responses[calls.length - 1];
    assert.ok(response, 'unexpected extra request');
    return response();
  };
  return { calls, fetchImplementation };
}

async function runCli(
  source: string,
  arguments_: readonly string[] = [],
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  const executable = fileURLToPath(
    new URL('../../src/publish-definition.js', import.meta.url),
  );
  const child = spawn(process.execPath, [executable, ...arguments_], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.stdin.end(source);
  const [code] = (await once(child, 'close')) as [number | null];
  return {
    code,
    stderr: Buffer.concat(stderr).toString('utf8'),
    stdout: Buffer.concat(stdout).toString('utf8'),
  };
}

void test('publishes only through login, CSRF, durable route and confirmed logout', async () => {
  const { calls, fetchImplementation } = sequence(() =>
    jsonResponse({
      status: 'published',
      attemptId,
      publicationDigest,
      alreadyCommitted: false,
      salesforceRequestCount: 7,
    }),
  );
  const result = await publishDefinitionFromCli(input, fetchImplementation);
  assert.deepEqual(result, {
    publication: {
      status: 'published',
      attemptId,
      publicationDigest,
      alreadyCommitted: false,
      salesforceRequestCount: 7,
    },
    sessionCleanup: 'confirmed',
  });
  assert.deepEqual(
    calls.map((call) => [call.init.method, call.url]),
    [
      ['POST', `${origin}/api/admin/session/login`],
      ['POST', `${origin}/api/admin/session/csrf`],
      ['POST', `${origin}/api/admin/salesforce/publications`],
      ['POST', `${origin}/api/admin/session/logout`],
    ],
  );
  assert.equal(
    (calls[0]!.init.headers as Record<string, string>).authorization,
    `Bearer ${accessToken}`,
  );
  assert.equal(
    (calls[0]!.init.headers as Record<string, string>).cookie,
    undefined,
  );
  assert.equal(
    (calls[1]!.init.headers as Record<string, string>).cookie,
    cookie,
  );
  assert.equal(
    (calls[2]!.init.headers as Record<string, string>)['x-csrf-token'],
    csrfToken,
  );
  assert.equal(
    (calls[3]!.init.headers as Record<string, string>).cookie,
    cookie,
  );
  assert.equal(calls[2]!.init.body, JSON.stringify({ formVersionId }));
  for (const call of calls) {
    assert.equal(call.init.credentials, 'omit');
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.cache, 'no-store');
    assert.ok(call.init.signal instanceof AbortSignal);
    assert.equal((call.init.headers as Record<string, string>).origin, origin);
    assert.doesNotMatch(call.url, new RegExp(accessToken));
    assert.ok(
      call.init.body === undefined || typeof call.init.body === 'string',
    );
    assert.doesNotMatch(call.init.body ?? '', new RegExp(accessToken));
  }
  assert.doesNotMatch(JSON.stringify(result), new RegExp(accessToken));
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.publication));
});

void test('preserves bounded refusal diagnostics and makes non-success machine-visible', async () => {
  const { calls, fetchImplementation } = sequence(() =>
    jsonResponse(
      {
        status: 'rejected',
        attemptId,
        diagnostics: [
          { code: 'TARGET_FIELD_ACCESS', location: 'mappings[0].fields[1]' },
        ],
        salesforceRequestCount: 3,
      },
      422,
    ),
  );
  assert.deepEqual(await publishDefinitionFromCli(input, fetchImplementation), {
    publication: {
      status: 'rejected',
      attemptId,
      diagnostics: [
        { code: 'TARGET_FIELD_ACCESS', location: 'mappings[0].fields[1]' },
      ],
      salesforceRequestCount: 3,
    },
    sessionCleanup: 'confirmed',
  });
  assert.equal(calls.length, 4);
});

void test('marks partial, unresolved and unavailable outcomes without suggesting retry', async () => {
  for (const item of [
    {
      response: () =>
        jsonResponse(
          {
            status: 'partial',
            attemptId,
            error: 'Publication outcome requires reconciliation',
            salesforceRequestCount: 9,
          },
          409,
        ),
      expected: {
        status: 'partial',
        attemptId,
        operatorAction: 'reconcile',
        salesforceRequestCount: 9,
      },
    },
    {
      response: () =>
        jsonResponse(
          {
            status: 'unresolved',
            attemptId,
            error: 'Publication outcome requires reconciliation',
          },
          503,
        ),
      expected: {
        status: 'unresolved',
        attemptId,
        operatorAction: 'reconcile',
      },
    },
    {
      response: () => jsonResponse({ error: 'Publication unavailable' }, 503),
      expected: { status: 'unavailable' },
    },
  ] as const) {
    const { fetchImplementation } = sequence(item.response);
    assert.deepEqual(
      (await publishDefinitionFromCli(input, fetchImplementation)).publication,
      item.expected,
    );
  }
});

void test('turns an uncertain publication transport into inspect-only guidance and still logs out', async () => {
  const calls: string[] = [];
  const fetchImplementation = async (
    url: string | URL | Request,
  ): Promise<Response> => {
    calls.push(
      typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
    );
    if (calls.length === 1) return loginResponse();
    if (calls.length === 2) return jsonResponse({ csrfToken });
    if (calls.length === 3) throw new Error('private network detail');
    return new Response(null, { status: 204 });
  };
  assert.deepEqual(await publishDefinitionFromCli(input, fetchImplementation), {
    publication: {
      status: 'transport_unresolved',
      operatorAction: 'inspect_publication_history',
    },
    sessionCleanup: 'confirmed',
  });
  assert.equal(calls.at(-1), `${origin}/api/admin/session/logout`);
});

void test('bounds a transport that ignores abort before returning headers', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let observedSignal: AbortSignal | undefined;
  let called = false;
  const operation = publishDefinitionFromCli(input, (_url, init) => {
    called = true;
    observedSignal = init?.signal ?? undefined;
    return new Promise<Response>(() => undefined);
  });
  while (!called) await new Promise((resolve) => setImmediate(resolve));
  context.mock.timers.tick(10_000);
  await assert.rejects(operation, { message: 'PUBLISH_CLI_FAILED' });
  assert.equal(observedSignal?.aborted, true);
});

void test('keeps the publication deadline active while a response body stalls', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const calls: string[] = [];
  let publicationSignal: AbortSignal | undefined;
  const fetchImplementation = async (
    url: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> => {
    calls.push(
      typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
    );
    if (calls.length === 1) return loginResponse();
    if (calls.length === 2) return jsonResponse({ csrfToken });
    if (calls.length === 3) {
      publicationSignal = init.signal ?? undefined;
      return new Response(new ReadableStream({ start() {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(null, { status: 204 });
  };
  const operation = publishDefinitionFromCli(input, fetchImplementation);
  while (calls.length < 3)
    await new Promise((resolve) => setImmediate(resolve));
  context.mock.timers.tick(130_000);
  assert.deepEqual(await operation, {
    publication: {
      status: 'transport_unresolved',
      operatorAction: 'inspect_publication_history',
    },
    sessionCleanup: 'confirmed',
  });
  assert.equal(publicationSignal?.aborted, true);
  assert.equal(calls.at(-1), `${origin}/api/admin/session/logout`);
});

void test('reports cleanup separately without hiding a known publication outcome', async () => {
  const { fetchImplementation } = sequence(
    () =>
      jsonResponse({
        status: 'published',
        attemptId,
        publicationDigest,
        alreadyCommitted: true,
        salesforceRequestCount: 2,
      }),
    () => jsonResponse({ error: 'Logout unavailable' }, 503),
  );
  assert.deepEqual(await publishDefinitionFromCli(input, fetchImplementation), {
    publication: {
      status: 'published',
      attemptId,
      publicationDigest,
      alreadyCommitted: true,
      salesforceRequestCount: 2,
    },
    sessionCleanup: 'unconfirmed',
  });
});

void test('strictly refuses hostile input and session cookies before publication', async () => {
  let getterCalls = 0;
  const hostile = Object.defineProperty({}, 'accessToken', {
    enumerable: true,
    get() {
      getterCalls++;
      return accessToken;
    },
  });
  for (const value of [
    null,
    [],
    { ...input, tenantId: '10000000-0000-4000-8000-000000000099' },
    { ...input, serviceOrigin: 'http://service.example' },
    { ...input, serviceOrigin: `${origin}/admin` },
    { ...input, formVersionId: 'not-an-id' },
    { ...input, accessToken: 'private-token' },
    hostile,
    new Proxy(input, {}),
  ])
    await assert.rejects(publishDefinitionFromCli(value), {
      message: 'PUBLISH_CLI_FAILED',
    });
  assert.equal(getterCalls, 0);

  const { fetchImplementation } = sequence(() =>
    jsonResponse({ error: 'unused' }, 500),
  );
  const badCookie = async () => loginResponse('; Domain=service.example');
  await assert.rejects(publishDefinitionFromCli(input, badCookie), {
    message: 'PUBLISH_CLI_FAILED',
  });
  assert.equal(
    (await publishDefinitionFromCli(input, fetchImplementation)).publication
      .status,
    'transport_unresolved',
  );
});

void test('strictly decodes bounded stdin without reflecting credential material', async () => {
  async function* source(value: string) {
    yield Buffer.from(value.slice(0, 20));
    yield value.slice(20);
  }
  assert.deepEqual(
    await readPublishCliInput(source(JSON.stringify(input))),
    input,
  );
  for (const value of [
    '',
    '{',
    JSON.stringify({ ...input, extra: true }),
    JSON.stringify({ ...input, accessToken: 'private-token' }),
    `{"accessToken":"${accessToken}","accessToken":"${accessToken}","formVersionId":"${formVersionId}","serviceOrigin":"${origin}"}`,
    `{"accessToken":"${accessToken}","access\\u0054oken":"${accessToken}","formVersionId":"${formVersionId}","serviceOrigin":"${origin}"}`,
    JSON.stringify(input).padEnd(24_577, ' '),
  ])
    await assert.rejects(
      readPublishCliInput(source(value)),
      (error: unknown) =>
        error instanceof PublishCliError &&
        error.message === 'PUBLISH_CLI_FAILED' &&
        !error.stack?.includes(accessToken),
    );
});

void test('the executable reads stdin only and emits one fixed failure', async () => {
  const secret = 'private-cli-credential';
  for (const result of [
    await runCli(JSON.stringify({ ...input, accessToken: secret })),
    await runCli('', [secret]),
  ]) {
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Publication CLI failed\n');
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  }
});

void test('refuses malformed or secret-bearing service responses and still revokes after publication starts', async () => {
  for (const response of [
    () =>
      new Response(
        `{"status":"published","status":"rejected","attemptId":"${attemptId}","publicationDigest":"${publicationDigest}","alreadyCommitted":false,"salesforceRequestCount":1}`,
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    () =>
      jsonResponse({
        status: 'published',
        attemptId,
        publicationDigest,
        alreadyCommitted: false,
        salesforceRequestCount: 1,
        refreshToken: 'private-provider-value',
      }),
    () =>
      new Response('{', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    () =>
      new Response('private-provider-value', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    () =>
      new Response(JSON.stringify({ status: 'published' }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': '70000',
        },
      }),
  ]) {
    const { calls, fetchImplementation } = sequence(response);
    const result = await publishDefinitionFromCli(input, fetchImplementation);
    assert.deepEqual(result, {
      publication: {
        status: 'transport_unresolved',
        operatorAction: 'inspect_publication_history',
      },
      sessionCleanup: 'confirmed',
    });
    assert.equal(calls.length, 4);
    assert.doesNotMatch(JSON.stringify(result), /private-provider-value/);
  }
});
