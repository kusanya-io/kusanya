/** Privileged cleanup orchestration with durable admission and remote reconciliation. */
import { types } from 'node:util';
import {
  decodeTrustedAdministratorContext,
  type TrustedAdministratorContext,
} from '../tenant/administrator-session.js';
import {
  createBoundTenantSalesforceSession,
  type TenantConnectionSessionStore,
} from '../tenant/salesforce-session.js';
import type { PublicationAttemptStore } from './publication-attempt-store.js';
import { deleteSalesforcePublicationArtifacts } from './salesforce-artifact-cleaner.js';
import { inspectSalesforcePublication } from './salesforce-publication-inspector.js';

const credentialPattern = /^[\x21-\x7e]+$/;

export interface PublicationArtifactCleanupConfiguration {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshTimeoutMs: number;
  readonly perRequestTimeoutMs: number;
  readonly overallTimeoutMs: number;
}

export type PublicationArtifactCleanupExecutionResult = Readonly<{
  ok: boolean;
  outcome: 'succeeded' | 'failed' | 'indeterminate';
}>;

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function configuration(value: PublicationArtifactCleanupConfiguration) {
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = [
    'clientId',
    'clientSecret',
    'refreshTimeoutMs',
    'perRequestTimeoutMs',
    'overallTimeoutMs',
  ];
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string') ||
    Object.keys(descriptors).sort().join(',') !== keys.sort().join(',') ||
    Object.values(descriptors).some(
      (descriptor) => !Object.hasOwn(descriptor, 'value'),
    )
  )
    throw new Error();
  const input = Object.fromEntries(
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
  return input as unknown as PublicationArtifactCleanupConfiguration;
}

/** Execute or resume one cleanup. No state can authorize publication. */
export async function cleanupPublicationArtifacts(
  attemptStore: Pick<
    PublicationAttemptStore,
    'startArtifactCleanup' | 'completeArtifactCleanup'
  >,
  connectionStore: TenantConnectionSessionStore,
  contextValue: TrustedAdministratorContext,
  sourceAttemptId: string,
  configurationValue: PublicationArtifactCleanupConfiguration,
  fetchImplementation: FetchImplementation = fetch,
): Promise<PublicationArtifactCleanupExecutionResult> {
  let context: TrustedAdministratorContext;
  let selected: ReturnType<typeof configuration>;
  try {
    context = decodeTrustedAdministratorContext(contextValue);
    selected = configuration(configurationValue);
    if (typeof fetchImplementation !== 'function') throw new Error();
  } catch {
    return Object.freeze({ ok: false, outcome: 'failed' });
  }
  const started = await attemptStore.startArtifactCleanup(
    context,
    sourceAttemptId,
  );
  const deadline = performance.now() + selected.overallTimeoutMs;
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
        clientId: selected.clientId,
        clientSecret: selected.clientSecret,
        timeoutMs: Math.min(
          selected.refreshTimeoutMs,
          selected.overallTimeoutMs,
        ),
      },
      fetchImplementation,
    );
  } catch {
    return Object.freeze({ ok: false, outcome: 'indeterminate' });
  }
  const evidence = {
    formVersionId: started.formVersionId,
    publicationDigest: started.publicationDigest,
    xformVersionId: started.xformVersionId,
    xlsformVersionId: started.xlsformVersionId,
  };
  let requestCount = 0;
  const inspect = async () => {
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining < 1) return null;
    const result = await inspectSalesforcePublication(
      session,
      evidence,
      Math.min(selected.perRequestTimeoutMs, remaining),
      remaining,
      fetchImplementation,
    );
    requestCount += result.requestCount;
    return result;
  };
  const finish = async (
    outcome: 'succeeded' | 'failed' | 'indeterminate',
  ): Promise<PublicationArtifactCleanupExecutionResult> => {
    if (requestCount > 0)
      outcome = await attemptStore.completeArtifactCleanup(
        context,
        started.cleanupAttemptId,
        outcome,
        requestCount,
      );
    return Object.freeze({ ok: outcome === 'succeeded', outcome });
  };

  const before = await inspect();
  if (before === null || !before.ok) return await finish('indeterminate');
  if (before.status === 'artifacts_missing') return await finish('succeeded');
  if (before.status === 'committed') return await finish('failed');

  const remaining = Math.ceil(deadline - performance.now());
  if (remaining < 1) return await finish('indeterminate');
  const deleted = await deleteSalesforcePublicationArtifacts(
    session,
    evidence,
    Math.min(selected.perRequestTimeoutMs, remaining),
    remaining,
    fetchImplementation,
  );
  requestCount += deleted.requestCount;
  if (deleted.ok) return await finish('succeeded');

  const after = await inspect();
  if (after?.ok && after.status === 'artifacts_missing')
    return await finish('succeeded');
  if (after?.ok && ['unlinked', 'committed'].includes(after.status))
    return await finish('failed');
  return await finish('indeterminate');
}
