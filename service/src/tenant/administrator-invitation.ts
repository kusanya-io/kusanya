/** One-time, tenant-bound invitations for administrator operator enrolment. */
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { types } from 'node:util';
import type { QueryExecutor } from './connection-store.js';
import {
  administratorRole,
  type AdministratorRole,
  type AdministratorSessionConfiguration,
  type IssuedAdministratorSession,
} from './administrator-session.js';

const actorPattern = /^[A-Za-z0-9:_-]{1,128}$/;
const tenantPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const invitationPattern = /^[A-Za-z0-9_-]{43}$/;
const invitationIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type AdministratorInvitationFailureCode =
  | 'ADMINISTRATOR_INVITATION_INPUT'
  | 'ADMINISTRATOR_INVITATION_REJECTED'
  | 'ADMINISTRATOR_INVITATION_STORAGE';

export class AdministratorInvitationError extends Error {
  constructor(readonly code: AdministratorInvitationFailureCode) {
    super(code);
    this.name = 'AdministratorInvitationError';
  }
}

export interface AdministratorInvitationConfiguration {
  readonly ttlSeconds: number;
}

export interface AdministratorInvitationIssueInput {
  readonly performedByActorId: string;
  readonly targetActorId: string;
  readonly tenantId: string;
  readonly role: AdministratorRole;
}

export interface AdministratorInvitationRevocationInput {
  readonly performedByActorId: string;
  readonly invitationId: string;
  readonly tenantId: string;
}

export interface AdministratorInvitationAcceptanceInput {
  readonly actorId: string;
  readonly invitationToken: string;
}

export interface IssuedAdministratorInvitation {
  readonly invitationId: string;
  readonly invitationToken: string;
  readonly expiresInSeconds: number;
}

function fail(code: AdministratorInvitationFailureCode): never {
  throw new AdministratorInvitationError(code);
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail('ADMINISTRATOR_INVITATION_INPUT');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'),
    )
  )
    fail('ADMINISTRATOR_INVITATION_INPUT');
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
}

function exactKeys(value: Record<string, unknown>, expected: string[]): void {
  if (Object.keys(value).sort().join(',') !== expected.sort().join(','))
    fail('ADMINISTRATOR_INVITATION_INPUT');
}

function actorId(value: unknown): string {
  if (typeof value !== 'string' || !actorPattern.test(value))
    fail('ADMINISTRATOR_INVITATION_INPUT');
  return value;
}

function tenantId(value: unknown): string {
  if (typeof value !== 'string' || !tenantPattern.test(value))
    fail('ADMINISTRATOR_INVITATION_INPUT');
  return value;
}

function invitationId(value: unknown): string {
  if (typeof value !== 'string' || !invitationIdPattern.test(value))
    fail('ADMINISTRATOR_INVITATION_INPUT');
  return value;
}

function invitationToken(value: unknown): string {
  if (typeof value !== 'string' || !invitationPattern.test(value))
    fail('ADMINISTRATOR_INVITATION_INPUT');
  return value;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    fail('ADMINISTRATOR_INVITATION_INPUT');
  return value;
}

function issueInput(value: unknown): AdministratorInvitationIssueInput {
  const input = plainRecord(value);
  exactKeys(input, ['performedByActorId', 'role', 'targetActorId', 'tenantId']);
  try {
    return Object.freeze({
      performedByActorId: actorId(input.performedByActorId),
      targetActorId: actorId(input.targetActorId),
      tenantId: tenantId(input.tenantId),
      role: administratorRole(input.role),
    });
  } catch (error) {
    if (error instanceof AdministratorInvitationError) throw error;
    fail('ADMINISTRATOR_INVITATION_INPUT');
  }
}

function revocationInput(
  value: unknown,
): AdministratorInvitationRevocationInput {
  const input = plainRecord(value);
  exactKeys(input, ['invitationId', 'performedByActorId', 'tenantId']);
  return Object.freeze({
    performedByActorId: actorId(input.performedByActorId),
    invitationId: invitationId(input.invitationId),
    tenantId: tenantId(input.tenantId),
  });
}

function acceptanceInput(
  value: unknown,
): AdministratorInvitationAcceptanceInput {
  const input = plainRecord(value);
  exactKeys(input, ['actorId', 'invitationToken']);
  return Object.freeze({
    actorId: actorId(input.actorId),
    invitationToken: invitationToken(input.invitationToken),
  });
}

function invitationConfiguration(
  value: unknown,
): AdministratorInvitationConfiguration {
  const input = plainRecord(value);
  exactKeys(input, ['ttlSeconds']);
  return Object.freeze({ ttlSeconds: integer(input.ttlSeconds, 300, 604_800) });
}

