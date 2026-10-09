/** Attempt-scoped composition of the reviewed Salesforce publication boundaries. */
import { types } from 'node:util';
import type { Diagnostic } from '../compiler/types.js';
import type { ValidateXForm } from './odk-validate.js';
import { createPublicationPackage } from './package.js';
import {
  attestSalesforcePublicationArtifacts,
  type SalesforceArtifactResult,
} from './salesforce-artifact-transport.js';
import { createSalesforceDescribeTransport } from './salesforce-describe-transport.js';

export const salesforcePublisherApiVersion = '64.0';
const idPattern = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const tokenPattern = /^[\x21-\x7e]+$/;
const maxDefinitionBytes = 5_000_000;
const maxCommitBytes = 65_536;

export interface SalesforcePublisherConfiguration {
  readonly instanceOrigin: string;
  readonly getAccessToken: () => Promise<unknown>;
  readonly perRequestTimeoutMs: number;
  readonly overallTimeoutMs: number;
}

export interface SalesforcePublicationRequest {
  readonly formVersionId: string;
}

type PublisherFailureCode =
  | 'PUBLICATION_PUBLISHER_INPUT'
  | 'PUBLICATION_PUBLISHER_DEFINITION'
  | 'PUBLICATION_PUBLISHER_COMMIT';

export type SalesforcePublisherResult =
  | Readonly<{
      ok: true;
      publicationDigest: string;
      alreadyCommitted: boolean;
      requestCount: number;
    }>
  | Readonly<{
      ok: false;
      diagnostics: readonly Diagnostic[];
      requestCount: number;
    }>;

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

class PublisherFailure extends Error {
  constructor(readonly code: PublisherFailureCode) {
    super(code);
    this.name = 'PublisherFailure';
  }
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

function plainRecord(
  value: unknown,
  code: PublisherFailureCode,
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new PublisherFailure(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'),
    )
  )
    throw new PublisherFailure(code);
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
  code: PublisherFailureCode,
): void {
  if (
    Object.keys(value).sort(compareText).join(',') !==
    [...expected].sort(compareText).join(',')
  )
    throw new PublisherFailure(code);
}

function decodeConfiguration(value: unknown): {
  origin: string;
  token: () => Promise<unknown>;
  perRequest: number;
  overall: number;
} {
  const record = plainRecord(value, 'PUBLICATION_PUBLISHER_INPUT');
  exactKeys(
    record,
    [
      'instanceOrigin',
      'getAccessToken',
      'perRequestTimeoutMs',
      'overallTimeoutMs',
    ],
    'PUBLICATION_PUBLISHER_INPUT',
  );
  if (typeof record.instanceOrigin !== 'string')
    throw new PublisherFailure('PUBLICATION_PUBLISHER_INPUT');
  let url: URL;
  try {
    url = new URL(record.instanceOrigin);
  } catch {
    throw new PublisherFailure('PUBLICATION_PUBLISHER_INPUT');
  }
  if (
    url.protocol !== 'https:' ||
    url.origin !== record.instanceOrigin ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    !url.hostname.endsWith('.salesforce.com') ||
    typeof record.getAccessToken !== 'function' ||
    !Number.isSafeInteger(record.perRequestTimeoutMs) ||
    (record.perRequestTimeoutMs as number) < 1 ||
    (record.perRequestTimeoutMs as number) > 30_000 ||
    !Number.isSafeInteger(record.overallTimeoutMs) ||
    (record.overallTimeoutMs as number) <
      (record.perRequestTimeoutMs as number) ||
    (record.overallTimeoutMs as number) > 120_000
  )
    throw new PublisherFailure('PUBLICATION_PUBLISHER_INPUT');
  return {
    origin: url.origin,
    token: record.getAccessToken as () => Promise<unknown>,
    perRequest: record.perRequestTimeoutMs as number,
    overall: record.overallTimeoutMs as number,
  };
}

function decodeRequest(value: unknown): string {
  const record = plainRecord(value, 'PUBLICATION_PUBLISHER_INPUT');
  exactKeys(record, ['formVersionId'], 'PUBLICATION_PUBLISHER_INPUT');
  if (
    typeof record.formVersionId !== 'string' ||
    !idPattern.test(record.formVersionId)
  )
    throw new PublisherFailure('PUBLICATION_PUBLISHER_INPUT');
  return record.formVersionId;
}

function immutableDiagnostics(
  diagnostics: readonly Diagnostic[],
): readonly Diagnostic[] {
  return Object.freeze(
    diagnostics.map(({ code, location }) => Object.freeze({ code, location })),
  );
}

