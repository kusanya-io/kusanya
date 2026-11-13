/** Durable, tenant-scoped raw-submission queue; it performs no Salesforce I/O. */
import { createHash, randomUUID } from 'node:crypto';
import { types } from 'node:util';
import type { QueryExecutor } from '../tenant/connection-store.js';
import { normalizeSalesforceOrgId } from '../tenant/connection-store.js';
import { decodeSubmissionXml } from './submission-xml.js';

const tenantIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const salesforceIdPattern = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const failureCodePattern = /^[A-Z][A-Z0-9_]{0,63}$/;

export type SubmissionRelayFailureCode =
  | 'SUBMISSION_RELAY_INPUT'
  | 'SUBMISSION_RELAY_CONFLICT'
  | 'SUBMISSION_RELAY_STATE'
  | 'SUBMISSION_RELAY_STORAGE';

export class SubmissionRelayError extends Error {
  constructor(readonly code: SubmissionRelayFailureCode) {
    super(code);
    this.name = 'SubmissionRelayError';
  }
}

export interface EnqueueSubmissionInput {
  readonly tenantId: string;
  readonly salesforceOrgId: string;
  readonly formVersionId: string;
  readonly channel: 'phone' | 'web';
  readonly rawXml: Uint8Array;
}

export interface EnqueueSubmissionResult {
  readonly relayId: string;
  readonly instanceId: string;
  readonly duplicate: boolean;
  readonly state: 'queued' | 'dispatching' | 'committed' | 'dead';
}

export interface ClaimedSubmission {
  readonly relayId: string;
  readonly tenantId: string;
  readonly salesforceOrgId: string;
  readonly formVersionId: string;
  readonly instanceId: string;
  readonly channel: 'phone' | 'web';
  readonly rawXml: Uint8Array;
  readonly xmlSha256: string;
  readonly attempt: number;
}

interface RelayRow {
  relay_id: unknown;
  tenant_id: unknown;
  salesforce_org_id: unknown;
  form_version_id: unknown;
  instance_id: unknown;
  channel: unknown;
  raw_xml?: unknown;
  xml_sha256: unknown;
  state: unknown;
  attempts: unknown;
}

function fail(code: SubmissionRelayFailureCode): never {
  throw new SubmissionRelayError(code);
}

function storageCode(error: unknown): SubmissionRelayFailureCode {
  if (error === null || typeof error !== 'object' || types.isProxy(error))
    return 'SUBMISSION_RELAY_STORAGE';
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  if (!descriptor || !Object.hasOwn(descriptor, 'value'))
    return 'SUBMISSION_RELAY_STORAGE';
  return descriptor.value === '23505'
    ? 'SUBMISSION_RELAY_CONFLICT'
    : 'SUBMISSION_RELAY_STORAGE';
}

function checkedTenantId(value: unknown): string {
  if (typeof value !== 'string' || !tenantIdPattern.test(value))
    fail('SUBMISSION_RELAY_INPUT');
  return value;
}

function checkedRelayId(value: unknown): string {
  if (typeof value !== 'string' || !tenantIdPattern.test(value))
    fail('SUBMISSION_RELAY_INPUT');
  return value;
}

function salesforceChecksum(id: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
  let suffix = '';
  for (let group = 0; group < 3; group++) {
    let bits = 0;
    for (let index = 0; index < 5; index++) {
      const character = id[group * 5 + index]!;
      if (character >= 'A' && character <= 'Z') bits |= 1 << index;
    }
    suffix += alphabet[bits]!;
  }
  return suffix;
}

function checkedRecordId(value: unknown): string {
  if (typeof value !== 'string' || !salesforceIdPattern.test(value))
    fail('SUBMISSION_RELAY_INPUT');
  const first = value.slice(0, 15);
  const normalized = first + salesforceChecksum(first);
  if (value.length === 18 && value !== normalized)
    fail('SUBMISSION_RELAY_INPUT');
  return normalized;
}

function checkedLimit(value: unknown): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 200
  )
    fail('SUBMISSION_RELAY_INPUT');
  return value as number;
}

function checkedDate(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    fail('SUBMISSION_RELAY_INPUT');
  return new Date(value.getTime());
}

function checkedFailureCode(value: unknown): string {
  if (typeof value !== 'string' || !failureCodePattern.test(value))
    fail('SUBMISSION_RELAY_INPUT');
  return value;
}

function rowString(value: unknown): string {
  if (typeof value !== 'string') fail('SUBMISSION_RELAY_STORAGE');
  return value;
}

