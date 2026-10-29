/** Opaque, revocable administrator sessions bound to immutable tenant provisioning. */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { types } from 'node:util';
import {
  normalizeSalesforceOrgId,
  type QueryExecutor,
} from './connection-store.js';
import { isAdministratorSessionValue } from './administrator-cookie.js';

const actorPattern = /^[A-Za-z0-9:_-]{1,128}$/;
const tenantPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const csrfPattern = /^[A-Za-z0-9_-]{43}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const administratorNamespacePattern = /^(?:|[a-z][a-z0-9]{0,14}__)$/;

export const administratorRoles = Object.freeze([
  'administrator',
  'publisher',
  'reviewer',
] as const);
export type AdministratorRole = (typeof administratorRoles)[number];

export type AdministratorSessionFailureCode =
  | 'ADMINISTRATOR_SESSION_INPUT'
  | 'ADMINISTRATOR_SESSION_CONFLICT'
  | 'ADMINISTRATOR_SESSION_ABSENT'
  | 'ADMINISTRATOR_SESSION_STORAGE';

export class AdministratorSessionError extends Error {
  constructor(readonly code: AdministratorSessionFailureCode) {
    super(code);
    this.name = 'AdministratorSessionError';
  }
}

export interface AdministratorBindingInput {
  /** Internal stable actor identifier produced by a future trusted identity mapper. */
  readonly actorId: string;
  readonly tenantId: string;
  readonly expectedSalesforceOrgId: string;
  readonly authorizationOrigin: string;
  readonly namespacePrefix: string;
}

export interface AdministratorProvisioningInput extends AdministratorBindingInput {
  readonly performedByActorId: string;
  readonly role: AdministratorRole;
}

export interface AdministratorDeprovisioningInput {
  readonly performedByActorId: string;
  readonly targetActorId: string;
  readonly tenantId: string;
}

export interface AdministratorRoleChangeInput {
  readonly performedByActorId: string;
  readonly targetActorId: string;
  readonly tenantId: string;
  readonly role: AdministratorRole;
}

export interface AdministratorSessionConfiguration {
  /** Canonical base64 for exactly 32 deployment-secret bytes. */
  readonly sessionSecret: string;
  readonly ttlSeconds: number;
}

export interface IssuedAdministratorSession {
  readonly opaqueSession: string;
  readonly csrfToken: string;
  readonly expiresInSeconds: number;
}

export interface TrustedAdministratorContext {
  readonly actorId: string;
  readonly tenantId: string;
  readonly expectedSalesforceOrgId: string;
  readonly authorizationOrigin: string;
  readonly namespacePrefix: string;
  readonly role: AdministratorRole;
  readonly csrfToken: string;
}

interface DecodedBinding {
  actorId: string;
  tenantId: string;
  expectedSalesforceOrgId: string;
  authorizationOrigin: string;
  namespacePrefix: string;
}

interface DecodedProvisioning extends DecodedBinding {
  performedByActorId: string;
  role: AdministratorRole;
}

interface ProvisioningRow {
  actor_id: unknown;
  tenant_id: unknown;
  expected_salesforce_org_id: unknown;
  authorization_origin: unknown;
  namespace_prefix: unknown;
  role: unknown;
}

function fail(code: AdministratorSessionFailureCode): never {
  throw new AdministratorSessionError(code);
}

/** Canonical namespace accepted by administrator provisioning and HTTP routes. */
export function administratorNamespacePrefix(value: unknown): string {
  if (typeof value !== 'string' || !administratorNamespacePattern.test(value))
    fail('ADMINISTRATOR_SESSION_INPUT');
  return value;
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail('ADMINISTRATOR_SESSION_INPUT');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'),
    )
  )
    fail('ADMINISTRATOR_SESSION_INPUT');
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
}

function exactKeys(value: Record<string, unknown>, expected: string[]): void {
  if (Object.keys(value).sort().join(',') !== expected.sort().join(','))
    fail('ADMINISTRATOR_SESSION_INPUT');
}

function actorId(value: unknown): string {
  if (typeof value !== 'string' || !actorPattern.test(value))
    fail('ADMINISTRATOR_SESSION_INPUT');
  return value;
}

function tenantId(value: unknown): string {
  if (typeof value !== 'string' || !tenantPattern.test(value))
    fail('ADMINISTRATOR_SESSION_INPUT');
  return value;
}

function salesforceOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048)
    fail('ADMINISTRATOR_SESSION_INPUT');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail('ADMINISTRATOR_SESSION_INPUT');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.origin !== value ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    !parsed.hostname.endsWith('.salesforce.com')
  )
    fail('ADMINISTRATOR_SESSION_INPUT');
  return parsed.origin;
}

/** Decode the closed administrator role set used by storage and route policy. */
export function administratorRole(value: unknown): AdministratorRole {
  if (
    typeof value !== 'string' ||
    !administratorRoles.includes(value as AdministratorRole)
  )
    fail('ADMINISTRATOR_SESSION_INPUT');
  return value as AdministratorRole;
}

function binding(value: unknown): DecodedBinding {
  const input = plainRecord(value);
  exactKeys(input, [
    'actorId',
    'authorizationOrigin',
    'expectedSalesforceOrgId',
    'namespacePrefix',
    'tenantId',
  ]);
  try {
    return {
      actorId: actorId(input.actorId),
      tenantId: tenantId(input.tenantId),
      expectedSalesforceOrgId: normalizeSalesforceOrgId(
        input.expectedSalesforceOrgId,
      ),
      authorizationOrigin: salesforceOrigin(input.authorizationOrigin),
      namespacePrefix: administratorNamespacePrefix(input.namespacePrefix),
    };
  } catch (error) {
    if (error instanceof AdministratorSessionError) throw error;
    fail('ADMINISTRATOR_SESSION_INPUT');
  }
}

function provisioning(value: unknown): DecodedProvisioning {
  const input = plainRecord(value);
  exactKeys(input, [
    'actorId',
    'authorizationOrigin',
    'expectedSalesforceOrgId',
    'namespacePrefix',
    'performedByActorId',
    'role',
    'tenantId',
  ]);
  const decoded = binding({
    actorId: input.actorId,
    tenantId: input.tenantId,
    expectedSalesforceOrgId: input.expectedSalesforceOrgId,
    authorizationOrigin: input.authorizationOrigin,
    namespacePrefix: input.namespacePrefix,
  });
  return {
    ...decoded,
    performedByActorId: actorId(input.performedByActorId),
    role: administratorRole(input.role),
  };
}

function deprovisioning(value: unknown): AdministratorDeprovisioningInput {
  const input = plainRecord(value);
  exactKeys(input, ['performedByActorId', 'targetActorId', 'tenantId']);
  const performedByActorId = actorId(input.performedByActorId);
  const targetActorId = actorId(input.targetActorId);
  if (performedByActorId === targetActorId)
    fail('ADMINISTRATOR_SESSION_CONFLICT');
  return Object.freeze({
    performedByActorId,
    targetActorId,
    tenantId: tenantId(input.tenantId),
  });
}

function roleChange(value: unknown): AdministratorRoleChangeInput {
  const input = plainRecord(value);
  exactKeys(input, ['performedByActorId', 'role', 'targetActorId', 'tenantId']);
  const performedByActorId = actorId(input.performedByActorId);
  const targetActorId = actorId(input.targetActorId);
  if (performedByActorId === targetActorId)
    fail('ADMINISTRATOR_SESSION_CONFLICT');
  return Object.freeze({
    performedByActorId,
    targetActorId,
    tenantId: tenantId(input.tenantId),
    role: administratorRole(input.role),
  });
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    fail('ADMINISTRATOR_SESSION_INPUT');
  return value;
}

function configuration(value: unknown): {
  sessionSecret: Buffer;
  ttlSeconds: number;
} {
  const input = plainRecord(value);
  exactKeys(input, ['sessionSecret', 'ttlSeconds']);
  if (typeof input.sessionSecret !== 'string')
    fail('ADMINISTRATOR_SESSION_INPUT');
  const secret = Buffer.from(input.sessionSecret, 'base64');
  if (secret.length !== 32 || secret.toString('base64') !== input.sessionSecret)
    fail('ADMINISTRATOR_SESSION_INPUT');
  return {
    sessionSecret: secret,
    ttlSeconds: integer(input.ttlSeconds, 300, 28_800),
  };
}

function opaqueSession(value: unknown): string {
  if (!isAdministratorSessionValue(value)) fail('ADMINISTRATOR_SESSION_INPUT');
  return value;
}

function sessionDigest(session: string): string {
  return createHash('sha256').update(session, 'ascii').digest('hex');
}

function csrfToken(secret: Buffer, session: string): string {
  return createHmac('sha256', secret)
    .update('kusanya:administrator-session-csrf:v1\0', 'utf8')
    .update(session, 'ascii')
    .digest('base64url');
}

