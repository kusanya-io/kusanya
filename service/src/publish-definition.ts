/** Bounded CI/CLI client for the mounted tenant publication route. */
import { TextDecoder, types } from 'node:util';
import type { Diagnostic } from './compiler/types.js';
import { publicationRoutePaths } from './publication/publication-routes.js';
import { administratorSessionRoutePaths } from './tenant/administrator-routes.js';
import {
  administratorSessionCookieName,
  parseAdministratorSessionSetCookie,
} from './tenant/administrator-cookie.js';

const maximumInputBytes = 24_576;
const maximumResponseBytes = 65_536;
const overallTimeoutMs = 160_000;
const shortRequestTimeoutMs = 10_000;
const publicationRequestTimeoutMs = 130_000;
const maximumJsonDepth = 16;
const maximumJsonNodes = 5_000;
const accessTokenPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const idPattern = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digestPattern = /^[0-9a-f]{64}$/;
const csrfPattern = /^[A-Za-z0-9_-]{43}$/;
const diagnosticCodePattern = /^[A-Z][A-Z0-9_]{0,127}$/;
const diagnosticLocationPattern = /^[\x20-\x7e]{1,512}$/;

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type PublishCliPublication =
  | Readonly<{
      status: 'published';
      attemptId: string;
      publicationDigest: string;
      alreadyCommitted: boolean;
      salesforceRequestCount: number;
    }>
  | Readonly<{
      status: 'rejected';
      attemptId: string;
      diagnostics: readonly Diagnostic[];
      salesforceRequestCount: number;
    }>
  | Readonly<{
      status: 'partial' | 'unresolved';
      attemptId: string;
      operatorAction: 'reconcile';
      salesforceRequestCount?: number;
    }>
  | Readonly<{
      status: 'unavailable';
    }>
  | Readonly<{
      status: 'transport_unresolved';
      operatorAction: 'inspect_publication_history';
    }>;

export interface PublishCliResult {
  readonly publication: PublishCliPublication;
  readonly sessionCleanup: 'confirmed' | 'unconfirmed';
}

interface PublishCliInput {
  readonly accessToken: string;
  readonly formVersionId: string;
  readonly serviceOrigin: string;
}

export class PublishCliError extends Error {
  constructor() {
    super('PUBLISH_CLI_FAILED');
    this.name = 'PublishCliError';
  }
}

function fail(): never {
  throw new PublishCliError();
}

/** Strict JSON with decoded duplicate-key and structural resource checks. */
function parseJsonDocument(source: string): unknown {
  let position = 0;
  let nodes = 0;
  const whitespace = (): void => {
    while (' \t\r\n'.includes(source[position] ?? '\0')) position++;
  };
  const string = (): string => {
    const start = position;
    if (source[position++] !== '"') fail();
    while (position < source.length) {
      const code = source.charCodeAt(position++);
      if (code === 34) {
        try {
          return JSON.parse(source.slice(start, position)) as string;
        } catch {
          fail();
        }
      }
      if (code < 32) fail();
      if (code === 92) {
        const escape = source[position++];
        if (escape === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(source.slice(position, position + 4)))
            fail();
          position += 4;
        } else if (!escape || !'"\\/bfnrt'.includes(escape)) fail();
      }
    }
    return fail();
  };
  const value = (depth: number): unknown => {
    if (depth > maximumJsonDepth || ++nodes > maximumJsonNodes) fail();
    whitespace();
    const first = source[position];
    if (first === '"') return string();
    if (first === '{') {
      position++;
      const entries: [string, unknown][] = [];
      const keys = new Set<string>();
      whitespace();
      if (source[position] === '}') {
        position++;
        return {};
      }
      for (;;) {
        const key = string();
        if (keys.has(key)) fail();
        keys.add(key);
        whitespace();
        if (source[position++] !== ':') fail();
        entries.push([key, value(depth + 1)]);
        whitespace();
        const separator = source[position++];
        if (separator === '}') return Object.fromEntries(entries);
        if (separator !== ',') fail();
        whitespace();
      }
    }
    if (first === '[') {
      position++;
      const items: unknown[] = [];
      whitespace();
      if (source[position] === ']') {
        position++;
        return items;
      }
      for (;;) {
        items.push(value(depth + 1));
        whitespace();
        const separator = source[position++];
        if (separator === ']') return items;
        if (separator !== ',') fail();
        whitespace();
      }
    }
    for (const [literal, decoded] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const)
      if (source.startsWith(literal, position)) {
        position += literal.length;
        return decoded;
      }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      source.slice(position),
    )?.[0];
    if (number === undefined) fail();
    position += number.length;
    const decoded = Number(number);
    if (!Number.isFinite(decoded)) fail();
    return decoded;
  };
  const result = value(0);
  whitespace();
  if (position !== source.length) fail();
  return result;
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'),
    )
  )
    fail();
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  if (Object.keys(value).sort().join(',') !== [...expected].sort().join(','))
    fail();
}