function rowNumber(value: unknown): number {
  const number = typeof value === 'string' ? Number(value) : value;
  if (!Number.isInteger(number)) fail('SUBMISSION_RELAY_STORAGE');
  return number as number;
}

function rowState(value: unknown): EnqueueSubmissionResult['state'] {
  if (!['queued', 'dispatching', 'committed', 'dead'].includes(String(value)))
    fail('SUBMISSION_RELAY_STORAGE');
  return value as EnqueueSubmissionResult['state'];
}

function rowChannel(value: unknown): 'phone' | 'web' {
  if (value !== 'phone' && value !== 'web') fail('SUBMISSION_RELAY_STORAGE');
  return value;
}

function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  fail('SUBMISSION_RELAY_STORAGE');
}

export class SubmissionRelayStore {
  constructor(private readonly database: QueryExecutor) {}

  async enqueue(
    value: EnqueueSubmissionInput,
  ): Promise<EnqueueSubmissionResult> {
    if (
      value === null ||
      typeof value !== 'object' ||
      types.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      fail('SUBMISSION_RELAY_INPUT');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Object.keys(descriptors).sort().join(',') !==
        ['channel', 'formVersionId', 'rawXml', 'salesforceOrgId', 'tenantId']
          .sort()
          .join(',') ||
      Object.values(descriptors).some(
        (descriptor) => !Object.hasOwn(descriptor, 'value'),
      )
    )
      fail('SUBMISSION_RELAY_INPUT');
    const tenantId = checkedTenantId(value.tenantId);
    let salesforceOrgId: string;
    try {
      salesforceOrgId = normalizeSalesforceOrgId(value.salesforceOrgId);
    } catch {
      fail('SUBMISSION_RELAY_INPUT');
    }
    const formVersionId = checkedRecordId(value.formVersionId);
    if (value.channel !== 'phone' && value.channel !== 'web')
      fail('SUBMISSION_RELAY_INPUT');
    const identity = decodeSubmissionXml(value.rawXml);
    const digest = createHash('sha256').update(identity.bytes).digest('hex');
    const relayId = randomUUID();
    let inserted;
    try {
      inserted = await this.database.query<RelayRow>(
        `INSERT INTO tenant_submission_relays
           (relay_id, tenant_id, salesforce_org_id, form_version_id,
            form_key, form_version, instance_id, channel, raw_xml,
            xml_sha256, state, attempts)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'queued', 0)
         ON CONFLICT (tenant_id, instance_id) DO NOTHING
         RETURNING relay_id, tenant_id, salesforce_org_id, form_version_id,
                   instance_id, channel, xml_sha256, state, attempts`,
        [
          relayId,
          tenantId,
          salesforceOrgId,
          formVersionId,
          identity.formKey,
          identity.formVersion,
          identity.instanceId,
          value.channel,
          Buffer.from(identity.bytes),
          digest,
        ],
      );
    } catch (error) {
      fail(storageCode(error));
    }
    if (inserted.rowCount === 1 && inserted.rows.length === 1) {
      return Object.freeze({
        relayId: rowString(inserted.rows[0]!.relay_id),
        instanceId: rowString(inserted.rows[0]!.instance_id),
        duplicate: false,
        state: rowState(inserted.rows[0]!.state),
      });
    }
    if (inserted.rowCount !== 0 || inserted.rows.length !== 0)
      fail('SUBMISSION_RELAY_STORAGE');
    let existing;
    try {
      existing = await this.database.query<RelayRow>(
        `SELECT relay_id, tenant_id, salesforce_org_id, form_version_id,
                instance_id, channel, xml_sha256, state, attempts
         FROM tenant_submission_relays
         WHERE tenant_id = $1 AND instance_id = $2`,
        [tenantId, identity.instanceId],
      );
    } catch (error) {
      fail(storageCode(error));
    }
    if (existing.rowCount !== 1 || existing.rows.length !== 1)
      fail('SUBMISSION_RELAY_STORAGE');
    const row = existing.rows[0]!;
    if (
      rowString(row.salesforce_org_id).trim() !== salesforceOrgId ||
      rowString(row.form_version_id).trim() !== formVersionId ||
      rowString(row.channel) !== value.channel ||
      rowString(row.xml_sha256).trim() !== digest
    )
      fail('SUBMISSION_RELAY_CONFLICT');
    return Object.freeze({
      relayId: rowString(row.relay_id),
      instanceId: rowString(row.instance_id),
      duplicate: true,
      state: rowState(row.state),
    });
  }

