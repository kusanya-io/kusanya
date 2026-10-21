/** Tenant-scoped Salesforce connection persistence; no OAuth or access-token flow. */
import { types } from 'node:util';
import { createSalesforceNames } from '../salesforce-names.js';
import type {
  EncryptedTenantCredential,
  TenantCredentialVault,
} from './credential-vault.js';

const tenantIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const salesforceIdPattern = /^00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;
const salesforceUserIdPattern = /^005[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;
const actorIdPattern = /^[A-Za-z0-9:_-]{1,128}$/;
const tokenPattern = /^[\x21-\x7e]+$/;
const maximumCredentialLength = 4096;

export type TenantConnectionFailureCode =
  | 'TENANT_CONNECTION_INPUT'
  | 'TENANT_CONNECTION_CONFLICT'
  | 'TENANT_CONNECTION_STORAGE';

export class TenantConnectionError extends Error {
  constructor(readonly code: TenantConnectionFailureCode) {
    super(code);
    this.name = 'TenantConnectionError';
  }
}

export interface TenantConnectionInput {
  readonly tenantId: string;
  readonly salesforceOrgId: string;
  readonly authorizationOrigin: string;
  readonly instanceOrigin: string;
  readonly namespacePrefix: string;
  readonly refreshToken: string;
}

export interface TenantAuthorizationAuditInput extends TenantConnectionInput {
  /** Stable actor from the live administrator session, never request data. */
  readonly actorId: string;
  /** Salesforce user from the signed OAuth identity response. */
  readonly salesforceUserId: string;
}

export interface TenantConnection {
  readonly tenantId: string;
  readonly salesforceOrgId: string;
  readonly authorizationOrigin: string;
  readonly instanceOrigin: string;
  readonly namespacePrefix: string;
  readonly credentialVersion: number;
  readonly needsEncryptionRotation: boolean;
  getRefreshToken(): string;
}

export interface QueryResult<Row> {
  readonly rows: readonly Row[];
  readonly rowCount: number | null;
}

export interface QueryExecutor {
  query<Row>(text: string, values?: unknown[]): Promise<QueryResult<Row>>;
  connect?(): Promise<QueryConnection>;
}

export interface QueryConnection extends QueryExecutor {
  release(): void;
}

export interface TenantRefreshResult<Value> {
  readonly value: Value;
  readonly rotatedRefreshToken?: string;
}

export interface LockedTenantRefreshResult<Value> {
  readonly value: Value;
  readonly connection: TenantConnection;
}

interface ConnectionRow {
  tenant_id: unknown;
  salesforce_org_id: unknown;
  authorization_origin: unknown;
  instance_origin: unknown;
  namespace_prefix: unknown;
  credential_schema_version: unknown;
  credential_key_id: unknown;
  credential_nonce: unknown;
  credential_ciphertext: unknown;
  credential_tag: unknown;
  credential_version: unknown;
}

function fail(code: TenantConnectionFailureCode): never {
  throw new TenantConnectionError(code);
}

function databaseFailureCode(error: unknown): TenantConnectionFailureCode {
  if (error === null || typeof error !== 'object' || types.isProxy(error))
    return 'TENANT_CONNECTION_STORAGE';
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  return descriptor &&
    Object.hasOwn(descriptor, 'value') &&
    descriptor.value === '23505'
    ? 'TENANT_CONNECTION_CONFLICT'
    : 'TENANT_CONNECTION_STORAGE';
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail('TENANT_CONNECTION_INPUT');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'),
    )
  )
    fail('TENANT_CONNECTION_INPUT');
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
}

function exactKeys(value: Record<string, unknown>, expected: string[]): void {
  if (Object.keys(value).sort().join(',') !== expected.sort().join(','))
    fail('TENANT_CONNECTION_INPUT');
}

function tenantId(value: unknown): string {
  if (typeof value !== 'string' || !tenantIdPattern.test(value))
    fail('TENANT_CONNECTION_INPUT');
  return value;
}

function refreshToken(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximumCredentialLength ||
    !tokenPattern.test(value)
  )
    fail('TENANT_CONNECTION_INPUT');
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

