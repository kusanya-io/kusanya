/** Bounded cross-tenant reconciliation and retention for the service scheduler. */
import { types } from 'node:util';
import { createSalesforceNames } from '../salesforce-names.js';
import {
  normalizeSalesforceOrgId,
  type QueryExecutor,
} from '../tenant/connection-store.js';
import {
  createBoundTenantSalesforceSession,
  type TenantConnectionSessionStore,
} from '../tenant/salesforce-session.js';
import type { TenantSalesforcePublisherConfiguration } from './tenant-salesforce-publisher.js';
import {
  inspectSalesforcePublication,
  type SalesforcePublicationInspectionResult,
} from './salesforce-publication-inspector.js';

const tenantIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const attemptIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const recordIdPattern = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const versionIdPattern = /^068[A-Za-z0-9]{15}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const maintenanceLockClass = 1_261_975_665;
const maintenanceLockObject = 1_836_013_421;
type SalesforcePublicationInspectionStatus = Extract<
  SalesforcePublicationInspectionResult,
  { ok: true }
>['status'];

export type PublicationMaintenanceCandidate = Readonly<{
  attemptId: string;
  tenantId: string;
  expectedSalesforceOrgId: string;
  authorizationOrigin: string;
  namespacePrefix: string;
  outcome: 'started' | 'partial';
  formVersionId: string;
  publicationDigest: string | null;
  xformVersionId: string | null;
  xlsformVersionId: string | null;
}>;

export interface PublicationMaintenanceConfiguration {
  readonly intervalMs: number;
  readonly staleAfterMs: number;
  readonly runTimeoutMs: number;
  readonly maxAttempts: number;
  readonly publisher: TenantSalesforcePublisherConfiguration;
}

export interface PublicationMaintenanceResult {
  readonly acquired: boolean;
  readonly selected: number;
  readonly reconciled: number;
  readonly indeterminate: number;
  readonly failed: number;
  readonly deferred: number;
  readonly retained: number;
}

interface CandidateRow {
  publication_attempt_id: unknown;
  tenant_id: unknown;
  expected_salesforce_org_id: unknown;
  authorization_origin: unknown;
  namespace_prefix: unknown;
  outcome: unknown;
  form_version_id: unknown;
  publication_digest: unknown;
  xform_version_id: unknown;
  xlsform_version_id: unknown;
}

