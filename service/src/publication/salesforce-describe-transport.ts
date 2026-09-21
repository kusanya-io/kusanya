/** Bounded Salesforce REST Describe transport. No token storage or refresh flow. */
import { types } from 'node:util';
import type { DescribeObject } from './salesforce-describe.js';

export const salesforceDescribeApiVersion = '64.0';

const apiName = /^[A-Za-z][A-Za-z0-9]*(?:_{1,2}[A-Za-z0-9]+)*$/;
const maxResponseBytes = 8 * 1024 * 1024;
const maxPerRequestTimeoutMs = 30_000;
const maxOverallTimeoutMs = 120_000;
const tokenPattern = /^[\x21-\x7e]+$/;

export interface SalesforceDescribeTransportConfiguration {
  readonly instanceOrigin: string;
  readonly getAccessToken: () => Promise<unknown>;
  readonly perRequestTimeoutMs: number;
  readonly overallTimeoutMs: number;
}

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

class SalesforceDescribeTransportFailure extends Error {
  constructor() {
    super('SALESFORCE_DESCRIBE_TRANSPORT');
    this.name = 'SalesforceDescribeTransportFailure';
  }
}

function fail(): never {
  throw new SalesforceDescribeTransportFailure();
}

function configurationRecord(
  value: unknown,
): Record<string, PropertyDescriptor> {
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
  return descriptors;
}

function configurationValue(
  descriptors: Record<string, PropertyDescriptor>,
  key: string,
): unknown {
  const descriptor = descriptors[key];
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail();
  return descriptor.value as unknown;
}

function instanceOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) fail();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail();
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.origin !== value ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    !parsed.hostname.endsWith('.salesforce.com')
  )
    fail();
  return parsed.origin;
}

function timeout(value: unknown, maximum: number): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > maximum
  )
    fail();
  return value as number;
}

function accessToken(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 4096 ||
    !tokenPattern.test(value)
  )
    fail();
  return value;
}

async function cancelBody(response: Response | undefined): Promise<void> {
  try {
    await response?.body?.cancel();
  } catch {
    // Cancellation is best effort after the transport has already refused.
  }
}

async function decodeJsonBody(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (
    response.headers
      .get('content-type')
      ?.split(';', 1)[0]
      ?.trim()
      .toLowerCase() !== 'application/json'
  )
    fail();
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength < 0 ||
      parsedLength > maxResponseBytes
    )
      fail();
  }
  if (response.body === null) fail();
  const reader = response.body.getReader();
  const abortRead = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  if (signal.aborted) abortRead();
  else signal.addEventListener('abort', abortRead, { once: true });
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > maxResponseBytes) {
        try {
          await reader.cancel();
        } catch {
          // The bounded refusal below is authoritative.
        }
        fail();
      }
      chunks.push(chunk.value);
    }
  } catch {
    fail();
  } finally {
    signal.removeEventListener('abort', abortRead);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let json: string;
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(json) as unknown;
  } catch {
    fail();
  }
}

/**
 * Create one transport for one publication attempt. Its overall deadline starts
 * with the first Describe and is shared by all later calls through this closure.
 */
export function createSalesforceDescribeTransport(
  configuration: SalesforceDescribeTransportConfiguration,
  fetchImplementation: FetchImplementation = fetch,
): DescribeObject {
  const descriptors = configurationRecord(configuration);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' ||
        ![
          'instanceOrigin',
          'getAccessToken',
          'perRequestTimeoutMs',
          'overallTimeoutMs',
        ].includes(key),
    )
  )
    fail();
  const origin = instanceOrigin(
    configurationValue(descriptors, 'instanceOrigin'),
  );
  const tokenProvider = configurationValue(descriptors, 'getAccessToken');
  const perRequestTimeoutMs = timeout(
    configurationValue(descriptors, 'perRequestTimeoutMs'),
    maxPerRequestTimeoutMs,
  );
  const overallTimeoutMs = timeout(
    configurationValue(descriptors, 'overallTimeoutMs'),
    maxOverallTimeoutMs,
  );
  if (
    typeof tokenProvider !== 'function' ||
    overallTimeoutMs < perRequestTimeoutMs
  )
    fail();

  let deadline: number | undefined;
  return async (objectName) => {
    if (
      typeof objectName !== 'string' ||
      objectName.length > 255 ||
      !apiName.test(objectName)
    )
      fail();
    const now = performance.now();
    deadline ??= now + overallTimeoutMs;
    const remaining = deadline - now;
    if (remaining <= 0) fail();
    const requestBudget = Math.min(perRequestTimeoutMs, Math.ceil(remaining));
    const controller = new AbortController();
    let response: Response | undefined;
    let timer: NodeJS.Timeout | undefined;
    const boundedRequest = async (): Promise<unknown> => {
      const token = accessToken(
        await (tokenProvider as () => Promise<unknown>)(),
      );
      response = await fetchImplementation(
        `${origin}/services/data/v${salesforceDescribeApiVersion}/sobjects/${encodeURIComponent(objectName)}/describe`,
        {
          method: 'GET',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${token}`,
          },
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'manual',
          signal: controller.signal,
        },
      );
      if (!response.ok || response.redirected || response.status !== 200)
        fail();
      return await decodeJsonBody(response, controller.signal);
    };
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new SalesforceDescribeTransportFailure());
      }, requestBudget);
      timer.unref();
    });
    try {
      return await Promise.race([boundedRequest(), timeoutPromise]);
    } catch {
      await cancelBody(response);
      fail();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}