/** Strictly decode the one shared authenticated administrator context shape. */
export function decodeTrustedAdministratorContext(
  value: unknown,
): TrustedAdministratorContext {
  const input = plainRecord(value);
  exactKeys(input, [
    'actorId',
    'authorizationOrigin',
    'csrfToken',
    'expectedSalesforceOrgId',
    'namespacePrefix',
    'role',
    'tenantId',
  ]);
  if (typeof input.csrfToken !== 'string' || !csrfPattern.test(input.csrfToken))
    fail('ADMINISTRATOR_SESSION_INPUT');
  try {
    return Object.freeze({
      actorId: actorId(input.actorId),
      tenantId: tenantId(input.tenantId),
      expectedSalesforceOrgId: normalizeSalesforceOrgId(
        input.expectedSalesforceOrgId,
      ),
      authorizationOrigin: salesforceOrigin(input.authorizationOrigin),
      namespacePrefix: administratorNamespacePrefix(input.namespacePrefix),
      role: administratorRole(input.role),
      csrfToken: input.csrfToken,
    });
  } catch (error) {
    if (error instanceof AdministratorSessionError) throw error;
    fail('ADMINISTRATOR_SESSION_INPUT');
  }
}

function decodeRow(
  value: unknown,
  secret: Buffer,
  session: string,
): TrustedAdministratorContext {
  try {
    const row = plainRecord(value) as unknown as ProvisioningRow;
    const decoded = binding({
      actorId: row.actor_id,
      tenantId: row.tenant_id,
      expectedSalesforceOrgId: row.expected_salesforce_org_id,
      authorizationOrigin: row.authorization_origin,
      namespacePrefix: row.namespace_prefix,
    });
    return decodeTrustedAdministratorContext({
      actorId: decoded.actorId,
      tenantId: decoded.tenantId,
      expectedSalesforceOrgId: decoded.expectedSalesforceOrgId,
      authorizationOrigin: decoded.authorizationOrigin,
      namespacePrefix: decoded.namespacePrefix,
      role: row.role,
      csrfToken: csrfToken(secret, session),
    });
  } catch {
    fail('ADMINISTRATOR_SESSION_STORAGE');
  }
}

export class AdministratorSessionStore {
  constructor(private readonly database: QueryExecutor) {}

  /** Create the first tenant administrator once, from the server-only bootstrap CLI. */
  async bootstrap(inputValue: AdministratorBindingInput): Promise<void> {
    const input = binding(inputValue);
    let result;
    try {
      result = await this.database.query(
        `WITH eligible AS MATERIALIZED (
           SELECT $2::uuid AS tenant_id
           WHERE NOT EXISTS (
             SELECT 1 FROM tenant_administrator_bindings
             WHERE tenant_id = $2::uuid OR actor_id = $1
           )
         ), tenant AS (
           INSERT INTO tenant_administrator_tenants (
             tenant_id, expected_salesforce_org_id,
             authorization_origin, namespace_prefix
           )
           SELECT tenant_id, $3, $4, $5 FROM eligible
           ON CONFLICT (tenant_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id
           WHERE tenant_administrator_tenants.expected_salesforce_org_id =
                   EXCLUDED.expected_salesforce_org_id
             AND tenant_administrator_tenants.authorization_origin =
                   EXCLUDED.authorization_origin
             AND tenant_administrator_tenants.namespace_prefix =
                   EXCLUDED.namespace_prefix
           RETURNING tenant_id
         ), actor AS (
           INSERT INTO tenant_administrator_bindings (
             actor_id, tenant_id, role
           )
           SELECT $1, tenant_id, 'administrator' FROM tenant
           RETURNING actor_id, tenant_id
         ), audit AS (
           INSERT INTO tenant_administrator_lifecycle_audits (
             tenant_id, performed_by_actor_id, target_actor_id, action
           )
           SELECT tenant_id, actor_id, actor_id, 'bootstrap' FROM actor
           RETURNING administrator_lifecycle_audit_id
         )
         SELECT administrator_lifecycle_audit_id FROM audit`,
        [
          input.actorId,
          input.tenantId,
          input.expectedSalesforceOrgId,
          input.authorizationOrigin,
          input.namespacePrefix,
        ],
      );
    } catch (error) {
      if (
        error !== null &&
        typeof error === 'object' &&
        !types.isProxy(error) &&
        Object.getOwnPropertyDescriptor(error, 'code')?.value === '23505'
      )
        fail('ADMINISTRATOR_SESSION_CONFLICT');
      fail('ADMINISTRATOR_SESSION_STORAGE');
    }
    if (result.rowCount === 0 && result.rows.length === 0)
      fail('ADMINISTRATOR_SESSION_CONFLICT');
    if (result.rowCount !== 1 || result.rows.length !== 1)
      fail('ADMINISTRATOR_SESSION_STORAGE');
  }