  async claimBatch(
    tenantIdValue: string,
    limitValue: number,
    nowValue: Date,
  ): Promise<readonly ClaimedSubmission[]> {
    const tenantId = checkedTenantId(tenantIdValue);
    const limit = checkedLimit(limitValue);
    const now = checkedDate(nowValue);
    let result;
    try {
      result = await this.database.query<RelayRow>(
        `WITH candidates AS (
           SELECT relay.relay_id
           FROM tenant_submission_relays AS relay
           JOIN tenant_administrator_tenants AS tenant
             ON tenant.tenant_id = relay.tenant_id
            AND tenant.expected_salesforce_org_id = relay.salesforce_org_id
            AND tenant.salesforce_connection_state = 'connected'
           JOIN tenant_connections AS connection
             ON connection.tenant_id = tenant.tenant_id
            AND connection.salesforce_org_id = tenant.expected_salesforce_org_id
            AND connection.authorization_origin = tenant.authorization_origin
            AND connection.namespace_prefix = tenant.namespace_prefix
           WHERE relay.tenant_id = $1 AND relay.state = 'queued'
             AND (relay.next_attempt_at IS NULL OR relay.next_attempt_at <= $2)
           ORDER BY relay.received_at, relay.relay_id
           FOR UPDATE SKIP LOCKED
           LIMIT $3
         )
         UPDATE tenant_submission_relays AS relay
         SET state = 'dispatching', attempts = relay.attempts + 1,
             failure_code = NULL, next_attempt_at = NULL,
             updated_at = clock_timestamp()
         FROM candidates
         WHERE relay.relay_id = candidates.relay_id
         RETURNING relay.relay_id, relay.tenant_id,
                   relay.salesforce_org_id, relay.form_version_id,
                   relay.instance_id, relay.channel, relay.raw_xml,
                   relay.xml_sha256, relay.state, relay.attempts`,
        [tenantId, now, limit],
      );
    } catch (error) {
      fail(storageCode(error));
    }
    if (result.rowCount !== result.rows.length)
      fail('SUBMISSION_RELAY_STORAGE');
    return Object.freeze(
      result.rows.map((row) => {
        const raw = bytes(row.raw_xml);
        const digest = createHash('sha256').update(raw).digest('hex');
        if (digest !== rowString(row.xml_sha256).trim())
          fail('SUBMISSION_RELAY_STORAGE');
        return Object.freeze({
          relayId: rowString(row.relay_id),
          tenantId: rowString(row.tenant_id),
          salesforceOrgId: rowString(row.salesforce_org_id).trim(),
          formVersionId: rowString(row.form_version_id).trim(),
          instanceId: rowString(row.instance_id),
          channel: rowChannel(row.channel),
          rawXml: new Uint8Array(raw),
          xmlSha256: digest,
          attempt: rowNumber(row.attempts),
        });
      }),
    );
  }

  async markCommitted(tenantIdValue: string, relayId: string): Promise<void> {
    await this.transition(
      `UPDATE tenant_submission_relays
       SET state = 'committed', acknowledged_at = clock_timestamp(),
           failure_code = NULL, next_attempt_at = NULL
       WHERE tenant_id = $1 AND relay_id = $2 AND state = 'dispatching'`,
      [checkedTenantId(tenantIdValue), checkedRelayId(relayId)],
    );
  }

  async markFailed(
    tenantIdValue: string,
    relayIdValue: string,
    failureCodeValue: string,
    retryAt?: Date,
  ): Promise<void> {
    const tenantId = checkedTenantId(tenantIdValue);
    const relayId = checkedRelayId(relayIdValue);
    const failureCode = checkedFailureCode(failureCodeValue);
    if (retryAt === undefined) {
      await this.transition(
        `UPDATE tenant_submission_relays
         SET state = 'dead', failure_code = $3, next_attempt_at = NULL
         WHERE tenant_id = $1 AND relay_id = $2 AND state = 'dispatching'`,
        [tenantId, relayId, failureCode],
      );
      return;
    }
    const next = checkedDate(retryAt);
    await this.transition(
      `UPDATE tenant_submission_relays
       SET state = 'queued', failure_code = NULL, next_attempt_at = $3
       WHERE tenant_id = $1 AND relay_id = $2 AND state = 'dispatching'`,
      [tenantId, relayId, next],
    );
  }

  private async transition(text: string, values: unknown[]): Promise<void> {
    try {
      const result = await this.database.query(text, values);
      if (result.rowCount !== 1 || result.rows.length !== 0)
        fail('SUBMISSION_RELAY_STATE');
    } catch (error) {
      if (error instanceof SubmissionRelayError) throw error;
      fail(storageCode(error));
    }
  }
}
