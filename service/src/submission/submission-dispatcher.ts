/** Bounded relay orchestration with credential-time tenant revalidation. */
import { createHash } from 'node:crypto';
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
    leaseTimeoutMs: number,
    limit: number,
  ): Promise<readonly string[]>;
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
  /** Unique relays recovered or claimed during this run. */
  readonly touched: number;
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

function emptyRun(recoveredIds: readonly string[]): SubmissionDispatchRun {
  return Object.freeze({
    recovered: recoveredIds.length,
    claimed: 0,
    touched: new Set(recoveredIds).size,
    committed: 0,
    retry: 0,
    dead: 0,
  });
}

function checkedSalesforceOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2_048)
    fail('SUBMISSION_DISPATCH_STORAGE');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail('SUBMISSION_DISPATCH_STORAGE');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.origin !== value ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    !parsed.hostname.endsWith('.salesforce.com')
  )
    fail('SUBMISSION_DISPATCH_STORAGE');
  return parsed.origin;
}

function claimSnapshot(
  value: unknown,
  tenantId: string,
  limit: number,
): readonly ClaimedSubmission[] {
  if (
    !Array.isArray(value) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > limit
  )
    fail('SUBMISSION_DISPATCH_STORAGE');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.keys(descriptors).some(
      (key) =>
        key !== 'length' &&
        (!/^\d+$/.test(key) || !Object.hasOwn(descriptors[key]!, 'value')),
    ) ||
    Object.keys(descriptors).length !== value.length + 1
  )
    fail('SUBMISSION_DISPATCH_STORAGE');
  const ids = new Set<string>();
  const rows = [] as ClaimedSubmission[];
  for (let index = 0; index < value.length; index++) {
    let record: Record<string, unknown>;
    try {
      record = plainRecord(descriptors[String(index)]!.value);
    } catch {
      fail('SUBMISSION_DISPATCH_STORAGE');
    }
    const expectedKeys = [
      'attempt',
      'authorizationOrigin',
      'channel',
      'formVersionId',
      'instanceId',
      'namespacePrefix',
      'rawXml',
      'relayId',
      'salesforceOrgId',
      'tenantId',
      'xmlSha256',
    ];
    if (Object.keys(record).sort().join(',') !== expectedKeys.join(','))
      fail('SUBMISSION_DISPATCH_STORAGE');
    if (
      typeof record.relayId !== 'string' ||
      !tenantIdPattern.test(record.relayId) ||
      ids.has(record.relayId) ||
      record.tenantId !== tenantId ||
      typeof record.salesforceOrgId !== 'string' ||
      !/^00D[A-Za-z0-9]{15}$/.test(record.salesforceOrgId) ||
      typeof record.namespacePrefix !== 'string' ||
      !/^(?:|[a-z][a-z0-9]{0,14}__)$/.test(record.namespacePrefix) ||
      typeof record.formVersionId !== 'string' ||
      !/^[A-Za-z0-9]{18}$/.test(record.formVersionId) ||
      typeof record.instanceId !== 'string' ||
      !/^uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        record.instanceId,
      ) ||
      (record.channel !== 'phone' && record.channel !== 'web') ||
      !(record.rawXml instanceof Uint8Array) ||
      types.isProxy(record.rawXml) ||
      record.rawXml.byteLength < 1 ||
      record.rawXml.byteLength > 750_000 ||
      typeof record.xmlSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(record.xmlSha256) ||
      !Number.isInteger(record.attempt) ||
      (record.attempt as number) < 1 ||
      (record.attempt as number) > 100
    )
      fail('SUBMISSION_DISPATCH_STORAGE');
    const rawXml = new Uint8Array(record.rawXml);
    if (createHash('sha256').update(rawXml).digest('hex') !== record.xmlSha256)
      fail('SUBMISSION_DISPATCH_STORAGE');
    ids.add(record.relayId);
    rows.push(
      Object.freeze({
        relayId: record.relayId,
        tenantId,
        salesforceOrgId: record.salesforceOrgId,
        authorizationOrigin: checkedSalesforceOrigin(
          record.authorizationOrigin,
        ),
        namespacePrefix: record.namespacePrefix,
        formVersionId: record.formVersionId,
        instanceId: record.instanceId,
        channel: record.channel,
        rawXml,
        xmlSha256: record.xmlSha256,
        attempt: record.attempt as number,
      }),
    );
  }
  return Object.freeze(rows);
}

function touchedCount(
  recoveredIds: readonly string[],
  submissions: readonly ClaimedSubmission[],
): number {
  return new Set([
    ...recoveredIds,
    ...submissions.map((submission) => submission.relayId),
  ]).size;
}

function recoveredSnapshot(value: unknown, limit: number): readonly string[] {
  if (
    !Array.isArray(value) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > limit
  )
    fail('SUBMISSION_DISPATCH_STORAGE');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.keys(descriptors).some(
      (key) =>
        key !== 'length' &&
        (!/^\d+$/.test(key) || !Object.hasOwn(descriptors[key]!, 'value')),
    ) ||
    Object.keys(descriptors).length !== value.length + 1
  )
    fail('SUBMISSION_DISPATCH_STORAGE');
  const ids = [] as string[];
  for (let index = 0; index < value.length; index++) {
    const relayId = descriptors[String(index)]!.value as unknown;
    if (
      typeof relayId !== 'string' ||
      !tenantIdPattern.test(relayId) ||
      ids.includes(relayId)
    )
      fail('SUBMISSION_DISPATCH_STORAGE');
    ids.push(relayId);
  }
  return Object.freeze(ids);
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
    touched: submissions.length,
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
  const retryAt = new Date(now.getTime() + decoded.retryDelayMs);
  let recoveredIds: readonly string[];
  let submissions: readonly ClaimedSubmission[];
  try {
    recoveredIds = recoveredSnapshot(
      await store.recoverStale(
        tenantId,
        decoded.leaseTimeoutMs,
        decoded.batchLimit,
      ),
      decoded.batchLimit,
    );
    submissions = claimSnapshot(
      await store.claimBatch(tenantId, decoded.batchLimit, now),
      tenantId,
      decoded.batchLimit,
    );
  } catch {
    fail('SUBMISSION_DISPATCH_STORAGE');
  }
  if (submissions.length === 0) return emptyRun(recoveredIds);
  const touched = touchedCount(recoveredIds, submissions);

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
  const sessionController = new AbortController();
  try {
    const sessionDeadline = new Promise<never>((_, reject) => {
      sessionTimer = setTimeout(() => {
        sessionController.abort();
        reject(new Error('SUBMISSION_SESSION_TIMEOUT'));
      }, decoded.oauth.timeoutMs);
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
        sessionController.signal,
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
    return Object.freeze({
      ...retried,
      recovered: recoveredIds.length,
      touched,
    });
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
    return Object.freeze({
      ...retried,
      recovered: recoveredIds.length,
      touched,
    });
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
    return Object.freeze({
      ...retried,
      recovered: recoveredIds.length,
      touched,
    });
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
    recovered: recoveredIds.length,
    claimed: submissions.length,
    touched,
    committed,
    retry,
    dead,
  });
}