function input(value: unknown): PublishCliInput {
  const decoded = plainRecord(value);
  exactKeys(decoded, ['accessToken', 'formVersionId', 'serviceOrigin']);
  if (
    typeof decoded.accessToken !== 'string' ||
    decoded.accessToken.length < 16 ||
    decoded.accessToken.length > 16_384 ||
    !accessTokenPattern.test(decoded.accessToken) ||
    typeof decoded.formVersionId !== 'string' ||
    !idPattern.test(decoded.formVersionId) ||
    typeof decoded.serviceOrigin !== 'string'
  )
    fail();
  let parsed: URL;
  try {
    parsed = new URL(decoded.serviceOrigin);
  } catch {
    fail();
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.origin !== decoded.serviceOrigin ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== ''
  )
    fail();
  return Object.freeze({
    accessToken: decoded.accessToken,
    formVersionId: decoded.formVersionId,
    serviceOrigin: decoded.serviceOrigin,
  });
}

/** Read one exact JSON document from standard input, never from argv. */
export async function readPublishCliInput(
  source: AsyncIterable<Buffer | string>,
): Promise<PublishCliInput> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of source) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    length += bytes.length;
    if (length > maximumInputBytes) fail();
    chunks.push(bytes);
  }
  try {
    return input(
      parseJsonDocument(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
      ),
    );
  } catch (error) {
    if (error instanceof PublishCliError) throw error;
    fail();
  }
}

function boundedCount(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > 10_000
  )
    fail();
  return value as number;
}

function attemptId(value: unknown): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) fail();
  return value;
}

function diagnostics(value: unknown): readonly Diagnostic[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 1_000) fail();
  return Object.freeze(
    value.map((item) => {
      const decoded = plainRecord(item);
      exactKeys(decoded, ['code', 'location']);
      if (
        typeof decoded.code !== 'string' ||
        !diagnosticCodePattern.test(decoded.code) ||
        typeof decoded.location !== 'string' ||
        !diagnosticLocationPattern.test(decoded.location)
      )
        fail();
      return Object.freeze({
        code: decoded.code,
        location: decoded.location,
      });
    }),
  );
}

async function responseBytes(
  response: Response,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > maximumResponseBytes
    )
      fail();
  }
  if (
    response.headers
      .get('content-type')
      ?.split(';', 1)[0]
      ?.trim()
      .toLowerCase() !== 'application/json' ||
    response.body === null
  )
    fail();
  const reader = response.body.getReader();
  const cancel = (): void => void reader.cancel().catch(() => undefined);
  if (signal.aborted) cancel();
  else signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximumResponseBytes) {
        await reader.cancel().catch(() => undefined);
        fail();
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    if (error instanceof PublishCliError) throw error;
    fail();
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function json(response: Response, signal: AbortSignal): Promise<unknown> {
  try {
    return parseJsonDocument(
      new TextDecoder('utf-8', { fatal: true }).decode(
        await responseBytes(response, signal),
      ),
    );
  } catch (error) {
    if (error instanceof PublishCliError) throw error;
    fail();
  }
}

async function boundedFetch(
  implementation: FetchImplementation,
  url: string,
  init: RequestInit,
  deadline: number,
  maximum: number,
): Promise<{
  response: Response;
  signal: AbortSignal;
  close: () => void;
}> {
  const remaining = Math.ceil(deadline - performance.now());
  if (remaining < 1) fail();
  const controller = new AbortController();
  const budget = Math.min(remaining, maximum);
  let timer: NodeJS.Timeout | undefined;
  const operation = Promise.resolve().then(() =>
    implementation(url, {
      ...init,
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    }),
  );
  void operation
    .then((response) => {
      if (controller.signal.aborted)
        void response.body?.cancel().catch(() => undefined);
    })
    .catch(() => undefined);
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new PublishCliError());
    }, budget);
    timer.unref();
  });
  try {
    return {
      response: await Promise.race([operation, timeout]),
      signal: controller.signal,
      close() {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
      },
    };
  } catch {
    if (timer !== undefined) clearTimeout(timer);
    throw new PublishCliError();
  }
}

