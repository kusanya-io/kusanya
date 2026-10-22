/** Durable, tenant-scoped record of every administrator publication attempt. */
import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import type { TrustedAdministratorContext } from '../tenant/administrator-session.js';
import { decodeTrustedAdministratorContext } from '../tenant/administrator-session.js';
import type { QueryExecutor } from '../tenant/connection-store.js';

const idPattern = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const versionIdPattern = /^068[A-Za-z0-9]{15}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const failurePattern = /^[A-Z][A-Z0-9_]{0,127}$/;
const attemptIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type PublicationAttemptOutcome = 'succeeded' | 'failed' | 'partial';
export type PublicationReconciliationStatus =
  'indeterminate' | 'committed' | 'unlinked' | 'artifacts_missing';

export type ReconcilablePublicationAttempt =
  | Readonly<{
      outcome: 'started';
      formVersionId: string;
    }>
  | Readonly<{
      outcome: 'partial';
      formVersionId: string;
      publicationDigest: string;
      xformVersionId: string;
      xlsformVersionId: string;
    }>
  | Readonly<{
      outcome: 'reconciled';
      status: PublicationReconciliationStatus;
      requestCount: number;
    }>;

export interface PublicationAttemptCompletion {
  readonly outcome: PublicationAttemptOutcome;
  readonly salesforceRequestCount: number;
  readonly publicationDigest?: string;
  readonly xformVersionId?: string;
  readonly xlsformVersionId?: string;
  readonly failureCode?: string;
}

export class PublicationAttemptError extends Error {
  constructor() {
    super('PUBLICATION_ATTEMPT_STORAGE');
    this.name = 'PublicationAttemptError';
  }
}

function exactCompletion(value: PublicationAttemptCompletion) {
  if (value === null || typeof value !== 'object' || types.isProxy(value))
    throw new PublicationAttemptError();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'),
    )
  )
    throw new PublicationAttemptError();
  const record: Record<string, unknown> = Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
  const count = record.salesforceRequestCount;
  if (!Number.isSafeInteger(count) || (count as number) < 0)
    throw new PublicationAttemptError();
  const outcome = record.outcome;
  if (outcome === 'succeeded') {
    if (
      Object.keys(record).sort().join(',') !==
        ['outcome', 'publicationDigest', 'salesforceRequestCount']
          .sort()
          .join(',') ||
      typeof record.publicationDigest !== 'string' ||
      !digestPattern.test(record.publicationDigest)
    )
      throw new PublicationAttemptError();
  } else if (outcome === 'failed') {
    if (
      Object.keys(record).sort().join(',') !==
        ['failureCode', 'outcome', 'salesforceRequestCount'].sort().join(',') ||
      typeof record.failureCode !== 'string' ||
      !failurePattern.test(record.failureCode)
    )
      throw new PublicationAttemptError();
  } else if (outcome === 'partial') {
    if (
      Object.keys(record).sort().join(',') !==
        [
          'failureCode',
          'outcome',
          'publicationDigest',
          'salesforceRequestCount',
          'xformVersionId',
          'xlsformVersionId',
        ]
          .sort()
          .join(',') ||
      typeof record.failureCode !== 'string' ||
      !failurePattern.test(record.failureCode) ||
      typeof record.publicationDigest !== 'string' ||
      !digestPattern.test(record.publicationDigest) ||
      typeof record.xformVersionId !== 'string' ||
      !versionIdPattern.test(record.xformVersionId) ||
      typeof record.xlsformVersionId !== 'string' ||
      !versionIdPattern.test(record.xlsformVersionId)
    )
      throw new PublicationAttemptError();
  } else throw new PublicationAttemptError();
  return record;
}

export class PublicationAttemptStore {
  constructor(private readonly database: QueryExecutor) {}