function exactConfiguration(value: PublicationMaintenanceConfiguration) {
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = [
    'intervalMs',
    'maxAttempts',
    'publisher',
    'runTimeoutMs',
    'staleAfterMs',
  ];
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'),
    ) ||
    Object.keys(descriptors).sort().join(',') !== keys.join(',')
  )
    throw new Error();
  if (
    !Number.isSafeInteger(value.intervalMs) ||
    value.intervalMs < 60_000 ||
    value.intervalMs > 86_400_000 ||
    !Number.isSafeInteger(value.staleAfterMs) ||
    value.staleAfterMs < 300_000 ||
    value.staleAfterMs > 604_800_000 ||
    !Number.isSafeInteger(value.runTimeoutMs) ||
    value.runTimeoutMs < 1_000 ||
    value.runTimeoutMs > 900_000 ||
    !Number.isSafeInteger(value.maxAttempts) ||
    value.maxAttempts < 1 ||
    value.maxAttempts > 100 ||
    value.publisher === null ||
    typeof value.publisher !== 'object' ||
    types.isProxy(value.publisher) ||
    Object.getPrototypeOf(value.publisher) !== Object.prototype
  )
    throw new Error();
  const publisherDescriptors = Object.getOwnPropertyDescriptors(
    value.publisher,
  );
  const publisherKeys = [
    'clientId',
    'clientSecret',
    'overallTimeoutMs',
    'perRequestTimeoutMs',
    'refreshTimeoutMs',
  ];
  if (
    Reflect.ownKeys(publisherDescriptors).some(
      (key) =>
        typeof key !== 'string' ||
        !Object.hasOwn(publisherDescriptors[key]!, 'value'),
    ) ||
    Object.keys(publisherDescriptors).sort().join(',') !==
      publisherKeys.join(',') ||
    typeof value.publisher.clientId !== 'string' ||
    value.publisher.clientId.length < 1 ||
    value.publisher.clientId.length > 512 ||
    !/^[\x21-\x7e]+$/.test(value.publisher.clientId) ||
    typeof value.publisher.clientSecret !== 'string' ||
    value.publisher.clientSecret.length < 1 ||
    value.publisher.clientSecret.length > 2_048 ||
    !/^[\x21-\x7e]+$/.test(value.publisher.clientSecret) ||
    !Number.isSafeInteger(value.publisher.refreshTimeoutMs) ||
    value.publisher.refreshTimeoutMs < 1 ||
    value.publisher.refreshTimeoutMs > 30_000 ||
    !Number.isSafeInteger(value.publisher.perRequestTimeoutMs) ||
    value.publisher.perRequestTimeoutMs < 1 ||
    value.publisher.perRequestTimeoutMs > 30_000 ||
    !Number.isSafeInteger(value.publisher.overallTimeoutMs) ||
    value.publisher.overallTimeoutMs < value.publisher.perRequestTimeoutMs ||
    value.publisher.overallTimeoutMs > 120_000
  )
    throw new Error();
  return Object.freeze({
    intervalMs: value.intervalMs,
    staleAfterMs: value.staleAfterMs,
    runTimeoutMs: value.runTimeoutMs,
    maxAttempts: value.maxAttempts,
    publisher: Object.freeze({ ...value.publisher }),
  });
}

function candidate(row: CandidateRow): PublicationMaintenanceCandidate {
  if (
    typeof row.publication_attempt_id !== 'string' ||
    !attemptIdPattern.test(row.publication_attempt_id) ||
    typeof row.tenant_id !== 'string' ||
    !tenantIdPattern.test(row.tenant_id) ||
    typeof row.expected_salesforce_org_id !== 'string' ||
    normalizeSalesforceOrgId(row.expected_salesforce_org_id) !==
      row.expected_salesforce_org_id ||
    typeof row.authorization_origin !== 'string' ||
    typeof row.namespace_prefix !== 'string' ||
    typeof row.form_version_id !== 'string' ||
    !recordIdPattern.test(row.form_version_id) ||
    !['started', 'partial'].includes(row.outcome as string)
  )
    throw new Error();
  const origin = new URL(row.authorization_origin);
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== row.authorization_origin ||
    !origin.hostname.endsWith('.salesforce.com')
  )
    throw new Error();
  createSalesforceNames(row.namespace_prefix);
  const partial = row.outcome === 'partial';
  if (
    partial !==
      (typeof row.publication_digest === 'string' &&
        digestPattern.test(row.publication_digest) &&
        typeof row.xform_version_id === 'string' &&
        versionIdPattern.test(row.xform_version_id) &&
        typeof row.xlsform_version_id === 'string' &&
        versionIdPattern.test(row.xlsform_version_id)) ||
    (!partial &&
      (row.publication_digest !== null ||
        row.xform_version_id !== null ||
        row.xlsform_version_id !== null))
  )
    throw new Error();
  return Object.freeze({
    attemptId: row.publication_attempt_id,
    tenantId: row.tenant_id,
    expectedSalesforceOrgId: row.expected_salesforce_org_id,
    authorizationOrigin: row.authorization_origin,
    namespacePrefix: row.namespace_prefix,
    outcome: row.outcome as 'started' | 'partial',
    formVersionId: row.form_version_id,
    publicationDigest: row.publication_digest as string | null,
    xformVersionId: row.xform_version_id as string | null,
    xlsformVersionId: row.xlsform_version_id as string | null,
  });
}