  /** Idempotently provision one immutable actor-to-tenant binding. */
  async provision(inputValue: AdministratorProvisioningInput): Promise<void> {
    const input = provisioning(inputValue);
    let result;
    try {
      result = await this.database.query(
        `WITH tenant_lock AS MATERIALIZED (
           SELECT pg_advisory_xact_lock(
             hashtextextended('tenant:' || $2::text, 0)
           )
         ), actor_lock AS MATERIALIZED (
           SELECT pg_advisory_xact_lock(
             hashtextextended('actor:' || $1, 0)
           )
           FROM tenant_lock
         ), performer AS MATERIALIZED (
           SELECT binding.actor_id, binding.tenant_id
           FROM actor_lock
           JOIN tenant_administrator_bindings binding
             ON binding.actor_id = $6
            AND binding.tenant_id = $2::uuid
            AND binding.active
            AND binding.role = 'administrator'
           JOIN tenant_administrator_tenants tenant
             ON tenant.tenant_id = binding.tenant_id
            AND tenant.expected_salesforce_org_id = $3
            AND tenant.authorization_origin = $4
            AND tenant.namespace_prefix = $5
         ), eligible AS MATERIALIZED (
           SELECT tenant_id FROM performer
           WHERE NOT EXISTS (
             SELECT 1
             FROM tenant_administrator_bindings
             WHERE actor_id = $1
               AND tenant_id <> $2::uuid
           )
         ), inserted AS (
           INSERT INTO tenant_administrator_bindings (
             actor_id, tenant_id, role
           )
           SELECT $1, tenant_id, $7 FROM eligible
           ON CONFLICT (actor_id) DO NOTHING
           RETURNING actor_id, tenant_id, role
         ), existing AS (
           SELECT binding.actor_id, binding.tenant_id, binding.role
           FROM eligible
           JOIN tenant_administrator_bindings binding
             ON binding.actor_id = $1
            AND binding.tenant_id = eligible.tenant_id
            AND binding.active
            AND binding.role = $7
         ), accepted AS MATERIALIZED (
           SELECT actor_id, tenant_id, role FROM inserted
           UNION ALL
           SELECT actor_id, tenant_id, role FROM existing
         ), audit AS (
           INSERT INTO tenant_administrator_role_audits (
             tenant_id, performed_by_actor_id, target_actor_id,
             action, previous_role, new_role
           )
           SELECT tenant_id, $6, actor_id, 'enrol', NULL, role
           FROM inserted
           RETURNING administrator_role_audit_id
         )
         SELECT actor_id FROM accepted`,
        [
          input.actorId,
          input.tenantId,
          input.expectedSalesforceOrgId,
          input.authorizationOrigin,
          input.namespacePrefix,
          input.performedByActorId,
          input.role,
        ],
      );
    } catch (error) {
      if (
        error !== null &&
        typeof error === 'object' &&
        !types.isProxy(error) &&
        Object.getOwnPropertyDescriptor(error, 'code')?.value === '23505'
      )
        fail('ADMINISTRATOR_SESSION_CONFLICT');
      fail('ADMINISTRATOR_SESSION_STORAGE');
    }
    if (result.rowCount === 0 && result.rows.length === 0)
      fail('ADMINISTRATOR_SESSION_CONFLICT');
    if (result.rowCount !== 1 || result.rows.length !== 1)
      fail('ADMINISTRATOR_SESSION_STORAGE');
  }

