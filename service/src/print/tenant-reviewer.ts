/** Tenant-bound, read-only composition of Salesforce definition review. */
import { types } from 'node:util';
import {
  decodeTrustedAdministratorContext,
  type TrustedAdministratorContext,
} from '../tenant/administrator-session.js';
import {
  createBoundTenantSalesforceSession,
  TenantSalesforceSessionError,
  type SalesforceOAuthClientConfiguration,
  type TenantConnectionSessionStore,
} from '../tenant/salesforce-session.js';
import type { TenantSalesforcePublisherConfiguration } from '../publication/tenant-salesforce-publisher.js';
import { renderPrintView, type PrintViewResult } from './render.js';

const idPattern = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const tokenPattern = /^[\x21-\x7e]+$/;
const maximumDefinitionBytes = 5_000_000;
const maximumReviewerHtmlUnits = 4_100_000;

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface TenantSalesforceReviewRequest {
  readonly formVersionId: string;
}

export type TenantSalesforceReviewFailureCode =
  | 'TENANT_REVIEW_INPUT'
  | 'TENANT_REVIEW_NOT_CONNECTED'
  | 'TENANT_REVIEW_BINDING'
  | 'TENANT_REVIEW_SESSION'
  | 'TENANT_REVIEW_DEFINITION'
  | 'TENANT_REVIEW_RENDER';

export type TenantSalesforceReviewResult =
  | Readonly<{
      ok: true;
      html: string;
      requestCount: number;
    }>
  | Readonly<{
      ok: false;
      code: TenantSalesforceReviewFailureCode;
      requestCount: number;
    }>;

class TenantReviewFailure extends Error {
  constructor(readonly code: TenantSalesforceReviewFailureCode) {
    super(code);
    this.name = 'TenantReviewFailure';
  }
}

function refuse(
  code: TenantSalesforceReviewFailureCode,
  requestCount = 0,
): TenantSalesforceReviewResult {
  return Object.freeze({ ok: false, code, requestCount });
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new TenantReviewFailure('TENANT_REVIEW_INPUT');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'),
    )
  )
    throw new TenantReviewFailure('TENANT_REVIEW_INPUT');
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
    throw new TenantReviewFailure('TENANT_REVIEW_INPUT');
}

function configuration(value: unknown): {
  oauth: SalesforceOAuthClientConfiguration;
  perRequestTimeoutMs: number;
  overallTimeoutMs: number;
} {
  const input = plainRecord(value);
  exactKeys(input, [
    'clientId',
    'clientSecret',
    'overallTimeoutMs',
    'perRequestTimeoutMs',
    'refreshTimeoutMs',
  ]);
  if (
    typeof input.clientId !== 'string' ||
    input.clientId.length < 1 ||
    input.clientId.length > 512 ||
    !tokenPattern.test(input.clientId) ||
    typeof input.clientSecret !== 'string' ||
    input.clientSecret.length < 1 ||
    input.clientSecret.length > 2_048 ||
    !tokenPattern.test(input.clientSecret) ||
    !Number.isSafeInteger(input.refreshTimeoutMs) ||
    (input.refreshTimeoutMs as number) < 1 ||
    (input.refreshTimeoutMs as number) > 30_000 ||
    !Number.isSafeInteger(input.perRequestTimeoutMs) ||
    (input.perRequestTimeoutMs as number) < 1 ||
    (input.perRequestTimeoutMs as number) > 30_000 ||
    !Number.isSafeInteger(input.overallTimeoutMs) ||
    (input.overallTimeoutMs as number) <
      (input.perRequestTimeoutMs as number) ||
    (input.overallTimeoutMs as number) > 120_000
  )
    throw new TenantReviewFailure('TENANT_REVIEW_INPUT');
  return {
    oauth: Object.freeze({
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      timeoutMs: input.refreshTimeoutMs as number,
    }),
    perRequestTimeoutMs: input.perRequestTimeoutMs as number,
    overallTimeoutMs: input.overallTimeoutMs as number,
  };
}

function request(value: unknown): TenantSalesforceReviewRequest {
  const input = plainRecord(value);
  exactKeys(input, ['formVersionId']);
  if (
    typeof input.formVersionId !== 'string' ||
    !idPattern.test(input.formVersionId)
  )
    throw new TenantReviewFailure('TENANT_REVIEW_INPUT');
  return Object.freeze({ formVersionId: input.formVersionId });
}

async function boundedBytes(
  response: Response,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > maximumDefinitionBytes
    )
      throw new TenantReviewFailure('TENANT_REVIEW_DEFINITION');
  }
  if (response.body === null)
    throw new TenantReviewFailure('TENANT_REVIEW_DEFINITION');
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
      if (length > maximumDefinitionBytes) {
        await reader.cancel().catch(() => undefined);
        throw new TenantReviewFailure('TENANT_REVIEW_DEFINITION');
      }
      chunks.push(item.value);
    }
  } catch (error) {
    if (error instanceof TenantReviewFailure) throw error;
    throw new TenantReviewFailure('TENANT_REVIEW_DEFINITION');
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

function snapshot(bytes: Uint8Array): {
  definition: unknown;
  mappingBundle: unknown;
} {
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw new TenantReviewFailure('TENANT_REVIEW_DEFINITION');
  }
  let input: Record<string, unknown>;
  try {
    input = plainRecord(value);
    exactKeys(input, ['schemaVersion', 'definition', 'mappingBundle']);
  } catch {
    throw new TenantReviewFailure('TENANT_REVIEW_DEFINITION');
  }
  if (input.schemaVersion !== 1)
    throw new TenantReviewFailure('TENANT_REVIEW_DEFINITION');
  return {
    definition: input.definition,
    mappingBundle: input.mappingBundle,
  };
}