function normalizeSalesforceId(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value))
    fail('TENANT_CONNECTION_INPUT');
  const first = value.slice(0, 15);
  const normalized = first + salesforceChecksum(first);
  if (value.length === 18 && value !== normalized)
    fail('TENANT_CONNECTION_INPUT');
  return normalized;
}

export function normalizeSalesforceOrgId(value: unknown): string {
  return normalizeSalesforceId(value, salesforceIdPattern);
}

export function normalizeSalesforceUserId(value: unknown): string {
  return normalizeSalesforceId(value, salesforceUserIdPattern);
}

function salesforceOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048)
    fail('TENANT_CONNECTION_INPUT');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail('TENANT_CONNECTION_INPUT');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.origin !== value ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    !parsed.hostname.endsWith('.salesforce.com')
  )
    fail('TENANT_CONNECTION_INPUT');
  return parsed.origin;
}

type DecodedConnectionInput = Omit<TenantConnectionInput, 'salesforceOrgId'> & {
  salesforceOrgId: string;
};

function decodeConnectionRecord(
  input: Record<string, unknown>,
): DecodedConnectionInput {
  if (typeof input.namespacePrefix !== 'string')
    fail('TENANT_CONNECTION_INPUT');
  try {
    createSalesforceNames(input.namespacePrefix);
  } catch {
    fail('TENANT_CONNECTION_INPUT');
  }
  return {
    tenantId: tenantId(input.tenantId),
    salesforceOrgId: normalizeSalesforceOrgId(input.salesforceOrgId),
    authorizationOrigin: salesforceOrigin(input.authorizationOrigin),
    instanceOrigin: salesforceOrigin(input.instanceOrigin),
    namespacePrefix: input.namespacePrefix,
    refreshToken: refreshToken(input.refreshToken),
  };
}

function decodeInput(value: unknown): DecodedConnectionInput {
  const input = plainRecord(value);
  exactKeys(input, [
    'tenantId',
    'salesforceOrgId',
    'authorizationOrigin',
    'instanceOrigin',
    'namespacePrefix',
    'refreshToken',
  ]);
  return decodeConnectionRecord(input);
}

function decodeAuthorizationInput(value: unknown): DecodedConnectionInput & {
  actorId: string;
  salesforceUserId: string;
} {
  const input = plainRecord(value);
  exactKeys(input, [
    'actorId',
    'tenantId',
    'salesforceOrgId',
    'salesforceUserId',
    'authorizationOrigin',
    'instanceOrigin',
    'namespacePrefix',
    'refreshToken',
  ]);
  if (typeof input.actorId !== 'string' || !actorIdPattern.test(input.actorId))
    fail('TENANT_CONNECTION_INPUT');
  return {
    ...decodeConnectionRecord(input),
    actorId: input.actorId,
    salesforceUserId: normalizeSalesforceUserId(input.salesforceUserId),
  };
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum)
    fail('TENANT_CONNECTION_STORAGE');
  return value;
}

function decodeRow(value: unknown): {
  metadata: Omit<
    TenantConnection,
    'needsEncryptionRotation' | 'getRefreshToken'
  >;
  encrypted: EncryptedTenantCredential;
} {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      fail('TENANT_CONNECTION_STORAGE');
    const row = value as ConnectionRow;
    const version = row.credential_version;
    if (!Number.isSafeInteger(version) || (version as number) < 1)
      fail('TENANT_CONNECTION_STORAGE');
    const schemaVersion = row.credential_schema_version;
    if (schemaVersion !== 1) fail('TENANT_CONNECTION_STORAGE');
    const namespacePrefix =
      typeof row.namespace_prefix === 'string' ? row.namespace_prefix : '';
    createSalesforceNames(namespacePrefix);
    return {
      metadata: {
        tenantId: tenantId(row.tenant_id),
        salesforceOrgId: normalizeSalesforceOrgId(row.salesforce_org_id),
        authorizationOrigin: salesforceOrigin(row.authorization_origin),
        instanceOrigin: salesforceOrigin(row.instance_origin),
        namespacePrefix,
        credentialVersion: version as number,
      },
      encrypted: Object.freeze({
        schemaVersion: 1,
        keyId: text(row.credential_key_id, 64),
        nonce: text(row.credential_nonce, 64),
        ciphertext: text(row.credential_ciphertext, 8192),
        tag: text(row.credential_tag, 64),
      }),
    };
  } catch {
    fail('TENANT_CONNECTION_STORAGE');
  }
}