function refusal(
  diagnostics: readonly Diagnostic[],
  requestCount: number,
): SalesforcePublisherResult {
  return Object.freeze({
    ok: false,
    diagnostics: immutableDiagnostics(diagnostics),
    requestCount,
  });
}

function publisherRefusal(
  code: PublisherFailureCode,
  requestCount: number,
): SalesforcePublisherResult {
  return refusal([{ code, location: 'publisher' }], requestCount);
}

async function boundedBytes(
  response: Response,
  maximum: number,
  signal: AbortSignal,
  code: PublisherFailureCode,
): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maximum)
      throw new PublisherFailure(code);
  }
  if (response.body === null) throw new PublisherFailure(code);
  const reader = response.body.getReader();
  const cancel = (): void => void reader.cancel().catch(() => undefined);
  if (signal.aborted) cancel();
  else signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new PublisherFailure(code);
      }
      chunks.push(item.value);
    }
  } catch (error) {
    if (error instanceof PublisherFailure) throw error;
    throw new PublisherFailure(code);
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

function json(bytes: Uint8Array, code: PublisherFailureCode): unknown {
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw new PublisherFailure(code);
  }
}

function decodeDefinition(value: unknown): {
  definition: unknown;
  mappings: unknown;
} {
  const body = plainRecord(value, 'PUBLICATION_PUBLISHER_DEFINITION');
  exactKeys(
    body,
    ['schemaVersion', 'definition', 'mappingBundle'],
    'PUBLICATION_PUBLISHER_DEFINITION',
  );
  if (body.schemaVersion !== 1)
    throw new PublisherFailure('PUBLICATION_PUBLISHER_DEFINITION');
  return { definition: body.definition, mappings: body.mappingBundle };
}

function decodeCommit(value: unknown, expectedDigest: string): boolean {
  const body = plainRecord(value, 'PUBLICATION_PUBLISHER_COMMIT');
  exactKeys(
    body,
    ['schemaVersion', 'alreadyCommitted', 'publicationDigest'],
    'PUBLICATION_PUBLISHER_COMMIT',
  );
  if (
    body.schemaVersion !== 1 ||
    typeof body.alreadyCommitted !== 'boolean' ||
    body.publicationDigest !== expectedDigest
  )
    throw new PublisherFailure('PUBLICATION_PUBLISHER_COMMIT');
  return body.alreadyCommitted;
}

/**
 * Publish one Salesforce-owned definition through the reviewed boundaries. The
 * supplied token capability must remain bound to one org and principal for the
 * whole call; this function never selects or stores credentials.
 */