function renderedHtml(value: PrintViewResult): string {
  try {
    if (!value.ok) throw new Error();
    const input = plainRecord(value);
    exactKeys(input, ['audience', 'html', 'ok', 'validation', 'warnings']);
    if (
      input.ok !== true ||
      input.audience !== 'reviewer-only' ||
      input.validation !== 'structural-only' ||
      typeof input.html !== 'string' ||
      input.html.length < 1 ||
      input.html.length > maximumReviewerHtmlUnits ||
      !Array.isArray(input.warnings)
    )
      throw new Error();
    return input.html;
  } catch {
    throw new TenantReviewFailure('TENANT_REVIEW_RENDER');
  }
}

/**
 * Render one Salesforce-owned definition for the live tenant without uploading,
 * publishing, committing, reconciling, or mutating definition/business data.
 * The shared session may persist a provider-issued refresh-token rotation.
 */
export async function reviewTenantSalesforceDefinition(
  store: TenantConnectionSessionStore,
  trustedContextValue: TrustedAdministratorContext,
  configurationValue: TenantSalesforcePublisherConfiguration,
  requestValue: TenantSalesforceReviewRequest,
  fetchImplementation: FetchImplementation = fetch,
  renderer: typeof renderPrintView = renderPrintView,
): Promise<TenantSalesforceReviewResult> {
  let context: TrustedAdministratorContext;
  let decoded: ReturnType<typeof configuration>;
  let selected: TenantSalesforceReviewRequest;
  try {
    context = decodeTrustedAdministratorContext(trustedContextValue);
    decoded = configuration(configurationValue);
    selected = request(requestValue);
    if (
      typeof fetchImplementation !== 'function' ||
      typeof renderer !== 'function'
    )
      throw new TenantReviewFailure('TENANT_REVIEW_INPUT');
  } catch {
    return refuse('TENANT_REVIEW_INPUT');
  }

  const deadline = performance.now() + decoded.overallTimeoutMs;
  let session;
  try {
    session = await createBoundTenantSalesforceSession(
      store,
      {
        tenantId: context.tenantId,
        expectedSalesforceOrgId: context.expectedSalesforceOrgId,
        authorizationOrigin: context.authorizationOrigin,
        namespacePrefix: context.namespacePrefix,
      },
      {
        ...decoded.oauth,
        timeoutMs: Math.min(decoded.oauth.timeoutMs, decoded.overallTimeoutMs),
      },
      fetchImplementation,
    );
  } catch (error) {
    if (error instanceof TenantSalesforceSessionError) {
      if (error.code === 'TENANT_SALESFORCE_SESSION_NOT_CONNECTED')
        return refuse('TENANT_REVIEW_NOT_CONNECTED');
      if (error.code === 'TENANT_SALESFORCE_SESSION_BINDING')
        return refuse('TENANT_REVIEW_BINDING');
      if (error.code === 'TENANT_SALESFORCE_SESSION_INPUT')
        return refuse('TENANT_REVIEW_INPUT');
    }
    return refuse('TENANT_REVIEW_SESSION');
  }

  const remaining = Math.ceil(deadline - performance.now());
  if (remaining < 1) return refuse('TENANT_REVIEW_SESSION');
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.min(decoded.perRequestTimeoutMs, remaining),
  );
  timer.unref();
  let requestCount = 0;
  try {
    const operation = async (): Promise<string> => {
      const accessToken = await session.getAccessToken();
      if (
        typeof accessToken !== 'string' ||
        accessToken.length < 1 ||
        accessToken.length > 4096 ||
        !tokenPattern.test(accessToken) ||
        controller.signal.aborted
      )
        throw new TenantReviewFailure('TENANT_REVIEW_SESSION');
      requestCount++;
      const response = await fetchImplementation(
        `${session.instanceOrigin}/services/apexrest/v1/publications/definition`,
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json; charset=UTF-8',
          },
          body: JSON.stringify({
            schemaVersion: 1,
            formVersionId: selected.formVersionId,
          }),
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
        throw new TenantReviewFailure('TENANT_REVIEW_DEFINITION');
      const source = snapshot(await boundedBytes(response, controller.signal));
      let result: PrintViewResult;
      try {
        result = renderer(source.definition, source.mappingBundle);
      } catch {
        throw new TenantReviewFailure('TENANT_REVIEW_RENDER');
      }
      return renderedHtml(result);
    };
    const timeout = new Promise<never>((_, reject) =>
      controller.signal.addEventListener(
        'abort',
        () => reject(new TenantReviewFailure('TENANT_REVIEW_DEFINITION')),
        { once: true },
      ),
    );
    const html = await Promise.race([operation(), timeout]);
    return Object.freeze({ ok: true, html, requestCount });
  } catch (error) {
    return refuse(
      error instanceof TenantReviewFailure
        ? error.code
        : 'TENANT_REVIEW_DEFINITION',
      requestCount,
    );
  } finally {
    clearTimeout(timer);
  }
}