function sessionConfiguration(value: unknown): {
  readonly sessionSecret: Buffer;
  readonly ttlSeconds: number;
} {
  const input = plainRecord(value);
  exactKeys(input, ['sessionSecret', 'ttlSeconds']);
  if (typeof input.sessionSecret !== 'string')
    fail('ADMINISTRATOR_INVITATION_INPUT');
  const secret = Buffer.from(input.sessionSecret, 'base64');
  if (secret.length !== 32 || secret.toString('base64') !== input.sessionSecret)
    fail('ADMINISTRATOR_INVITATION_INPUT');
  return Object.freeze({
    sessionSecret: secret,
    ttlSeconds: integer(input.ttlSeconds, 300, 28_800),
  });
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'ascii').digest('hex');
}

function csrfToken(secret: Buffer, session: string): string {
  return createHmac('sha256', secret)
    .update('kusanya:administrator-session-csrf:v1\0', 'utf8')
    .update(session, 'ascii')
    .digest('base64url');
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    !types.isProxy(error) &&
    Object.getOwnPropertyDescriptor(error, 'code')?.value === '23505'
  );
}

export class AdministratorInvitationStore {
  constructor(private readonly database: QueryExecutor) {}

  /** Issue an opaque invitation without probing whether its subject exists elsewhere. */
  async issue(
    inputValue: AdministratorInvitationIssueInput,
    configurationValue: AdministratorInvitationConfiguration,
  ): Promise<IssuedAdministratorInvitation> {
    const input = issueInput(inputValue);
    const configuration = invitationConfiguration(configurationValue);
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const tokenDigest = digest(token);
    let result;
    try {
      result = await this.database.query(
        `WITH actor_lock AS MATERIALIZED (
           SELECT pg_advisory_xact_lock(
             hashtextextended('actor:' || $2, 0)
           )
         ), tenant_lock AS MATERIALIZED (
           SELECT pg_advisory_xact_lock(
             hashtextextended('tenant:' || $3::text, 0)
           )
           FROM actor_lock
         ), performer AS MATERIALIZED (
           SELECT binding.actor_id, binding.tenant_id
           FROM tenant_lock
           JOIN tenant_administrator_bindings binding
             ON binding.actor_id = $1
            AND binding.tenant_id = $3::uuid
            AND binding.active
            AND binding.role = 'administrator'
           FOR UPDATE OF binding
         ), inserted AS (
           INSERT INTO tenant_administrator_invitations (
             invitation_id, token_digest, tenant_id,
             issued_by_actor_id, target_actor_id, role, expires_at
           )
           SELECT $4::uuid, $5, tenant_id, actor_id, $2, $6,
                  clock_timestamp() + ($7 * interval '1 second')
           FROM performer
           RETURNING invitation_id
         )
         SELECT invitation_id FROM inserted`,
        [
          input.performedByActorId,
          input.targetActorId,
          input.tenantId,
          id,
          tokenDigest,
          input.role,
          configuration.ttlSeconds,
        ],
      );
    } catch {
      fail('ADMINISTRATOR_INVITATION_STORAGE');
    }
    if (result.rowCount === 0 && result.rows.length === 0)
      fail('ADMINISTRATOR_INVITATION_REJECTED');
    if (result.rowCount !== 1 || result.rows.length !== 1)
      fail('ADMINISTRATOR_INVITATION_STORAGE');
    return Object.freeze({
      invitationId: id,
      invitationToken: token,
      expiresInSeconds: configuration.ttlSeconds,
    });
  }

  /** Idempotently revoke a pending invitation without disclosing row existence. */
  async revoke(
    inputValue: AdministratorInvitationRevocationInput,
  ): Promise<void> {
    const input = revocationInput(inputValue);
    let result;
    try {
      result = await this.database.query(
        `WITH invitation AS MATERIALIZED (
           SELECT target_actor_id, tenant_id
           FROM tenant_administrator_invitations
           WHERE invitation_id = $2::uuid
         ), actor_lock AS MATERIALIZED (
           SELECT pg_advisory_xact_lock(
             hashtextextended('actor:' || target_actor_id, 0)
           )
           FROM invitation
         ), tenant_lock AS MATERIALIZED (
           SELECT pg_advisory_xact_lock(
             hashtextextended('tenant:' || invitation.tenant_id::text, 0)
           )
           FROM actor_lock, invitation
         ), performer AS MATERIALIZED (
           SELECT binding.actor_id, binding.tenant_id
           FROM tenant_lock
           JOIN tenant_administrator_bindings binding
             ON binding.actor_id = $1
            AND binding.tenant_id = $3::uuid
            AND binding.active
            AND binding.role = 'administrator'
           FOR UPDATE OF binding
         ), revoked AS (
           UPDATE tenant_administrator_invitations pending
           SET revoked_at = clock_timestamp(), revoked_by_actor_id = $1
           FROM performer
           WHERE pending.invitation_id = $2::uuid
             AND pending.tenant_id = performer.tenant_id
             AND pending.accepted_at IS NULL
             AND pending.revoked_at IS NULL
           RETURNING pending.invitation_id
         )
         SELECT invitation_id FROM revoked`,
        [input.performedByActorId, input.invitationId, input.tenantId],
      );
    } catch {
      fail('ADMINISTRATOR_INVITATION_STORAGE');
    }
    if (result.rows.length > 1 || ![0, 1].includes(result.rowCount ?? -1))
      fail('ADMINISTRATOR_INVITATION_STORAGE');
  }