const returnedColumns = `
  tenant_id,
  salesforce_org_id,
  authorization_origin,
  instance_origin,
  namespace_prefix,
  credential_schema_version,
  credential_key_id,
  credential_nonce,
  credential_ciphertext,
  credential_tag,
  credential_version`;

export class TenantConnectionStore {
  constructor(
    private readonly database: QueryExecutor,
    private readonly vault: TenantCredentialVault,
  ) {}

  private upsert(
    executor: QueryExecutor,
    input: DecodedConnectionInput,
    encrypted: EncryptedTenantCredential,
  ): Promise<QueryResult<ConnectionRow>> {
    return executor.query<ConnectionRow>(
      `INSERT INTO tenant_connections (
        tenant_id, salesforce_org_id, authorization_origin, instance_origin,
        namespace_prefix, credential_schema_version, credential_key_id,
        credential_nonce, credential_ciphertext, credential_tag
      ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (tenant_id) DO UPDATE SET
        authorization_origin = EXCLUDED.authorization_origin,
        instance_origin = EXCLUDED.instance_origin,
        namespace_prefix = EXCLUDED.namespace_prefix,
        credential_schema_version = EXCLUDED.credential_schema_version,
        credential_key_id = EXCLUDED.credential_key_id,
        credential_nonce = EXCLUDED.credential_nonce,
        credential_ciphertext = EXCLUDED.credential_ciphertext,
        credential_tag = EXCLUDED.credential_tag,
        credential_version = tenant_connections.credential_version + 1,
        credential_updated_at = clock_timestamp(),
        updated_at = clock_timestamp()
      WHERE tenant_connections.salesforce_org_id = EXCLUDED.salesforce_org_id
      RETURNING ${returnedColumns}`,
      [
        input.tenantId,
        input.salesforceOrgId,
        input.authorizationOrigin,
        input.instanceOrigin,
        input.namespacePrefix,
        encrypted.schemaVersion,
        encrypted.keyId,
        encrypted.nonce,
        encrypted.ciphertext,
        encrypted.tag,
      ],
    );
  }

  async save(value: TenantConnectionInput): Promise<TenantConnection> {
    const input = decodeInput(value);
    const context = {
      tenantId: input.tenantId,
      salesforceOrgId: input.salesforceOrgId,
    };
    const encrypted = this.vault.seal(context, input.refreshToken);
    let result: QueryResult<ConnectionRow>;
    try {
      result = await this.upsert(this.database, input, encrypted);
    } catch (error) {
      fail(databaseFailureCode(error));
    }
    if (result.rowCount !== 1 || result.rows.length !== 1)
      fail('TENANT_CONNECTION_CONFLICT');
    return this.connection(result.rows[0]!);
  }