  /** Atomically deactivate one same-tenant actor, revoke sessions and append an audit. */
  async deprovision(
    inputValue: AdministratorDeprovisioningInput,
  ): Promise<void> {
    const input = deprovisioning(inputValue);
    let result;
    try {
      result = await this.database.query(
        `WITH tenant_lock AS MATERIALIZED (
           SELECT pg_advisory_xact_lock(
             hashtextextended('tenant:' || $3::text, 0)
           )
         ), locked AS MATERIALIZED (
           SELECT binding.actor_id, binding.tenant_id, binding.role
           FROM tenant_lock
           JOIN tenant_administrator_bindings binding
             ON binding.tenant_id = $3::uuid
            AND binding.active
           ORDER BY binding.actor_id
           FOR UPDATE OF binding
         ), eligible AS MATERIALIZED (
           SELECT target.actor_id, target.tenant_id
           FROM locked performer
           JOIN locked target
             ON performer.actor_id = $1
            AND target.actor_id = $2
            AND target.tenant_id = performer.tenant_id
           WHERE $1 <> $2
             AND performer.role = 'administrator'
             AND (
               target.role <> 'administrator'
               OR (SELECT count(*) FROM locked
                   WHERE role = 'administrator') > 1
             )
         ), disabled AS (
           UPDATE tenant_administrator_bindings binding
           SET active = false, deprovisioned_at = clock_timestamp()
           FROM eligible
           WHERE binding.actor_id = eligible.actor_id
             AND binding.tenant_id = eligible.tenant_id
           RETURNING binding.actor_id, binding.tenant_id
         ), revoked AS (
           DELETE FROM administrator_sessions session
           USING disabled
           WHERE session.actor_id = disabled.actor_id
           RETURNING session.actor_id
         ), audit AS (
           INSERT INTO tenant_administrator_lifecycle_audits (
             tenant_id, performed_by_actor_id, target_actor_id, action
           )
           SELECT tenant_id, $1, actor_id, 'deprovision' FROM disabled
           RETURNING administrator_lifecycle_audit_id
         )
         SELECT administrator_lifecycle_audit_id FROM audit`,
        [input.performedByActorId, input.targetActorId, input.tenantId],
      );
    } catch {
      fail('ADMINISTRATOR_SESSION_STORAGE');
    }
    if (result.rowCount === 0 && result.rows.length === 0)
      fail('ADMINISTRATOR_SESSION_CONFLICT');
    if (result.rowCount !== 1 || result.rows.length !== 1)
      fail('ADMINISTRATOR_SESSION_STORAGE');
  }

  /** Atomically rescope one peer while retaining at least one full administrator. */
  async changeRole(inputValue: AdministratorRoleChangeInput): Promise<void> {
    const input = roleChange(inputValue);
    let result;
    try {
      result = await this.database.query(
        `WITH tenant_lock AS MATERIALIZED (
           SELECT pg_advisory_xact_lock(
             hashtextextended('tenant:' || $3::text, 0)
           )
         ), locked AS MATERIALIZED (
           SELECT binding.actor_id, binding.tenant_id, binding.role
           FROM tenant_lock
           JOIN tenant_administrator_bindings binding
             ON binding.tenant_id = $3::uuid
            AND binding.active
           ORDER BY binding.actor_id
           FOR UPDATE OF binding
         ), eligible AS MATERIALIZED (
           SELECT target.actor_id, target.tenant_id,
                  target.role AS previous_role
           FROM locked performer
           JOIN locked target
             ON performer.actor_id = $1
            AND target.actor_id = $2
            AND target.tenant_id = performer.tenant_id
           WHERE $1 <> $2
             AND performer.role = 'administrator'
             AND target.role <> $4
             AND (
               target.role <> 'administrator'
               OR $4 = 'administrator'
               OR (SELECT count(*) FROM locked
                   WHERE role = 'administrator') > 1
             )
         ), changed AS (
           UPDATE tenant_administrator_bindings binding
           SET role = $4
           FROM eligible
           WHERE binding.actor_id = eligible.actor_id
             AND binding.tenant_id = eligible.tenant_id
           RETURNING binding.actor_id, binding.tenant_id,
                     eligible.previous_role, binding.role AS new_role
         ), audit AS (
           INSERT INTO tenant_administrator_role_audits (
             tenant_id, performed_by_actor_id, target_actor_id,
             action, previous_role, new_role
           )
           SELECT tenant_id, $1, actor_id, 'change',
                  previous_role, new_role
           FROM changed
           RETURNING administrator_role_audit_id
         )
         SELECT administrator_role_audit_id FROM audit`,
        [
          input.performedByActorId,
          input.targetActorId,
          input.tenantId,
          input.role,
        ],
      );
    } catch {
      fail('ADMINISTRATOR_SESSION_STORAGE');
    }
    if (result.rowCount === 0 && result.rows.length === 0)
      fail('ADMINISTRATOR_SESSION_CONFLICT');
    if (result.rowCount !== 1 || result.rows.length !== 1)
      fail('ADMINISTRATOR_SESSION_STORAGE');
  }