export class PublicationMaintenanceStore {
  constructor(private readonly database: QueryExecutor) {}

  async withExclusiveRun<Value>(
    operation: () => Promise<Value>,
  ): Promise<
    Readonly<{ acquired: false }> | Readonly<{ acquired: true; value: Value }>
  > {
    if (typeof this.database.connect !== 'function') throw new Error();
    const lock = await this.database.connect.call(this.database);
    let acquired = false;
    let value: Value | undefined;
    let failure: unknown;
    try {
      const result = await lock.query<{ acquired: unknown }>(
        `SELECT pg_try_advisory_lock($1, $2) AS acquired`,
        [maintenanceLockClass, maintenanceLockObject],
      );
      if (result.rowCount !== 1 || result.rows.length !== 1) throw new Error();
      if (result.rows[0]!.acquired === true) {
        acquired = true;
        value = await operation();
      } else if (result.rows[0]!.acquired !== false) throw new Error();
    } catch (error) {
      failure = error;
    }
    try {
      if (acquired) {
        const released = await lock.query<{ released: unknown }>(
          `SELECT pg_advisory_unlock($1, $2) AS released`,
          [maintenanceLockClass, maintenanceLockObject],
        );
        if (
          released.rowCount !== 1 ||
          released.rows.length !== 1 ||
          released.rows[0]!.released !== true
        )
          throw new Error();
      }
    } catch (error) {
      failure ??= error;
    } finally {
      lock.release();
    }
    if (failure !== undefined)
      throw failure instanceof Error ? failure : new Error();
    return acquired
      ? Object.freeze({ acquired: true, value: value as Value })
      : Object.freeze({ acquired: false });
  }

  async listCandidates(
    staleAfterMs: number,
    maximum: number,
  ): Promise<readonly PublicationMaintenanceCandidate[]> {
    if (
      !Number.isSafeInteger(staleAfterMs) ||
      staleAfterMs < 300_000 ||
      staleAfterMs > 604_800_000 ||
      !Number.isSafeInteger(maximum) ||
      maximum < 1 ||
      maximum > 100
    )
      throw new Error();
    const result = await this.database.query<CandidateRow>(
      `SELECT attempt.publication_attempt_id::text, attempt.tenant_id::text,
              tenant.expected_salesforce_org_id,
              tenant.authorization_origin, tenant.namespace_prefix,
              attempt.outcome, attempt.form_version_id,
              trim(attempt.publication_digest) AS publication_digest,
              attempt.xform_version_id, attempt.xlsform_version_id
       FROM tenant_publication_attempts AS attempt
       JOIN tenant_administrator_tenants AS tenant
         ON tenant.tenant_id = attempt.tenant_id
       WHERE attempt.reconciliation_status IS NULL
         AND (
           (attempt.outcome = 'started'
             AND attempt.created_at <= clock_timestamp()
               - ($1::bigint * interval '1 millisecond'))
           OR
           (attempt.outcome = 'partial'
             AND attempt.completed_at <= clock_timestamp()
               - ($1::bigint * interval '1 millisecond'))
         )
       ORDER BY COALESCE(attempt.completed_at, attempt.created_at),
                attempt.publication_attempt_id
       LIMIT $2`,
      [staleAfterMs, maximum],
    );
    if (result.rowCount !== result.rows.length || result.rows.length > maximum)
      throw new Error();
    return Object.freeze(result.rows.map(candidate));
  }