  /** Persist a signed OAuth grant and its trusted administrator audit atomically. */
  async saveAuthorization(
    value: TenantAuthorizationAuditInput,
  ): Promise<TenantConnection> {
    const input = decodeAuthorizationInput(value);
    if (typeof this.database.connect !== 'function')
      fail('TENANT_CONNECTION_INPUT');
    const encrypted = this.vault.seal(
      {
        tenantId: input.tenantId,
        salesforceOrgId: input.salesforceOrgId,
      },
      input.refreshToken,
    );
    let client: QueryConnection;
    try {
      client = await this.database.connect.call(this.database);
    } catch {
      fail('TENANT_CONNECTION_STORAGE');
    }
    let transaction = false;
    try {
      await client.query('BEGIN');
      transaction = true;
      const saved = await this.upsert(client, input, encrypted);
      if (saved.rowCount !== 1 || saved.rows.length !== 1)
        fail('TENANT_CONNECTION_CONFLICT');
      const connection = this.connection(saved.rows[0]!);
      const audit = await client.query(
        `INSERT INTO tenant_salesforce_authorization_audits (
           tenant_id, actor_id, salesforce_org_id,
           salesforce_user_id, credential_version
         )
         SELECT c.tenant_id, b.actor_id, c.salesforce_org_id, $3, $4
         FROM tenant_connections c
         JOIN tenant_administrator_bindings b
           ON b.tenant_id = c.tenant_id
         JOIN tenant_administrator_tenants t
           ON t.tenant_id = b.tenant_id
         WHERE c.tenant_id = $1::uuid
           AND b.actor_id = $2
           AND c.salesforce_org_id = $5
           AND t.expected_salesforce_org_id = c.salesforce_org_id
           AND t.authorization_origin = c.authorization_origin
           AND t.namespace_prefix = c.namespace_prefix
         RETURNING authorization_audit_id`,
        [
          input.tenantId,
          input.actorId,
          input.salesforceUserId,
          connection.credentialVersion,
          input.salesforceOrgId,
        ],
      );
      if (audit.rowCount !== 1 || audit.rows.length !== 1)
        fail('TENANT_CONNECTION_CONFLICT');
      await client.query('COMMIT');
      transaction = false;
      return connection;
    } catch (error) {
      if (transaction) await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof TenantConnectionError) throw error;
      fail(databaseFailureCode(error));
    } finally {
      client.release();
    }
  }

  async load(value: string): Promise<TenantConnection | undefined> {
    const id = tenantId(value);
    let result: QueryResult<ConnectionRow>;
    try {
      result = await this.database.query<ConnectionRow>(
        `SELECT ${returnedColumns}
         FROM tenant_connections
         WHERE tenant_id = $1::uuid`,
        [id],
      );
    } catch {
      fail('TENANT_CONNECTION_STORAGE');
    }
    if (result.rowCount === 0 && result.rows.length === 0) return undefined;
    if (result.rowCount !== 1 || result.rows.length !== 1)
      fail('TENANT_CONNECTION_STORAGE');
    return this.connection(result.rows[0]!);
  }

  async withRefreshLock<Value>(
    tenantIdValue: string,
    operation: (
      connection: TenantConnection,
    ) => Promise<TenantRefreshResult<Value>>,
  ): Promise<LockedTenantRefreshResult<Value> | undefined> {
    const id = tenantId(tenantIdValue);
    if (
      typeof operation !== 'function' ||
      typeof this.database.connect !== 'function'
    )
      fail('TENANT_CONNECTION_INPUT');
    let client: QueryConnection;
    try {
      client = await this.database.connect.call(this.database);
    } catch {
      fail('TENANT_CONNECTION_STORAGE');
    }
    let transaction = false;
    let operationFailed = false;
    try {
      await client.query('BEGIN');
      transaction = true;
      const selected = await client.query<ConnectionRow>(
        `SELECT ${returnedColumns}
         FROM tenant_connections
         WHERE tenant_id = $1::uuid
         FOR UPDATE`,
        [id],
      );
      if (selected.rowCount === 0 && selected.rows.length === 0) {
        await client.query('COMMIT');
        transaction = false;
        return undefined;
      }
      if (selected.rowCount !== 1 || selected.rows.length !== 1)
        fail('TENANT_CONNECTION_STORAGE');
      let current = this.connection(selected.rows[0]!);
      let result: TenantRefreshResult<Value>;
      try {
        result = await operation(current);
      } catch (error) {
        operationFailed = true;
        throw error;
      }
      if (
        result === null ||
        typeof result !== 'object' ||
        types.isProxy(result) ||
        Object.getPrototypeOf(result) !== Object.prototype
      )
        fail('TENANT_CONNECTION_INPUT');
      const descriptors = Object.getOwnPropertyDescriptors(result);
      const keys = Object.keys(descriptors).sort().join(',');
      if (
        Reflect.ownKeys(descriptors).some(
          (key) =>
            typeof key !== 'string' ||
            !Object.hasOwn(descriptors[key]!, 'value'),
        ) ||
        (keys !== 'value' && keys !== 'rotatedRefreshToken,value')
      )
        fail('TENANT_CONNECTION_INPUT');
      const rotated = descriptors.rotatedRefreshToken?.value as unknown;
      if (rotated !== undefined) {
        const token = refreshToken(rotated);
        const encrypted = this.vault.seal(
          {
            tenantId: current.tenantId,
            salesforceOrgId: current.salesforceOrgId,
          },
          token,
        );
        const updated = await client.query<ConnectionRow>(
          `UPDATE tenant_connections SET
             credential_schema_version = $4,
             credential_key_id = $5,
             credential_nonce = $6,
             credential_ciphertext = $7,
             credential_tag = $8,
             credential_version = credential_version + 1,
             credential_updated_at = clock_timestamp(),
             updated_at = clock_timestamp()
           WHERE tenant_id = $1::uuid
             AND salesforce_org_id = $2
             AND credential_version = $3
           RETURNING ${returnedColumns}`,
          [
            current.tenantId,
            current.salesforceOrgId,
            current.credentialVersion,
            encrypted.schemaVersion,
            encrypted.keyId,
            encrypted.nonce,
            encrypted.ciphertext,
            encrypted.tag,
          ],
        );
        if (updated.rowCount !== 1 || updated.rows.length !== 1)
          fail('TENANT_CONNECTION_CONFLICT');
        current = this.connection(updated.rows[0]!);
      }
      await client.query('COMMIT');
      transaction = false;
      return Object.freeze({
        value: descriptors.value.value as Value,
        connection: current,
      });
    } catch (error) {
      if (transaction) await client.query('ROLLBACK').catch(() => undefined);
      if (operationFailed || error instanceof TenantConnectionError)
        throw error;
      fail('TENANT_CONNECTION_STORAGE');
    } finally {
      client.release();
    }
  }

  async rotateEncryption(value: string): Promise<boolean> {
    const id = tenantId(value);
    let selected: QueryResult<ConnectionRow>;
    try {
      selected = await this.database.query<ConnectionRow>(
        `SELECT ${returnedColumns}
         FROM tenant_connections
         WHERE tenant_id = $1::uuid`,
        [id],
      );
    } catch {
      fail('TENANT_CONNECTION_STORAGE');
    }
    if (selected.rowCount === 0 && selected.rows.length === 0) return false;
    if (selected.rowCount !== 1 || selected.rows.length !== 1)
      fail('TENANT_CONNECTION_STORAGE');
    const decoded = decodeRow(selected.rows[0]!);
    if (!this.vault.needsRotation(decoded.encrypted)) return false;
    const context = {
      tenantId: decoded.metadata.tenantId,
      salesforceOrgId: decoded.metadata.salesforceOrgId,
    };
    const rewrapped = this.vault.rewrap(context, decoded.encrypted);
    let updated: QueryResult<ConnectionRow>;
    try {
      updated = await this.database.query<ConnectionRow>(
        `UPDATE tenant_connections SET
           credential_schema_version = $2,
           credential_key_id = $3,
           credential_nonce = $4,
           credential_ciphertext = $5,
           credential_tag = $6,
           updated_at = clock_timestamp()
         WHERE tenant_id = $1::uuid
           AND credential_version = $7
           AND credential_key_id = $8
         RETURNING ${returnedColumns}`,
        [
          id,
          rewrapped.schemaVersion,
          rewrapped.keyId,
          rewrapped.nonce,
          rewrapped.ciphertext,
          rewrapped.tag,
          decoded.metadata.credentialVersion,
          decoded.encrypted.keyId,
        ],
      );
    } catch {
      fail('TENANT_CONNECTION_STORAGE');
    }
    if (updated.rowCount !== 1 || updated.rows.length !== 1)
      fail('TENANT_CONNECTION_CONFLICT');
    return true;
  }

  private connection(row: ConnectionRow): TenantConnection {
    const decoded = decodeRow(row);
    const context = {
      tenantId: decoded.metadata.tenantId,
      salesforceOrgId: decoded.metadata.salesforceOrgId,
    };
    const encrypted = decoded.encrypted;
    const connection = {
      ...decoded.metadata,
      needsEncryptionRotation: this.vault.needsRotation(encrypted),
    } as Omit<TenantConnection, 'getRefreshToken'> &
      Partial<Pick<TenantConnection, 'getRefreshToken'>>;
    Object.defineProperty(connection, 'getRefreshToken', {
      configurable: false,
      enumerable: false,
      value: () => this.vault.open(context, encrypted),
      writable: false,
    });
    return Object.freeze(connection) as TenantConnection;
  }
}
