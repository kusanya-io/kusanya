/** Opaque, revocable administrator sessions bound to immutable tenant provisioning. */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { types } from 'node:util';
import {
  normalizeSalesforceOrgId,
  type QueryExecutor,
} from './connection-store.js';

const actorPattern = /^[A-Za-z0-9:_-]{1,128}$/;
const tenantPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sessionPattern = /^[A-Za-z0-9_-]{43}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const administratorNamespacePattern = /^(?:|[a-z][a-z0-9]{0,14}__)$/;

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

export interface AdministratorProvisioningInput {
  /** Internal stable actor identifier produced by a future trusted identity mapper. */
  readonly actorId: string;
  readonly tenantId: string;
  readonly expectedSalesforceOrgId: string;
  readonly authorizationOrigin: string;
  readonly namespacePrefix: string;
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
  readonly csrfToken: string;
}

interface DecodedProvisioning {
  actorId: string;
  tenantId: string;
  expectedSalesforceOrgId: string;
  authorizationOrigin: string;
  namespacePrefix: string;
}

interface ProvisioningRow {
  actor_id: unknown;
  tenant_id: unknown;
  expected_salesforce_org_id: unknown;
  authorization_origin: unknown;
  namespace_prefix: unknown;
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

function provisioning(value: unknown): DecodedProvisioning {
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
  if (typeof value !== 'string' || !sessionPattern.test(value))
    fail('ADMINISTRATOR_SESSION_INPUT');
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

function decodeRow(
  value: unknown,
  secret: Buffer,
  session: string,
): TrustedAdministratorContext {
  try {
    const row = plainRecord(value) as unknown as ProvisioningRow;
    const decoded = provisioning({
      actorId: row.actor_id,
      tenantId: row.tenant_id,
      expectedSalesforceOrgId: row.expected_salesforce_org_id,
      authorizationOrigin: row.authorization_origin,
      namespacePrefix: row.namespace_prefix,
    });
    return Object.freeze({
      actorId: decoded.actorId,
      tenantId: decoded.tenantId,
      expectedSalesforceOrgId: decoded.expectedSalesforceOrgId,
      authorizationOrigin: decoded.authorizationOrigin,
      namespacePrefix: decoded.namespacePrefix,
      csrfToken: csrfToken(secret, session),
    });
  } catch {
    fail('ADMINISTRATOR_SESSION_STORAGE');
  }
}

export class AdministratorSessionStore {
  constructor(private readonly database: QueryExecutor) {}

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
         ), eligible AS MATERIALIZED (
           SELECT $2::uuid AS tenant_id
           FROM actor_lock
           WHERE NOT EXISTS (
             SELECT 1
             FROM tenant_administrator_bindings
             WHERE actor_id = $1
               AND tenant_id <> $2::uuid
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
           INSERT INTO tenant_administrator_bindings (actor_id, tenant_id)
           SELECT $1, tenant_id FROM tenant
           ON CONFLICT (actor_id) DO UPDATE SET actor_id = EXCLUDED.actor_id
           WHERE tenant_administrator_bindings.tenant_id = EXCLUDED.tenant_id
           RETURNING actor_id
         )
         SELECT actor_id FROM actor`,
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
                t.authorization_origin, t.namespace_prefix
         FROM administrator_sessions s
         JOIN tenant_administrator_bindings b ON b.actor_id = s.actor_id
         JOIN tenant_administrator_tenants t ON t.tenant_id = b.tenant_id
         WHERE s.session_digest = $1
           AND s.expires_at > clock_timestamp()`,
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