  /** Insert before OAuth. Provisioning is rechecked by the INSERT itself. */
  async start(
    contextValue: TrustedAdministratorContext,
    formVersionId: string,
  ): Promise<string> {
    let context: TrustedAdministratorContext;
    try {
      context = decodeTrustedAdministratorContext(contextValue);
      if (!idPattern.test(formVersionId)) throw new Error();
    } catch {
      throw new PublicationAttemptError();
    }
    const attemptId = randomUUID();
    try {
      const result = await this.database.query(
        `INSERT INTO tenant_publication_attempts (
           publication_attempt_id, tenant_id, actor_id,
           salesforce_org_id, form_version_id
         )
         SELECT $1, binding.tenant_id, binding.actor_id,
                tenant.expected_salesforce_org_id, $4
         FROM tenant_administrator_bindings AS binding
         JOIN tenant_administrator_tenants AS tenant
           ON tenant.tenant_id = binding.tenant_id
         WHERE binding.actor_id = $2
           AND binding.tenant_id = $3
           AND tenant.expected_salesforce_org_id = $5
           AND tenant.authorization_origin = $6
           AND tenant.namespace_prefix = $7`,
        [
          attemptId,
          context.actorId,
          context.tenantId,
          formVersionId,
          context.expectedSalesforceOrgId,
          context.authorizationOrigin,
          context.namespacePrefix,
        ],
      );
      if (result.rowCount !== 1) throw new Error();
      return attemptId;
    } catch {
      throw new PublicationAttemptError();
    }
  }

  /** One-way transition. A missing or already terminal row is always refused. */
  async complete(
    attemptId: string,
    tenantId: string,
    completionValue: PublicationAttemptCompletion,
  ): Promise<void> {
    if (
      typeof attemptId !== 'string' ||
      !attemptIdPattern.test(attemptId) ||
      typeof tenantId !== 'string'
    )
      throw new PublicationAttemptError();
    const completion = exactCompletion(completionValue);
    try {
      const result = await this.database.query(
        `UPDATE tenant_publication_attempts
         SET outcome = $3,
             publication_digest = $4,
             xform_version_id = $5,
             xlsform_version_id = $6,
             failure_code = $7,
             salesforce_request_count = $8,
             completed_at = clock_timestamp()
         WHERE publication_attempt_id = $1
           AND tenant_id = $2
           AND outcome = 'started'`,
        [
          attemptId,
          tenantId,
          completion.outcome,
          completion.publicationDigest ?? null,
          completion.xformVersionId ?? null,
          completion.xlsformVersionId ?? null,
          completion.failureCode ?? null,
          completion.salesforceRequestCount,
        ],
      );
      if (result.rowCount !== 1) throw new Error();
    } catch {
      throw new PublicationAttemptError();
    }
  }

  /** Load only unresolved started/partial attempts or their idempotent resolution. */
  async loadReconcilable(
    contextValue: TrustedAdministratorContext,
    attemptId: string,
  ): Promise<ReconcilablePublicationAttempt> {
    let context: TrustedAdministratorContext;
    try {
      context = decodeTrustedAdministratorContext(contextValue);
      if (!attemptIdPattern.test(attemptId)) throw new Error();
    } catch {
      throw new PublicationAttemptError();
    }
    interface AttemptRow {
      outcome: unknown;
      form_version_id: unknown;
      publication_digest: unknown;
      xform_version_id: unknown;
      xlsform_version_id: unknown;
      reconciliation_status: unknown;
      reconciliation_request_count: unknown;
    }
    try {
      const result = await this.database.query<AttemptRow>(
        `SELECT attempt.outcome, attempt.form_version_id,
                trim(attempt.publication_digest) AS publication_digest,
                attempt.xform_version_id, attempt.xlsform_version_id,
                attempt.reconciliation_status,
                attempt.reconciliation_request_count
         FROM tenant_publication_attempts AS attempt
         JOIN tenant_administrator_bindings AS binding
           ON binding.actor_id = $2 AND binding.tenant_id = attempt.tenant_id
         JOIN tenant_administrator_tenants AS tenant
           ON tenant.tenant_id = attempt.tenant_id
         WHERE attempt.publication_attempt_id = $1
           AND attempt.tenant_id = $3
           AND attempt.salesforce_org_id = $4
           AND tenant.expected_salesforce_org_id = $4
           AND tenant.authorization_origin = $5
           AND tenant.namespace_prefix = $6`,
        [
          attemptId,
          context.actorId,
          context.tenantId,
          context.expectedSalesforceOrgId,
          context.authorizationOrigin,
          context.namespacePrefix,
        ],
      );
      if (result.rowCount !== 1 || result.rows.length !== 1) throw new Error();
      const row = result.rows[0]!;
      if (row.reconciliation_status !== null) {
        const status = row.reconciliation_status;
        const requestCount = row.reconciliation_request_count;
        if (
          ![
            'indeterminate',
            'committed',
            'unlinked',
            'artifacts_missing',
          ].includes(status as string) ||
          !Number.isSafeInteger(requestCount) ||
          (status === 'indeterminate'
            ? row.outcome !== 'started' || requestCount !== 0
            : row.outcome !== 'partial' || (requestCount as number) < 1)
        )
          throw new Error();
        return Object.freeze({
          outcome: 'reconciled',
          status: status as PublicationReconciliationStatus,
          requestCount: requestCount as number,
        });
      }
      if (
        typeof row.form_version_id !== 'string' ||
        !idPattern.test(row.form_version_id)
      )
        throw new Error();
      if (row.outcome === 'started') {
        if (
          row.publication_digest !== null ||
          row.xform_version_id !== null ||
          row.xlsform_version_id !== null ||
          row.reconciliation_request_count !== null
        )
          throw new Error();
        return Object.freeze({
          outcome: 'started',
          formVersionId: row.form_version_id,
        });
      }
      if (
        row.outcome !== 'partial' ||
        typeof row.publication_digest !== 'string' ||
        !digestPattern.test(row.publication_digest) ||
        typeof row.xform_version_id !== 'string' ||
        !versionIdPattern.test(row.xform_version_id) ||
        typeof row.xlsform_version_id !== 'string' ||
        !versionIdPattern.test(row.xlsform_version_id) ||
        row.reconciliation_request_count !== null
      )
        throw new Error();
      return Object.freeze({
        outcome: 'partial',
        formVersionId: row.form_version_id,
        publicationDigest: row.publication_digest,
        xformVersionId: row.xform_version_id,
        xlsformVersionId: row.xlsform_version_id,
      });
    } catch {
      throw new PublicationAttemptError();
    }
  }