  /** Issue a fresh post-login session, atomically invalidating the actor's old one. */
  async issue(
    trustedActorId: string,
    configurationValue: AdministratorSessionConfiguration,
  ): Promise<IssuedAdministratorSession> {
    const actor = actorId(trustedActorId);
    const decoded = configuration(configurationValue);
    const session = randomBytes(32).toString('base64url');
    const digest = sessionDigest(session);
    let result;
    try {
      result = await this.database.query(
        `INSERT INTO administrator_sessions (
           session_digest, actor_id, expires_at
         )
         SELECT $1, actor_id,
                clock_timestamp() + ($3 * interval '1 second')
         FROM tenant_administrator_bindings
         WHERE actor_id = $2
           AND active
         ON CONFLICT (actor_id) DO UPDATE SET
           session_digest = EXCLUDED.session_digest,
           expires_at = EXCLUDED.expires_at,
           created_at = clock_timestamp()
         RETURNING session_digest`,
        [digest, actor, decoded.ttlSeconds],
      );
    } catch {
      fail('ADMINISTRATOR_SESSION_STORAGE');
    }
    if (result.rowCount === 0 && result.rows.length === 0)
      fail('ADMINISTRATOR_SESSION_ABSENT');
    if (result.rowCount !== 1 || result.rows.length !== 1)
      fail('ADMINISTRATOR_SESSION_STORAGE');
    return Object.freeze({
      opaqueSession: session,
      csrfToken: csrfToken(decoded.sessionSecret, session),
      expiresInSeconds: decoded.ttlSeconds,
    });
  }

  /** Resolve every request against live PostgreSQL state for immediate revocation. */
  async authenticate(
    opaqueSessionValue: string,
    configurationValue: AdministratorSessionConfiguration,
  ): Promise<TrustedAdministratorContext | undefined> {
    const session = opaqueSession(opaqueSessionValue);
    const decoded = configuration(configurationValue);
    const digest = sessionDigest(session);
    if (!digestPattern.test(digest)) fail('ADMINISTRATOR_SESSION_STORAGE');
    let result;
    try {
      result = await this.database.query<ProvisioningRow>(
        `WITH expired AS (
           DELETE FROM administrator_sessions
           WHERE session_digest = $1
             AND expires_at <= clock_timestamp()
         )
         SELECT b.actor_id, b.tenant_id, t.expected_salesforce_org_id,
                t.authorization_origin, t.namespace_prefix, b.role
         FROM administrator_sessions s
         JOIN tenant_administrator_bindings b ON b.actor_id = s.actor_id
         JOIN tenant_administrator_tenants t ON t.tenant_id = b.tenant_id
         WHERE s.session_digest = $1
           AND s.expires_at > clock_timestamp()
           AND b.active`,
        [digest],
      );
    } catch {
      fail('ADMINISTRATOR_SESSION_STORAGE');
    }
    if (result.rowCount === 0 && result.rows.length === 0) return undefined;
    if (result.rowCount !== 1 || result.rows.length !== 1)
      fail('ADMINISTRATOR_SESSION_STORAGE');
    return decodeRow(result.rows[0]!, decoded.sessionSecret, session);
  }

  /** Idempotent logout for one opaque session. */
  async revoke(opaqueSessionValue: string): Promise<boolean> {
    const digest = sessionDigest(opaqueSession(opaqueSessionValue));
    let result;
    try {
      result = await this.database.query(
        `DELETE FROM administrator_sessions WHERE session_digest = $1`,
        [digest],
      );
    } catch {
      fail('ADMINISTRATOR_SESSION_STORAGE');
    }
    if (result.rows.length !== 0 || ![0, 1].includes(result.rowCount ?? -1))
      fail('ADMINISTRATOR_SESSION_STORAGE');
    return result.rowCount === 1;
  }

  /** Security/operator revocation of the actor's sole active session. */
  async revokeActor(trustedActorId: string): Promise<boolean> {
    const actor = actorId(trustedActorId);
    let result;
    try {
      result = await this.database.query(
        `DELETE FROM administrator_sessions WHERE actor_id = $1`,
        [actor],
      );
    } catch {
      fail('ADMINISTRATOR_SESSION_STORAGE');
    }
    if (result.rows.length !== 0 || ![0, 1].includes(result.rowCount ?? -1))
      fail('ADMINISTRATOR_SESSION_STORAGE');
    return result.rowCount === 1;
  }
}