function sessionCookie(response: Response): string {
  const cookie = response.headers.get('set-cookie');
  let opaqueSession: string;
  try {
    opaqueSession = parseAdministratorSessionSetCookie(cookie).opaqueSession;
  } catch {
    fail();
  }
  return `${administratorSessionCookieName}=${opaqueSession}`;
}

async function csrf(response: Response, signal: AbortSignal): Promise<string> {
  if (response.status !== 200 || response.redirected) fail();
  const decoded = plainRecord(await json(response, signal));
  exactKeys(decoded, ['csrfToken']);
  if (
    typeof decoded.csrfToken !== 'string' ||
    !csrfPattern.test(decoded.csrfToken)
  )
    fail();
  return decoded.csrfToken;
}

async function publication(
  response: Response,
  signal: AbortSignal,
): Promise<PublishCliPublication> {
  if (response.redirected) fail();
  const decoded = plainRecord(await json(response, signal));
  if (response.status === 200) {
    exactKeys(decoded, [
      'alreadyCommitted',
      'attemptId',
      'publicationDigest',
      'salesforceRequestCount',
      'status',
    ]);
    if (
      decoded.status !== 'published' ||
      typeof decoded.publicationDigest !== 'string' ||
      !digestPattern.test(decoded.publicationDigest) ||
      typeof decoded.alreadyCommitted !== 'boolean'
    )
      fail();
    return Object.freeze({
      status: 'published',
      attemptId: attemptId(decoded.attemptId),
      publicationDigest: decoded.publicationDigest,
      alreadyCommitted: decoded.alreadyCommitted,
      salesforceRequestCount: boundedCount(decoded.salesforceRequestCount),
    });
  }
  if (response.status === 422) {
    exactKeys(decoded, [
      'attemptId',
      'diagnostics',
      'salesforceRequestCount',
      'status',
    ]);
    if (decoded.status !== 'rejected') fail();
    return Object.freeze({
      status: 'rejected',
      attemptId: attemptId(decoded.attemptId),
      diagnostics: diagnostics(decoded.diagnostics),
      salesforceRequestCount: boundedCount(decoded.salesforceRequestCount),
    });
  }
  if (response.status === 409) {
    const keys = Object.keys(decoded).sort().join(',');
    if (
      keys !==
        ['attemptId', 'error', 'salesforceRequestCount', 'status']
          .sort()
          .join(',') ||
      (decoded.status !== 'partial' && decoded.status !== 'unresolved') ||
      decoded.error !== 'Publication outcome requires reconciliation'
    )
      fail();
    return Object.freeze({
      status: decoded.status,
      attemptId: attemptId(decoded.attemptId),
      operatorAction: 'reconcile',
      salesforceRequestCount: boundedCount(decoded.salesforceRequestCount),
    });
  }
  if (response.status === 503) {
    const keys = Object.keys(decoded).sort().join(',');
    if (
      keys === ['attemptId', 'error', 'status'].sort().join(',') &&
      decoded.status === 'unresolved' &&
      decoded.error === 'Publication outcome requires reconciliation'
    )
      return Object.freeze({
        status: 'unresolved',
        attemptId: attemptId(decoded.attemptId),
        operatorAction: 'reconcile',
      });
    if (
      keys === 'error' &&
      (decoded.error === 'Publication unavailable' ||
        decoded.error === 'Authentication required')
    )
      return Object.freeze({ status: 'unavailable' });
    fail();
  }
  if ([400, 401, 403].includes(response.status)) {
    exactKeys(decoded, ['error']);
    if (typeof decoded.error !== 'string') fail();
    return Object.freeze({ status: 'unavailable' });
  }
  fail();
}

