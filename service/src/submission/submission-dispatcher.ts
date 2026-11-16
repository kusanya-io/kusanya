/** Bounded relay orchestration with credential-time tenant revalidation. */
import { types } from 'node:util';
import {
  createBoundTenantSalesforceSession,
  type SalesforceOAuthClientConfiguration,
  type TenantConnectionSessionStore,
  type TenantSalesforceSession,
} from '../tenant/salesforce-session.js';
import type { ClaimedSubmission } from './submission-relay-store.js';

const tenantIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const credentialPattern = /^[\x21-\x7e]+$/;

export type SubmissionDispatcherFailureCode =
  'SUBMISSION_DISPATCH_INPUT' | 'SUBMISSION_DISPATCH_STORAGE';

export class SubmissionDispatcherError extends Error {
  constructor(readonly code: SubmissionDispatcherFailureCode) {
    super(code);
    this.name = 'SubmissionDispatcherError';
  }
}

export interface SubmissionDispatcherConfiguration {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshTimeoutMs: number;
  readonly dispatchTimeoutMs: number;
  readonly leaseTimeoutMs: number;
  readonly retryDelayMs: number;
  readonly batchLimit: number;
}

export interface SubmissionDeliveryRequest {
  readonly session: TenantSalesforceSession;
  readonly submissions: readonly ClaimedSubmission[];
  readonly signal: AbortSignal;
}

export interface SubmissionDeliveryOutcome {
  readonly relayId: string;
  readonly disposition: 'committed' | 'retry' | 'dead';
}

export type DeliverSubmissionBatch = (
  request: SubmissionDeliveryRequest,
) => Promise<readonly SubmissionDeliveryOutcome[]>;

export interface SubmissionDispatcherStore {
  recoverStale(
    tenantId: string,
    staleBefore: Date,
    retryAt: Date,
    limit: number,
  ): Promise<number>;
  claimBatch(
    tenantId: string,
    limit: number,
    now: Date,
  ): Promise<readonly ClaimedSubmission[]>;
  markCommitted(
    tenantId: string,
    relayId: string,
    attempt: number,
  ): Promise<void>;
  markFailed(
    tenantId: string,
    relayId: string,
    attempt: number,
    failureCode: string,
    retryAt?: Date,
  ): Promise<void>;
}

export interface SubmissionDispatchRun {
  readonly recovered: number;
  readonly claimed: number;
  readonly committed: number;
  readonly retry: number;
  readonly dead: number;
}

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function fail(code: SubmissionDispatcherFailureCode): never {
  throw new SubmissionDispatcherError(code);
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail('SUBMISSION_DISPATCH_INPUT');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'),
    )
  )
    fail('SUBMISSION_DISPATCH_INPUT');
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  )
    fail('SUBMISSION_DISPATCH_INPUT');
  return value as number;
}

function configuration(value: unknown): {
  oauth: SalesforceOAuthClientConfiguration;
  dispatchTimeoutMs: number;
  leaseTimeoutMs: number;
  retryDelayMs: number;
  batchLimit: number;
} {
  const decoded = plainRecord(value);
  const keys = [
    'batchLimit',
    'clientId',
    'clientSecret',
    'dispatchTimeoutMs',
    'leaseTimeoutMs',
    'refreshTimeoutMs',
    'retryDelayMs',
  ];
  if (Object.keys(decoded).sort().join(',') !== keys.join(','))
    fail('SUBMISSION_DISPATCH_INPUT');
  if (
    typeof decoded.clientId !== 'string' ||
    decoded.clientId.length < 1 ||
    decoded.clientId.length > 512 ||
    !credentialPattern.test(decoded.clientId) ||
    typeof decoded.clientSecret !== 'string' ||
    decoded.clientSecret.length < 1 ||
    decoded.clientSecret.length > 2048 ||
    !credentialPattern.test(decoded.clientSecret)
  )
    fail('SUBMISSION_DISPATCH_INPUT');
  const refreshTimeoutMs = integer(decoded.refreshTimeoutMs, 1, 30_000);
  const dispatchTimeoutMs = integer(decoded.dispatchTimeoutMs, 1, 120_000);
  const leaseTimeoutMs = integer(decoded.leaseTimeoutMs, 1_001, 3_600_000);
  if (leaseTimeoutMs < refreshTimeoutMs + dispatchTimeoutMs + 1_000)
    fail('SUBMISSION_DISPATCH_INPUT');
  return {
    oauth: {
      clientId: decoded.clientId,
      clientSecret: decoded.clientSecret,
      timeoutMs: refreshTimeoutMs,
    },
    dispatchTimeoutMs,
    leaseTimeoutMs,
    retryDelayMs: integer(decoded.retryDelayMs, 1_000, 86_400_000),
    batchLimit: integer(decoded.batchLimit, 1, 200),
  };
}

