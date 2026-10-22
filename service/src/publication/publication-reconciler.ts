/** Read-only Salesforce inspection and one-way local attempt reconciliation. */
import { types } from 'node:util';
import {
  decodeTrustedAdministratorContext,
  type TrustedAdministratorContext,
} from '../tenant/administrator-session.js';
import {
  createBoundTenantSalesforceSession,
  type TenantConnectionSessionStore,
} from '../tenant/salesforce-session.js';
import {
  type PublicationAttemptStore,
  type PublicationReconciliationStatus,
} from './publication-attempt-store.js';
import { inspectSalesforcePublication } from './salesforce-publication-inspector.js';

const credentialPattern = /^[\x21-\x7e]+$/;
const attemptIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface PublicationReconcilerConfiguration {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshTimeoutMs: number;
  readonly perRequestTimeoutMs: number;
  readonly overallTimeoutMs: number;
}

export type PublicationReconciliationResult =
  | Readonly<{
      ok: true;
      status: PublicationReconciliationStatus;
      salesforceRequestCount: number;
    }>
  | Readonly<{
      ok: false;
      code:
        | 'PUBLICATION_RECONCILIATION_INPUT'
        | 'PUBLICATION_RECONCILIATION_ATTEMPT'
        | 'PUBLICATION_RECONCILIATION_SESSION'
        | 'PUBLICATION_RECONCILIATION_INSPECTION';
      salesforceRequestCount: number;
    }>;

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function configuration(value: PublicationReconcilerConfiguration) {
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expected = [
    'clientId',
    'clientSecret',
    'refreshTimeoutMs',
    'perRequestTimeoutMs',
    'overallTimeoutMs',
  ];
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'),
    ) ||
    Object.keys(descriptors).sort().join(',') !== expected.sort().join(',')
  )
    throw new Error();
  const input: Record<string, unknown> = Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
  if (
    typeof input.clientId !== 'string' ||
    input.clientId.length < 1 ||
    input.clientId.length > 512 ||
    !credentialPattern.test(input.clientId) ||
    typeof input.clientSecret !== 'string' ||
    input.clientSecret.length < 1 ||
    input.clientSecret.length > 2048 ||
    !credentialPattern.test(input.clientSecret) ||
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
    throw new Error();
  return {
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    refreshTimeoutMs: input.refreshTimeoutMs as number,
    perRequestTimeoutMs: input.perRequestTimeoutMs as number,
    overallTimeoutMs: input.overallTimeoutMs as number,
  };
}

function refusal(
  code: Exclude<PublicationReconciliationResult, { ok: true }>['code'],
  salesforceRequestCount = 0,
): PublicationReconciliationResult {
  return Object.freeze({ ok: false, code, salesforceRequestCount });
}

/**
 * Resolve recorded evidence only. This function has no publisher, commit, upload,
 * delete or non-GET Salesforce capability.
 */
export async function reconcilePublicationAttempt(
  attemptStore: Pick<PublicationAttemptStore, 'loadReconcilable' | 'resolve'>,
  connectionStore: TenantConnectionSessionStore,
  trustedContextValue: TrustedAdministratorContext,
  attemptId: string,
  configurationValue: PublicationReconcilerConfiguration,
  fetchImplementation: FetchImplementation = fetch,
): Promise<PublicationReconciliationResult> {
  let context: TrustedAdministratorContext;
  let selectedConfiguration: ReturnType<typeof configuration>;
  try {
    context = decodeTrustedAdministratorContext(trustedContextValue);
    selectedConfiguration = configuration(configurationValue);
    if (
      !attemptIdPattern.test(attemptId) ||
      typeof fetchImplementation !== 'function'
    )
      throw new Error();
  } catch {
    return refusal('PUBLICATION_RECONCILIATION_INPUT');
  }

  let attempt;
  try {
    attempt = await attemptStore.loadReconcilable(context, attemptId);
  } catch {
    return refusal('PUBLICATION_RECONCILIATION_ATTEMPT');
  }
  if (attempt.outcome === 'reconciled')
    return Object.freeze({
      ok: true,
      status: attempt.status,
      salesforceRequestCount: attempt.requestCount,
    });
  if (attempt.outcome === 'started') {
    try {
      const resolved = await attemptStore.resolve(
        context,
        attemptId,
        'started',
        'indeterminate',
        0,
      );
      return Object.freeze({
        ok: true,
        status: resolved.status,
        salesforceRequestCount: resolved.requestCount,
      });
    } catch {
      return refusal('PUBLICATION_RECONCILIATION_ATTEMPT');
    }
  }

  const deadline = performance.now() + selectedConfiguration.overallTimeoutMs;
  let session;
  try {
    session = await createBoundTenantSalesforceSession(
      connectionStore,
      {
        tenantId: context.tenantId,
        expectedSalesforceOrgId: context.expectedSalesforceOrgId,
        authorizationOrigin: context.authorizationOrigin,
        namespacePrefix: context.namespacePrefix,
      },
      {
        clientId: selectedConfiguration.clientId,
        clientSecret: selectedConfiguration.clientSecret,
        timeoutMs: Math.min(
          selectedConfiguration.refreshTimeoutMs,
          selectedConfiguration.overallTimeoutMs,
        ),
      },
      fetchImplementation,
    );
  } catch {
    return refusal('PUBLICATION_RECONCILIATION_SESSION');
  }
  const remaining = Math.ceil(deadline - performance.now());
  if (remaining < 1) return refusal('PUBLICATION_RECONCILIATION_SESSION');
  const inspected = await inspectSalesforcePublication(
    session,
    {
      formVersionId: attempt.formVersionId,
      publicationDigest: attempt.publicationDigest,
      xformVersionId: attempt.xformVersionId,
      xlsformVersionId: attempt.xlsformVersionId,
    },
    Math.min(selectedConfiguration.perRequestTimeoutMs, remaining),
    remaining,
    fetchImplementation,
  );
  if (!inspected.ok)
    return refusal(
      'PUBLICATION_RECONCILIATION_INSPECTION',
      inspected.requestCount,
    );
  try {
    const resolved = await attemptStore.resolve(
      context,
      attemptId,
      'partial',
      inspected.status,
      inspected.requestCount,
    );
    return Object.freeze({
      ok: true,
      status: resolved.status,
      salesforceRequestCount: resolved.requestCount,
    });
  } catch {
    return refusal(
      'PUBLICATION_RECONCILIATION_ATTEMPT',
      inspected.requestCount,
    );
  }
}
