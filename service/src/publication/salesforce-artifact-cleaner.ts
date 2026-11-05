/** Bounded call to the atomic Apex boundary that deletes exact unlinked Files. */
import { types } from 'node:util';
import { createSalesforceNames } from '../salesforce-names.js';
import type { TenantSalesforceSession } from '../tenant/salesforce-session.js';

const maxResponseBytes = 4096;
const tokenPattern = /^[\x21-\x7e]+$/;
const idPattern = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const versionIdPattern = /^068[A-Za-z0-9]{15}$/;
const digestPattern = /^[0-9a-f]{64}$/;

export interface SalesforceArtifactCleanupRequest {
  readonly formVersionId: string;
  readonly publicationDigest: string;
  readonly xformVersionId: string;
  readonly xlsformVersionId: string;
}

export type SalesforceArtifactCleanupResult = Readonly<{
  ok: boolean;
  code?: 'PUBLICATION_ARTIFACT_CLEANUP';
  requestCount: number;
}>;

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

class CleanupFailure extends Error {}

function record(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new CleanupFailure();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'),
    )
  )
    throw new CleanupFailure();
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
}

function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).sort().join(',') !== keys.sort().join(','))
    throw new CleanupFailure();
}

function decodeRequest(value: SalesforceArtifactCleanupRequest) {
  const input = record(value);
  exactKeys(input, [
    'formVersionId',
    'publicationDigest',
    'xformVersionId',
    'xlsformVersionId',
  ]);
  if (
    typeof input.formVersionId !== 'string' ||
    !idPattern.test(input.formVersionId) ||
    typeof input.publicationDigest !== 'string' ||
    !digestPattern.test(input.publicationDigest) ||
    typeof input.xformVersionId !== 'string' ||
    !versionIdPattern.test(input.xformVersionId) ||
    typeof input.xlsformVersionId !== 'string' ||
    !versionIdPattern.test(input.xlsformVersionId) ||
    input.xformVersionId === input.xlsformVersionId
  )
    throw new CleanupFailure();
  return input as unknown as SalesforceArtifactCleanupRequest;
}

async function responseBytes(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > maxResponseBytes
    )
      throw new CleanupFailure();
  }
  if (response.body === null) throw new CleanupFailure();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maxResponseBytes) throw new CleanupFailure();
      chunks.push(part.value);
    }
  } catch {
    throw new CleanupFailure();
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/** Make exactly one mutating request; callers own inspection and reconciliation. */
export async function deleteSalesforcePublicationArtifacts(
  session: TenantSalesforceSession,
  requestValue: SalesforceArtifactCleanupRequest,
  perRequestTimeoutMs: number,
  overallTimeoutMs: number,
  fetchImplementation: FetchImplementation = fetch,
): Promise<SalesforceArtifactCleanupResult> {
  let request: SalesforceArtifactCleanupRequest;
  let path: string;
  let instanceOrigin: string;
  let getAccessToken: () => Promise<string>;
  try {
    request = decodeRequest(requestValue);
    if (
      session === null ||
      typeof session !== 'object' ||
      types.isProxy(session)
    )
      throw new CleanupFailure();
    const sessionDescriptors = Object.getOwnPropertyDescriptors(session);
    const expectedSessionKeys = [
      'tenantId',
      'salesforceOrgId',
      'instanceOrigin',
      'namespacePrefix',
      'credentialVersion',
      'getAccessToken',
    ];
    if (
      Reflect.ownKeys(sessionDescriptors).some(
        (key) =>
          typeof key !== 'string' ||
          !Object.hasOwn(sessionDescriptors[key]!, 'value'),
      ) ||
      Object.keys(sessionDescriptors).sort().join(',') !==
        expectedSessionKeys.sort().join(',') ||
      sessionDescriptors.getAccessToken?.enumerable !== false ||
      !Number.isSafeInteger(perRequestTimeoutMs) ||
      perRequestTimeoutMs < 1 ||
      perRequestTimeoutMs > 30_000 ||
      !Number.isSafeInteger(overallTimeoutMs) ||
      overallTimeoutMs < perRequestTimeoutMs ||
      overallTimeoutMs > 120_000 ||
      typeof fetchImplementation !== 'function'
    )
      throw new CleanupFailure();
    const values: Record<string, unknown> = Object.fromEntries(
      Object.entries(sessionDescriptors).map(([key, descriptor]) => [
        key,
        descriptor.value,
      ]),
    );
    if (
      typeof values.instanceOrigin !== 'string' ||
      new URL(values.instanceOrigin).protocol !== 'https:' ||
      new URL(values.instanceOrigin).origin !== values.instanceOrigin ||
      new URL(values.instanceOrigin).username !== '' ||
      new URL(values.instanceOrigin).password !== '' ||
      new URL(values.instanceOrigin).port !== '' ||
      !new URL(values.instanceOrigin).hostname.endsWith('.salesforce.com') ||
      typeof values.namespacePrefix !== 'string' ||
      typeof values.getAccessToken !== 'function'
    )
      throw new CleanupFailure();
    instanceOrigin = values.instanceOrigin;
    getAccessToken = values.getAccessToken as () => Promise<string>;
    path = createSalesforceNames(values.namespacePrefix).apexRestPath(
      'v1/publications/artifacts/cleanup',
    );
  } catch {
    return Object.freeze({
      ok: false,
      code: 'PUBLICATION_ARTIFACT_CLEANUP',
      requestCount: 0,
    });
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.min(perRequestTimeoutMs, overallTimeoutMs),
  );
  timer.unref();
  let requestCount = 0;
  try {
    const token = await Promise.race([
      Reflect.apply(getAccessToken, session, []),
      new Promise<never>((_, reject) =>
        controller.signal.addEventListener(
          'abort',
          () => reject(new CleanupFailure()),
          { once: true },
        ),
      ),
    ]);
    if (
      typeof token !== 'string' ||
      token.length < 1 ||
      token.length > 4096 ||
      !tokenPattern.test(token)
    )
      throw new CleanupFailure();
    requestCount++;
    const response = await Promise.race([
      fetchImplementation(`${instanceOrigin}${path}`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify({ schemaVersion: 1, ...request }),
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'manual',
        signal: controller.signal,
      }),
      new Promise<never>((_, reject) =>
        controller.signal.addEventListener(
          'abort',
          () => reject(new CleanupFailure()),
          { once: true },
        ),
      ),
    ]);
    if (
      response.status !== 200 ||
      response.redirected ||
      response.headers
        .get('content-type')
        ?.split(';', 1)[0]
        ?.trim()
        .toLowerCase() !== 'application/json'
    )
      throw new CleanupFailure();
    const body = record(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          await responseBytes(response),
        ),
      ) as unknown,
    );
    exactKeys(body, ['schemaVersion', 'deleted']);
    if (body.schemaVersion !== 1 || body.deleted !== true)
      throw new CleanupFailure();
    return Object.freeze({ ok: true, requestCount });
  } catch {
    return Object.freeze({
      ok: false,
      code: 'PUBLICATION_ARTIFACT_CLEANUP',
      requestCount,
    });
  } finally {
    clearTimeout(timer);
  }
}