function checkedTenantId(value: unknown): string {
  if (typeof value !== 'string' || !tenantIdPattern.test(value))
    fail('SUBMISSION_DISPATCH_INPUT');
  return value;
}

function checkedDate(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    fail('SUBMISSION_DISPATCH_INPUT');
  return new Date(value.getTime());
}

function emptyRun(recovered: number): SubmissionDispatchRun {
  return Object.freeze({
    recovered,
    claimed: 0,
    committed: 0,
    retry: 0,
    dead: 0,
  });
}

function outcomes(
  value: unknown,
  submissions: readonly ClaimedSubmission[],
): ReadonlyMap<string, SubmissionDeliveryOutcome> | undefined {
  if (
    !Array.isArray(value) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  )
    return;
  const arrayDescriptors = Object.getOwnPropertyDescriptors(value);
  if (
    value.length !== submissions.length ||
    Object.keys(arrayDescriptors).some(
      (key) =>
        key !== 'length' &&
        (!/^\d+$/.test(key) || !Object.hasOwn(arrayDescriptors[key]!, 'value')),
    ) ||
    Object.keys(arrayDescriptors).length !== value.length + 1
  )
    return;
  const expected = new Set(submissions.map((submission) => submission.relayId));
  const decoded = new Map<string, SubmissionDeliveryOutcome>();
  for (let index = 0; index < value.length; index++) {
    const item = arrayDescriptors[String(index)]!.value as unknown;
    let record: Record<string, unknown>;
    try {
      record = plainRecord(item);
    } catch {
      return;
    }
    if (
      Object.keys(record).sort().join(',') !== 'disposition,relayId' ||
      typeof record.relayId !== 'string' ||
      !expected.has(record.relayId) ||
      decoded.has(record.relayId) ||
      typeof record.disposition !== 'string' ||
      !['committed', 'retry', 'dead'].includes(record.disposition)
    )
      return;
    decoded.set(
      record.relayId,
      Object.freeze({
        relayId: record.relayId,
        disposition:
          record.disposition as SubmissionDeliveryOutcome['disposition'],
      }),
    );
  }
  return decoded.size === expected.size ? decoded : undefined;
}

async function retryAll(
  store: SubmissionDispatcherStore,
  submissions: readonly ClaimedSubmission[],
  failureCode: string,
  retryAt: Date,
): Promise<SubmissionDispatchRun> {
  let retry = 0;
  let dead = 0;
  try {
    for (const submission of submissions) {
      await store.markFailed(
        submission.tenantId,
        submission.relayId,
        submission.attempt,
        failureCode,
        retryAt,
      );
      if (submission.attempt >= 100) dead++;
      else retry++;
    }
  } catch {
    fail('SUBMISSION_DISPATCH_STORAGE');
  }
  return Object.freeze({
    recovered: 0,
    claimed: submissions.length,
    committed: 0,
    retry,
    dead,
  });
}

/**
 * Recover expired work, claim one tenant batch, then load the credential under
 * its connection lock. Claim-time joins are scheduling hints, never authority.
 */