async function logout(
  implementation: FetchImplementation,
  input: PublishCliInput,
  cookie: string,
  csrfToken: string,
  deadline: number,
): Promise<'confirmed' | 'unconfirmed'> {
  try {
    const bounded = await boundedFetch(
      implementation,
      `${input.serviceOrigin}${administratorSessionRoutePaths.logout}`,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          cookie,
          origin: input.serviceOrigin,
          'x-csrf-token': csrfToken,
        },
      },
      deadline,
      shortRequestTimeoutMs,
    );
    try {
      return bounded.response.status === 204 && !bounded.response.redirected
        ? 'confirmed'
        : 'unconfirmed';
    } finally {
      await bounded.response.body?.cancel().catch(() => undefined);
      bounded.close();
    }
  } catch {
    return 'unconfirmed';
  }
}

/** Publish only through the reviewed HTTP composition and revoke its session. */
export async function publishDefinitionFromCli(
  inputValue: unknown,
  implementation: FetchImplementation = fetch,
): Promise<PublishCliResult> {
  const decoded = input(inputValue);
  if (typeof implementation !== 'function') fail();
  const deadline = performance.now() + overallTimeoutMs;
  const login = await boundedFetch(
    implementation,
    `${decoded.serviceOrigin}${administratorSessionRoutePaths.login}`,
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${decoded.accessToken}`,
        origin: decoded.serviceOrigin,
      },
    },
    deadline,
    shortRequestTimeoutMs,
  );
  let cookie: string;
  try {
    if (login.response.status !== 204 || login.response.redirected) fail();
    cookie = sessionCookie(login.response);
  } finally {
    await login.response.body?.cancel().catch(() => undefined);
    login.close();
  }
  const csrfResponse = await boundedFetch(
    implementation,
    `${decoded.serviceOrigin}${administratorSessionRoutePaths.csrf}`,
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        cookie,
        origin: decoded.serviceOrigin,
      },
    },
    deadline,
    shortRequestTimeoutMs,
  );
  let csrfToken: string;
  try {
    csrfToken = await csrf(csrfResponse.response, csrfResponse.signal);
  } finally {
    await csrfResponse.response.body?.cancel().catch(() => undefined);
    csrfResponse.close();
  }

  let outcome: PublishCliPublication;
  try {
    const published = await boundedFetch(
      implementation,
      `${decoded.serviceOrigin}${publicationRoutePaths.publish}`,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          cookie,
          origin: decoded.serviceOrigin,
          'x-csrf-token': csrfToken,
        },
        body: JSON.stringify({ formVersionId: decoded.formVersionId }),
      },
      deadline,
      publicationRequestTimeoutMs,
    );
    try {
      outcome = await publication(published.response, published.signal);
    } finally {
      await published.response.body?.cancel().catch(() => undefined);
      published.close();
    }
  } catch {
    outcome = Object.freeze({
      status: 'transport_unresolved',
      operatorAction: 'inspect_publication_history',
    });
  }
  return Object.freeze({
    publication: outcome,
    sessionCleanup: await logout(
      implementation,
      decoded,
      cookie,
      csrfToken,
      deadline,
    ),
  });
}

async function main(): Promise<void> {
  // A pending Promise alone does not keep Node alive. Default to a distinct
  // pre-result failure so even a transport with no live handle cannot exit green.
  process.exitCode = 2;
  if (process.argv.length !== 2) fail();
  const result = await publishDefinitionFromCli(
    await readPublishCliInput(process.stdin),
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode =
    result.publication.status !== 'published' ||
    result.sessionCleanup !== 'confirmed'
      ? 1
      : 0;
}

if (process.argv[1]?.endsWith('publish-definition.js'))
  void main().catch(() => {
    process.stderr.write('Publication CLI failed\n');
    process.exitCode = 2;
  });