export async function publishSalesforceDefinition(
  configurationValue: SalesforcePublisherConfiguration,
  requestValue: SalesforcePublicationRequest,
  validateXForm: ValidateXForm,
  fetchImplementation: FetchImplementation = fetch,
): Promise<SalesforcePublisherResult> {
  let configuration: ReturnType<typeof decodeConfiguration>;
  let formVersionId: string;
  try {
    configuration = decodeConfiguration(configurationValue);
    formVersionId = decodeRequest(requestValue);
    if (typeof validateXForm !== 'function')
      throw new PublisherFailure('PUBLICATION_PUBLISHER_INPUT');
  } catch {
    return publisherRefusal('PUBLICATION_PUBLISHER_INPUT', 0);
  }

  const deadline = performance.now() + configuration.overall;
  let requestCount = 0;
  const remaining = (code: PublisherFailureCode): number => {
    const value = deadline - performance.now();
    if (value <= 0) throw new PublisherFailure(code);
    return Math.max(1, Math.ceil(value));
  };
  const token = async (code: PublisherFailureCode): Promise<string> => {
    const budget = Math.min(configuration.perRequest, remaining(code));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);
    timer.unref();
    try {
      const value = await Promise.race([
        configuration.token(),
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener(
            'abort',
            () => reject(new PublisherFailure(code)),
            { once: true },
          ),
        ),
      ]);
      if (
        typeof value !== 'string' ||
        value.length < 1 ||
        value.length > 4096 ||
        !tokenPattern.test(value)
      )
        throw new PublisherFailure(code);
      return value;
    } catch (error) {
      if (error instanceof PublisherFailure) throw error;
      throw new PublisherFailure(code);
    } finally {
      clearTimeout(timer);
    }
  };
  const post = async (
    path: string,
    body: string,
    maximum: number,
    code: PublisherFailureCode,
  ): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(configuration.perRequest, remaining(code)),
    );
    timer.unref();
    try {
      const operation = async (): Promise<unknown> => {
        const accessToken = await token(code);
        requestCount++;
        const response = await fetchImplementation(
          `${configuration.origin}/services/apexrest${path}`,
          {
            method: 'POST',
            headers: {
              accept: 'application/json',
              authorization: `Bearer ${accessToken}`,
              'content-type': 'application/json; charset=UTF-8',
            },
            body,
            cache: 'no-store',
            credentials: 'omit',
            redirect: 'manual',
            signal: controller.signal,
          },
        );
        if (
          response.status !== 200 ||
          response.redirected ||
          response.headers
            .get('content-type')
            ?.split(';', 1)[0]
            ?.trim()
            .toLowerCase() !== 'application/json'
        )
          throw new PublisherFailure(code);
        return json(
          await boundedBytes(response, maximum, controller.signal, code),
          code,
        );
      };
      const timeout = new Promise<never>((_, reject) =>
        controller.signal.addEventListener(
          'abort',
          () => reject(new PublisherFailure(code)),
          { once: true },
        ),
      );
      return await Promise.race([operation(), timeout]);
    } catch (error) {
      if (error instanceof PublisherFailure) throw error;
      throw new PublisherFailure(code);
    } finally {
      clearTimeout(timer);
    }
  };

  let snapshot: ReturnType<typeof decodeDefinition>;
  try {
    snapshot = decodeDefinition(
      await post(
        '/v1/publications/definition',
        JSON.stringify({ schemaVersion: 1, formVersionId }),
        maxDefinitionBytes,
        'PUBLICATION_PUBLISHER_DEFINITION',
      ),
    );
  } catch {
    return publisherRefusal('PUBLICATION_PUBLISHER_DEFINITION', requestCount);
  }

  const boundedConfiguration = (code: PublisherFailureCode) => {
    const budget = remaining(code);
    return {
      instanceOrigin: configuration.origin,
      getAccessToken: async (): Promise<string> => await token(code),
      perRequestTimeoutMs: Math.min(configuration.perRequest, budget),
      overallTimeoutMs: budget,
    };
  };

  const describeStart = requestCount;
  const describeCalls = { value: 0 };
  const describeFetch: FetchImplementation = async (input, init) => {
    describeCalls.value++;
    return await fetchImplementation(input, init);
  };
  let packaged: Awaited<ReturnType<typeof createPublicationPackage>>;
  try {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      remaining('PUBLICATION_PUBLISHER_DEFINITION'),
    );
    timer.unref();
    try {
      packaged = await Promise.race([
        createPublicationPackage(
          snapshot.definition,
          snapshot.mappings,
          createSalesforceDescribeTransport(
            boundedConfiguration('PUBLICATION_PUBLISHER_DEFINITION'),
            describeFetch,
          ),
          validateXForm,
        ),
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener(
            'abort',
            () =>
              reject(new PublisherFailure('PUBLICATION_PUBLISHER_DEFINITION')),
            { once: true },
          ),
        ),
      ]);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return publisherRefusal(
      'PUBLICATION_PUBLISHER_DEFINITION',
      describeStart + describeCalls.value,
    );
  }
  requestCount += describeCalls.value;
  if (!packaged.ok) return refusal(packaged.diagnostics, requestCount);

  const warnings =
    packaged.warnings.length === 0 ? null : JSON.stringify(packaged.warnings);
  if (warnings !== null && warnings.length > 32_768)
    return publisherRefusal('PUBLICATION_PUBLISHER_COMMIT', requestCount);

  let artifacts: SalesforceArtifactResult;
  try {
    artifacts = await attestSalesforcePublicationArtifacts(
      boundedConfiguration('PUBLICATION_PUBLISHER_COMMIT'),
      {
        packageJson: packaged.packageJson,
        packageSha256: packaged.packageSha256,
      },
      fetchImplementation,
    );
  } catch {
    return publisherRefusal('PUBLICATION_PUBLISHER_COMMIT', requestCount);
  }
  requestCount += artifacts.requestCount;
  if (!artifacts.ok) return refusal([artifacts.diagnostic], requestCount);

  const commitBody = JSON.stringify({
    schemaVersion: 1,
    formVersionId,
    publicationDigest: packaged.packageSha256,
    xformVersionId: artifacts.xformVersionId,
    xlsformVersionId: artifacts.xlsformVersionId,
    compileWarnings: warnings,
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const committed = decodeCommit(
        await post(
          '/v1/publications/commit',
          commitBody,
          maxCommitBytes,
          'PUBLICATION_PUBLISHER_COMMIT',
        ),
        packaged.packageSha256,
      );
      return Object.freeze({
        ok: true,
        publicationDigest: packaged.packageSha256,
        alreadyCommitted: committed,
        requestCount,
      });
    } catch {
      if (attempt === 1)
        return publisherRefusal('PUBLICATION_PUBLISHER_COMMIT', requestCount);
    }
  }
  return publisherRefusal('PUBLICATION_PUBLISHER_COMMIT', requestCount);
}