export async function dispatchTenantSubmissionBatch(
  store: SubmissionDispatcherStore,
  connectionStore: TenantConnectionSessionStore,
  tenantIdValue: string,
  configurationValue: SubmissionDispatcherConfiguration,
  deliver: DeliverSubmissionBatch,
  nowValue: Date,
  fetchImplementation: FetchImplementation = fetch,
): Promise<SubmissionDispatchRun> {
  if (
    store === null ||
    typeof store !== 'object' ||
    typeof store.recoverStale !== 'function' ||
    typeof store.claimBatch !== 'function' ||
    typeof store.markCommitted !== 'function' ||
    typeof store.markFailed !== 'function' ||
    connectionStore === null ||
    typeof connectionStore !== 'object' ||
    typeof connectionStore.withRefreshLock !== 'function' ||
    typeof deliver !== 'function' ||
    typeof fetchImplementation !== 'function'
  )
    fail('SUBMISSION_DISPATCH_INPUT');
  const tenantId = checkedTenantId(tenantIdValue);
  const decoded = configuration(configurationValue);
  const now = checkedDate(nowValue);
  const staleBefore = new Date(now.getTime() - decoded.leaseTimeoutMs);
  const retryAt = new Date(now.getTime() + decoded.retryDelayMs);
  let recovered: number;
  let submissions: readonly ClaimedSubmission[];
  try {
    recovered = await store.recoverStale(
      tenantId,
      staleBefore,
      now,
      decoded.batchLimit,
    );
    submissions = await store.claimBatch(tenantId, decoded.batchLimit, now);
  } catch {
    fail('SUBMISSION_DISPATCH_STORAGE');
  }
  if (
    !Number.isInteger(recovered) ||
    recovered < 0 ||
    recovered > decoded.batchLimit
  )
    fail('SUBMISSION_DISPATCH_STORAGE');
  if (submissions.length === 0) return emptyRun(recovered);

  const first = submissions[0]!;
  if (
    submissions.some(
      (submission) =>
        submission.tenantId !== tenantId ||
        submission.salesforceOrgId !== first.salesforceOrgId ||
        submission.authorizationOrigin !== first.authorizationOrigin ||
        submission.namespacePrefix !== first.namespacePrefix,
    )
  )
    fail('SUBMISSION_DISPATCH_STORAGE');

  let session: TenantSalesforceSession;
  let sessionTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const sessionDeadline = new Promise<never>((_, reject) => {
      sessionTimer = setTimeout(
        () => reject(new Error('SUBMISSION_SESSION_TIMEOUT')),
        decoded.oauth.timeoutMs,
      );
      sessionTimer.unref();
    });
    session = await Promise.race([
      createBoundTenantSalesforceSession(
        connectionStore,
        {
          tenantId,
          expectedSalesforceOrgId: first.salesforceOrgId,
          authorizationOrigin: first.authorizationOrigin,
          namespacePrefix: first.namespacePrefix,
        },
        decoded.oauth,
        fetchImplementation,
      ),
      sessionDeadline,
    ]);
  } catch {
    const retried = await retryAll(
      store,
      submissions,
      'CONNECTION_RECHECK_FAILED',
      retryAt,
    );
    return Object.freeze({ ...retried, recovered });
  } finally {
    if (sessionTimer !== undefined) clearTimeout(sessionTimer);
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('SUBMISSION_DISPATCH_TIMEOUT'));
    }, decoded.dispatchTimeoutMs);
    timer.unref();
  });
  let delivered: readonly SubmissionDeliveryOutcome[];
  try {
    delivered = await Promise.race([
      deliver(
        Object.freeze({
          session,
          submissions,
          signal: controller.signal,
        }),
      ),
      deadline,
    ]);
  } catch {
    const retried = await retryAll(
      store,
      submissions,
      controller.signal.aborted
        ? 'DISPATCH_TIMEOUT'
        : 'DISPATCH_TRANSPORT_FAILED',
      retryAt,
    );
    return Object.freeze({ ...retried, recovered });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  const decodedOutcomes = outcomes(delivered, submissions);
  if (decodedOutcomes === undefined) {
    const retried = await retryAll(
      store,
      submissions,
      'DISPATCH_RESULT_INVALID',
      retryAt,
    );
    return Object.freeze({ ...retried, recovered });
  }

  let committed = 0;
  let retry = 0;
  let dead = 0;
  try {
    for (const submission of submissions) {
      const outcome = decodedOutcomes.get(submission.relayId)!;
      if (outcome.disposition === 'committed') {
        await store.markCommitted(
          tenantId,
          submission.relayId,
          submission.attempt,
        );
        committed++;
      } else if (outcome.disposition === 'retry') {
        await store.markFailed(
          tenantId,
          submission.relayId,
          submission.attempt,
          'SALESFORCE_RETRYABLE',
          retryAt,
        );
        if (submission.attempt >= 100) dead++;
        else retry++;
      } else {
        await store.markFailed(
          tenantId,
          submission.relayId,
          submission.attempt,
          'SALESFORCE_REFUSED',
        );
        dead++;
      }
    }
  } catch {
    fail('SUBMISSION_DISPATCH_STORAGE');
  }
  return Object.freeze({
    recovered,
    claimed: submissions.length,
    committed,
    retry,
    dead,
  });
}