  /** Consume one invitation and create its binding, audit and session atomically. */
  async accept(
    inputValue: AdministratorInvitationAcceptanceInput,
    configurationValue: AdministratorSessionConfiguration,
  ): Promise<IssuedAdministratorSession> {
    const input = acceptanceInput(inputValue);
    const configuration = sessionConfiguration(configurationValue);
    const tokenDigest = digest(input.invitationToken);
    const opaqueSession = randomBytes(32).toString('base64url');
    const sessionDigest = digest(opaqueSession);
    let result;
    try {
      result = await this.database.query(
        `WITH invitation AS MATERIALIZED (
           SELECT invitation_id, tenant_id, issued_by_actor_id,
                  target_actor_id, role
           FROM tenant_administrator_invitations
           WHERE token_digest = $1
             AND target_actor_id = $2
         ), actor_lock AS MATERIALIZED (
           SELECT pg_advisory_xact_lock(
             hashtextextended('actor:' || target_actor_id, 0)
           )
           FROM invitation
         ), tenant_lock AS MATERIALIZED (
           SELECT pg_advisory_xact_lock(
             hashtextextended('tenant:' || invitation.tenant_id::text, 0)
           )
           FROM actor_lock, invitation
         ), eligible AS MATERIALIZED (
           SELECT pending.invitation_id, pending.tenant_id,
                  pending.target_actor_id, pending.role
           FROM tenant_lock
           JOIN tenant_administrator_invitations pending
             ON pending.token_digest = $1
            AND pending.target_actor_id = $2
            AND pending.accepted_at IS NULL
            AND pending.revoked_at IS NULL
            AND pending.expires_at > clock_timestamp()
           JOIN tenant_administrator_bindings issuer
             ON issuer.actor_id = pending.issued_by_actor_id
            AND issuer.tenant_id = pending.tenant_id
            AND issuer.active
            AND issuer.role = 'administrator'
           WHERE NOT EXISTS (
             SELECT 1 FROM tenant_administrator_bindings
             WHERE actor_id = $2
           )
           FOR UPDATE OF pending, issuer
         ), bound AS (
           INSERT INTO tenant_administrator_bindings (
             actor_id, tenant_id, role
           )
           SELECT target_actor_id, tenant_id, role FROM eligible
           RETURNING actor_id, tenant_id, role
         ), accepted AS (
           UPDATE tenant_administrator_invitations pending
           SET accepted_at = clock_timestamp(), accepted_by_actor_id = $2
           FROM eligible, bound
           WHERE pending.invitation_id = eligible.invitation_id
             AND bound.actor_id = eligible.target_actor_id
           RETURNING pending.invitation_id
         ), audit AS (
           INSERT INTO tenant_administrator_role_audits (
             tenant_id, performed_by_actor_id, target_actor_id,
             action, previous_role, new_role
           )
           SELECT tenant_id, actor_id, actor_id, 'enrol', NULL, role
           FROM bound, accepted
           RETURNING target_actor_id
         ), session AS (
           INSERT INTO administrator_sessions (
             session_digest, actor_id, expires_at
           )
           SELECT $3, target_actor_id,
                  clock_timestamp() + ($4 * interval '1 second')
           FROM audit
           RETURNING session_digest
         )
         SELECT session_digest FROM session`,
        [tokenDigest, input.actorId, sessionDigest, configuration.ttlSeconds],
      );
    } catch (error) {
      if (isUniqueViolation(error)) fail('ADMINISTRATOR_INVITATION_REJECTED');
      fail('ADMINISTRATOR_INVITATION_STORAGE');
    }
    if (result.rowCount === 0 && result.rows.length === 0)
      fail('ADMINISTRATOR_INVITATION_REJECTED');
    if (result.rowCount !== 1 || result.rows.length !== 1)
      fail('ADMINISTRATOR_INVITATION_STORAGE');
    return Object.freeze({
      opaqueSession,
      csrfToken: csrfToken(configuration.sessionSecret, opaqueSession),
      expiresInSeconds: configuration.ttlSeconds,
    });
  }
}