  async resolve(
    selected: PublicationMaintenanceCandidate,
    status: SalesforcePublicationInspectionStatus | 'indeterminate',
    requestCount: number,
  ): Promise<void> {
    if (
      !Number.isSafeInteger(requestCount) ||
      requestCount < 0 ||
      (selected.outcome === 'started'
        ? status !== 'indeterminate' || requestCount !== 0
        : status === 'indeterminate' || requestCount < 1)
    )
      throw new Error();
    const result = await this.database.query(
      `UPDATE tenant_publication_attempts
       SET reconciliation_status = $3,
           reconciliation_request_count = $4,
           reconciled_at = clock_timestamp()
       WHERE publication_attempt_id = $1
         AND tenant_id = $2
         AND outcome = $5
         AND salesforce_org_id = $6
         AND reconciliation_status IS NULL`,
      [
        selected.attemptId,
        selected.tenantId,
        status,
        requestCount,
        selected.outcome,
        selected.expectedSalesforceOrgId,
      ],
    );
    if (result.rowCount !== 1) throw new Error();
  }

  async applyScheduledRetention(maximum = 100): Promise<number> {
    if (
      !Number.isSafeInteger(maximum) ||
      maximum < 1 ||
      maximum > 100 ||
      typeof this.database.connect !== 'function'
    )
      throw new Error();
    const client = await this.database.connect.call(this.database);
    let transaction = false;
    try {
      await client.query('BEGIN');
      transaction = true;
      const actor = await client.query(
        `SELECT set_config(
           'kusanya.publication_retention_actor', '', true
         )`,
      );
      const mode = await client.query(
        `SELECT set_config(
           'kusanya.publication_retention_mode', 'scheduled', true
         )`,
      );
      if (
        actor.rowCount !== 1 ||
        actor.rows.length !== 1 ||
        mode.rowCount !== 1 ||
        mode.rows.length !== 1
      )
        throw new Error();
      const result = await client.query<{ deleted_count: unknown }>(
        `WITH candidates AS (
           SELECT attempt.publication_attempt_id
           FROM tenant_publication_attempts AS attempt
           JOIN tenant_administrator_tenants AS tenant
             ON tenant.tenant_id = attempt.tenant_id
           WHERE COALESCE(attempt.reconciled_at, attempt.completed_at)
               <= clock_timestamp()
                 - (tenant.publication_attempt_retention_days
                   * interval '1 day')
             AND (
               (attempt.outcome IN ('succeeded', 'failed')
                 AND attempt.reconciliation_status IS NULL)
               OR
               (attempt.outcome = 'partial'
                 AND attempt.reconciliation_status IN (
                   'committed', 'artifacts_missing'
                 ))
             )
             AND NOT EXISTS (
               SELECT 1
               FROM tenant_publication_attempts AS retry
               WHERE retry.retry_of_publication_attempt_id =
                 attempt.publication_attempt_id
             )
           ORDER BY COALESCE(
                      attempt.reconciled_at, attempt.completed_at
                    ), attempt.publication_attempt_id
           LIMIT $1
           FOR UPDATE OF attempt
         ), deleted AS (
           DELETE FROM tenant_publication_attempts AS attempt
           USING candidates
           WHERE attempt.publication_attempt_id =
             candidates.publication_attempt_id
           RETURNING attempt.publication_attempt_id
         )
         SELECT count(*)::integer AS deleted_count FROM deleted`,
        [maximum],
      );
      if (result.rowCount !== 1 || result.rows.length !== 1) throw new Error();
      const count = result.rows[0]!.deleted_count;
      if (
        !Number.isSafeInteger(count) ||
        (count as number) < 0 ||
        (count as number) > maximum
      )
        throw new Error();
      await client.query('COMMIT');
      transaction = false;
      return count as number;
    } catch {
      if (transaction) await client.query('ROLLBACK').catch(() => undefined);
      throw new Error('PUBLICATION_MAINTENANCE_FAILED');
    } finally {
      client.release();
    }
  }
}

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Run one globally serialized maintenance pass without retrying publication. */
export async function runPublicationMaintenance(
  store: PublicationMaintenanceStore,
  connectionStore: TenantConnectionSessionStore,
  configurationValue: PublicationMaintenanceConfiguration,
  fetchImplementation: FetchImplementation = fetch,
): Promise<PublicationMaintenanceResult> {
  const configuration = exactConfiguration(configurationValue);
  if (typeof fetchImplementation !== 'function') throw new Error();
  const locked = await store.withExclusiveRun(async () => {
    const deadline = performance.now() + configuration.runTimeoutMs;
    const candidates = await store.listCandidates(
      configuration.staleAfterMs,
      configuration.maxAttempts,
    );
    let reconciled = 0;
    let indeterminate = 0;
    let failed = 0;
    let processed = 0;
    for (const selected of candidates) {
      if (performance.now() >= deadline) break;
      processed += 1;
      try {
        if (selected.outcome === 'started') {
          await store.resolve(selected, 'indeterminate', 0);
          indeterminate += 1;
          continue;
        }
        const remainingBeforeSession = Math.ceil(deadline - performance.now());
        if (remainingBeforeSession < 1) throw new Error();
        const session = await createBoundTenantSalesforceSession(
          connectionStore,
          {
            tenantId: selected.tenantId,
            expectedSalesforceOrgId: selected.expectedSalesforceOrgId,
            authorizationOrigin: selected.authorizationOrigin,
            namespacePrefix: selected.namespacePrefix,
          },
          {
            clientId: configuration.publisher.clientId,
            clientSecret: configuration.publisher.clientSecret,
            timeoutMs: Math.min(
              configuration.publisher.refreshTimeoutMs,
              remainingBeforeSession,
            ),
          },
          fetchImplementation,
        );
        const remaining = Math.ceil(deadline - performance.now());
        if (remaining < 1) throw new Error();
        const inspected = await inspectSalesforcePublication(
          session,
          {
            formVersionId: selected.formVersionId,
            publicationDigest: selected.publicationDigest!,
            xformVersionId: selected.xformVersionId!,
            xlsformVersionId: selected.xlsformVersionId!,
          },
          Math.min(configuration.publisher.perRequestTimeoutMs, remaining),
          Math.min(configuration.publisher.overallTimeoutMs, remaining),
          fetchImplementation,
        );
        if (!inspected.ok) throw new Error();
        await store.resolve(selected, inspected.status, inspected.requestCount);
        reconciled += 1;
      } catch {
        failed += 1;
      }
    }
    const retained = await store.applyScheduledRetention();
    return Object.freeze({
      acquired: true,
      selected: candidates.length,
      reconciled,
      indeterminate,
      failed,
      deferred: candidates.length - processed,
      retained,
    });
  });
  return locked.acquired
    ? locked.value
    : Object.freeze({
        acquired: false,
        selected: 0,
        reconciled: 0,
        indeterminate: 0,
        failed: 0,
        deferred: 0,
        retained: 0,
      });
}

export interface PublicationMaintenanceScheduler {
  runNow(): Promise<PublicationMaintenanceResult | undefined>;
  stop(): Promise<void>;
}

/** Start one local timer; the database advisory lock serializes all replicas. */
export function startPublicationMaintenanceScheduler(
  intervalMs: number,
  run: () => Promise<PublicationMaintenanceResult>,
  onFailure: () => void,
): PublicationMaintenanceScheduler {
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 60_000 ||
    intervalMs > 86_400_000 ||
    typeof run !== 'function' ||
    typeof onFailure !== 'function'
  )
    throw new Error();
  let stopped = false;
  let active: Promise<PublicationMaintenanceResult | undefined> | undefined;
  const runNow = async (): Promise<
    PublicationMaintenanceResult | undefined
  > => {
    if (stopped || active !== undefined) return undefined;
    active = run()
      .then((result) => {
        if (result.failed > 0 || result.deferred > 0) onFailure();
        return result;
      })
      .catch(() => {
        onFailure();
        return undefined;
      })
      .finally(() => {
        active = undefined;
      });
    return await active;
  };
  const timer = setInterval(() => void runNow(), intervalMs);
  timer.unref();
  return Object.freeze({
    runNow,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await active;
    },
  });
}
