/** Tenant-bound composition of the reviewed Salesforce session and publisher. */
import { types } from 'node:util';
import type { Diagnostic } from '../compiler/types.js';
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
import type { ValidateXForm } from './odk-validate.js';
import {
  publishSalesforceDefinition,
  type RecordSalesforcePublicationPartial,
  type SalesforcePublicationRequest,
  type SalesforcePublisherResult,
} from './salesforce-publisher.js';

const idPattern = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const clientCredentialPattern = /^[\x21-\x7e]+$/;

export interface TenantSalesforcePublisherConfiguration {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshTimeoutMs: number;
  readonly perRequestTimeoutMs: number;
  readonly overallTimeoutMs: number;
}

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type TenantPublisherFailureCode =
  | 'TENANT_PUBLICATION_INPUT'
  | 'TENANT_PUBLICATION_NOT_CONNECTED'
  | 'TENANT_PUBLICATION_BINDING'
  | 'TENANT_PUBLICATION_SESSION';

function refusal(code: TenantPublisherFailureCode): SalesforcePublisherResult {
  const diagnostic: Diagnostic = Object.freeze({
    code,
    location: 'publisher',
  });
  return Object.freeze({
    ok: false,
    diagnostics: Object.freeze([diagnostic]),
    requestCount: 0,
  });
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error('TENANT_PUBLICATION_INPUT');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'),
    )
  )
    throw new Error('TENANT_PUBLICATION_INPUT');
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
}

function configuration(value: unknown): {
  oauth: SalesforceOAuthClientConfiguration;
  perRequestTimeoutMs: number;
  overallTimeoutMs: number;
} {
  const input = plainRecord(value);
  const keys = [
    'clientId',
    'clientSecret',
    'overallTimeoutMs',
    'perRequestTimeoutMs',
    'refreshTimeoutMs',
  ];
  if (Object.keys(input).sort().join(',') !== keys.sort().join(','))
    throw new Error('TENANT_PUBLICATION_INPUT');
  if (
    typeof input.clientId !== 'string' ||
    input.clientId.length < 1 ||
    input.clientId.length > 512 ||
    !clientCredentialPattern.test(input.clientId) ||
    typeof input.clientSecret !== 'string' ||
    input.clientSecret.length < 1 ||
    input.clientSecret.length > 2_048 ||
    !clientCredentialPattern.test(input.clientSecret) ||
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
    throw new Error('TENANT_PUBLICATION_INPUT');
  return {
    oauth: {
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      timeoutMs: input.refreshTimeoutMs as number,
    },
    perRequestTimeoutMs: input.perRequestTimeoutMs as number,
    overallTimeoutMs: input.overallTimeoutMs as number,
  };
}

function request(value: unknown): SalesforcePublicationRequest {
  const input = plainRecord(value);
  if (
    Object.keys(input).length !== 1 ||
    !Object.hasOwn(input, 'formVersionId') ||
    typeof input.formVersionId !== 'string' ||
    !idPattern.test(input.formVersionId)
  )
    throw new Error('TENANT_PUBLICATION_INPUT');
  return Object.freeze({ formVersionId: input.formVersionId });
}

/**
 * Publish for one live administrator context. The encrypted tenant connection
 * is the sole source of Salesforce credentials and its immutable tuple must
 * match provisioning before OAuth or publication network I/O begins.
 */
export async function publishTenantSalesforceDefinition(
  store: TenantConnectionSessionStore,
  trustedContextValue: TrustedAdministratorContext,
  configurationValue: TenantSalesforcePublisherConfiguration,
  requestValue: SalesforcePublicationRequest,
  validateXForm: ValidateXForm,
  fetchImplementation: FetchImplementation = fetch,
  recordPartial?: RecordSalesforcePublicationPartial,
): Promise<SalesforcePublisherResult> {
  let context: TrustedAdministratorContext;
  let decoded: ReturnType<typeof configuration>;
  let publicationRequest: SalesforcePublicationRequest;
  try {
    context = decodeTrustedAdministratorContext(trustedContextValue);
    decoded = configuration(configurationValue);
    publicationRequest = request(requestValue);
    if (
      typeof validateXForm !== 'function' ||
      typeof fetchImplementation !== 'function' ||
      (recordPartial !== undefined && typeof recordPartial !== 'function')
    )
      throw new Error('TENANT_PUBLICATION_INPUT');
  } catch {
    return refusal('TENANT_PUBLICATION_INPUT');
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
        return refusal('TENANT_PUBLICATION_NOT_CONNECTED');
      if (error.code === 'TENANT_SALESFORCE_SESSION_BINDING')
        return refusal('TENANT_PUBLICATION_BINDING');
      if (error.code === 'TENANT_SALESFORCE_SESSION_INPUT')
        return refusal('TENANT_PUBLICATION_INPUT');
    }
    return refusal('TENANT_PUBLICATION_SESSION');
  }

  const remaining = Math.ceil(deadline - performance.now());
  if (remaining < 1) return refusal('TENANT_PUBLICATION_SESSION');

  return await publishSalesforceDefinition(
    {
      instanceOrigin: session.instanceOrigin,
      getAccessToken: async () => await session.getAccessToken(),
      perRequestTimeoutMs: Math.min(decoded.perRequestTimeoutMs, remaining),
      overallTimeoutMs: remaining,
    },
    publicationRequest,
    validateXForm,
    fetchImplementation,
    recordPartial,
  );
}