  /** Resolve once; a racing loser receives the winner's immutable resolution. */
  async resolve(
    contextValue: TrustedAdministratorContext,
    attemptId: string,
    expectedOutcome: 'started' | 'partial',
    status: PublicationReconciliationStatus,
    requestCount: number,
  ): Promise<
    Readonly<{ status: PublicationReconciliationStatus; requestCount: number }>
  > {
    let context: TrustedAdministratorContext;
    try {
      context = decodeTrustedAdministratorContext(contextValue);
      if (
        !attemptIdPattern.test(attemptId) ||
        !Number.isSafeInteger(requestCount) ||
        requestCount < 0 ||
        (expectedOutcome === 'started'
          ? status !== 'indeterminate' || requestCount !== 0
          : !['committed', 'unlinked', 'artifacts_missing'].includes(status) ||
            requestCount < 1)
      )
        throw new Error();
    } catch {
      throw new PublicationAttemptError();
    }
    try {
      const result = await this.database.query(
        `UPDATE tenant_publication_attempts AS attempt
         SET reconciliation_status = $4,
             reconciliation_request_count = $5,
             reconciled_at = clock_timestamp()
         FROM tenant_administrator_bindings AS binding,
              tenant_administrator_tenants AS tenant
         WHERE attempt.publication_attempt_id = $1
           AND attempt.tenant_id = $2
           AND attempt.outcome = $3
           AND attempt.reconciliation_status IS NULL
           AND binding.actor_id = $6
           AND binding.tenant_id = attempt.tenant_id
           AND tenant.tenant_id = attempt.tenant_id
           AND attempt.salesforce_org_id = $7
           AND tenant.expected_salesforce_org_id = $7
           AND tenant.authorization_origin = $8
           AND tenant.namespace_prefix = $9`,
        [
          attemptId,
          context.tenantId,
          expectedOutcome,
          status,
          requestCount,
          context.actorId,
          context.expectedSalesforceOrgId,
          context.authorizationOrigin,
          context.namespacePrefix,
        ],
      );
      if (result.rowCount === 1) return Object.freeze({ status, requestCount });
      if (result.rowCount !== 0) throw new Error();
      const existing = await this.loadReconcilable(context, attemptId);
      if (existing.outcome !== 'reconciled') throw new Error();
      return Object.freeze({
        status: existing.status,
        requestCount: existing.requestCount,
      });
    } catch {
      throw new PublicationAttemptError();
    }
  }
}
