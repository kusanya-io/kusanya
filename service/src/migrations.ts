/** Transactional, checksum-pinned PostgreSQL schema migrations. */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

const migrationLock = 1262831945;

const migrations = Object.freeze([
  Object.freeze({
    id: '0001_tenant_connections',
    sql: `CREATE TABLE tenant_connections (
      tenant_id uuid PRIMARY KEY,
      salesforce_org_id varchar(18) NOT NULL UNIQUE,
      authorization_origin varchar(2048) NOT NULL,
      instance_origin varchar(2048) NOT NULL,
      namespace_prefix varchar(64) NOT NULL DEFAULT '',
      credential_schema_version smallint NOT NULL,
      credential_key_id varchar(64) NOT NULL,
      credential_nonce varchar(64) NOT NULL,
      credential_ciphertext varchar(8192) NOT NULL,
      credential_tag varchar(64) NOT NULL,
      credential_version integer NOT NULL DEFAULT 1,
      connected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      credential_updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT tenant_connections_org_id_shape
        CHECK (salesforce_org_id ~ '^00D[A-Za-z0-9]{15}$'),
      CONSTRAINT tenant_connections_authorization_origin_length
        CHECK (length(authorization_origin) BETWEEN 1 AND 2048),
      CONSTRAINT tenant_connections_instance_origin_length
        CHECK (length(instance_origin) BETWEEN 1 AND 2048),
      CONSTRAINT tenant_connections_credential_schema
        CHECK (credential_schema_version = 1),
      CONSTRAINT tenant_connections_key_id_length
        CHECK (length(credential_key_id) BETWEEN 1 AND 64),
      CONSTRAINT tenant_connections_nonce_length
        CHECK (length(credential_nonce) BETWEEN 1 AND 64),
      CONSTRAINT tenant_connections_ciphertext_length
        CHECK (length(credential_ciphertext) BETWEEN 1 AND 8192),
      CONSTRAINT tenant_connections_tag_length
        CHECK (length(credential_tag) BETWEEN 1 AND 64),
      CONSTRAINT tenant_connections_credential_version
        CHECK (credential_version >= 1)
    )`,
  }),
  Object.freeze({
    id: '0002_tenant_oauth_transactions',
    sql: `CREATE TABLE tenant_oauth_transactions (
      state_digest char(64) PRIMARY KEY,
      tenant_id uuid NOT NULL UNIQUE,
      expected_salesforce_org_id varchar(18) NOT NULL,
      authorization_origin varchar(2048) NOT NULL,
      namespace_prefix varchar(64) NOT NULL DEFAULT '',
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT tenant_oauth_transactions_state_digest_shape
        CHECK (state_digest ~ '^[0-9a-f]{64}$'),
      CONSTRAINT tenant_oauth_transactions_org_id_shape
        CHECK (expected_salesforce_org_id ~ '^00D[A-Za-z0-9]{15}$'),
      CONSTRAINT tenant_oauth_transactions_authorization_origin_length
        CHECK (length(authorization_origin) BETWEEN 1 AND 2048),
      CONSTRAINT tenant_oauth_transactions_expiry_order
        CHECK (expires_at > created_at)
    )`,
  }),
  Object.freeze({
    id: '0003_administrator_sessions',
    sql: `CREATE TABLE tenant_administrator_bindings (
      actor_id varchar(128) PRIMARY KEY,
      tenant_id uuid NOT NULL,
      expected_salesforce_org_id varchar(18) NOT NULL,
      authorization_origin varchar(2048) NOT NULL,
      namespace_prefix varchar(64) NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT tenant_administrator_bindings_actor_shape
        CHECK (actor_id ~ '^[A-Za-z0-9:_-]{1,128}$'),
      CONSTRAINT tenant_administrator_bindings_org_id_shape
        CHECK (expected_salesforce_org_id ~ '^00D[A-Za-z0-9]{15}$'),
      CONSTRAINT tenant_administrator_bindings_origin_length
        CHECK (length(authorization_origin) BETWEEN 1 AND 2048)
    );
    CREATE TABLE administrator_sessions (
      session_digest char(64) PRIMARY KEY,
      actor_id varchar(128) NOT NULL UNIQUE
        REFERENCES tenant_administrator_bindings(actor_id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT administrator_sessions_digest_shape
        CHECK (session_digest ~ '^[0-9a-f]{64}$'),
      CONSTRAINT administrator_sessions_expiry_order
        CHECK (expires_at > created_at)
    )`,
  }),
  Object.freeze({
    id: '0004_administrator_tenants',
    sql: `CREATE TABLE tenant_administrator_tenants (
      tenant_id uuid PRIMARY KEY,
      expected_salesforce_org_id varchar(18) NOT NULL UNIQUE,
      authorization_origin varchar(2048) NOT NULL,
      namespace_prefix varchar(17) NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT tenant_administrator_tenants_org_id_shape
        CHECK (expected_salesforce_org_id ~ '^00D[A-Za-z0-9]{15}$'),
      CONSTRAINT tenant_administrator_tenants_origin_length
        CHECK (length(authorization_origin) BETWEEN 1 AND 2048),
      CONSTRAINT tenant_administrator_tenants_namespace_shape
        CHECK (namespace_prefix ~ '^(|[a-z][a-z0-9]{0,14}__)$')
    );
    DO $$
    BEGIN
      IF EXISTS (
        SELECT tenant_id
        FROM tenant_administrator_bindings
        GROUP BY tenant_id
        HAVING count(DISTINCT ROW(
          expected_salesforce_org_id,
          authorization_origin,
          namespace_prefix
        )) > 1
      ) THEN
        RAISE EXCEPTION 'inconsistent administrator tenant bindings';
      END IF;
    END $$;
    INSERT INTO tenant_administrator_tenants (
      tenant_id, expected_salesforce_org_id,
      authorization_origin, namespace_prefix
    )
    SELECT DISTINCT tenant_id, expected_salesforce_org_id,
           authorization_origin, namespace_prefix
    FROM tenant_administrator_bindings;
    ALTER TABLE tenant_administrator_bindings
      ADD CONSTRAINT tenant_administrator_bindings_tenant
      FOREIGN KEY (tenant_id)
      REFERENCES tenant_administrator_tenants(tenant_id),
      DROP COLUMN expected_salesforce_org_id,
      DROP COLUMN authorization_origin,
      DROP COLUMN namespace_prefix`,
  }),
  Object.freeze({
    id: '0005_salesforce_authorization_audits',
    sql: `ALTER TABLE tenant_administrator_bindings
      ADD CONSTRAINT tenant_administrator_bindings_actor_tenant
      UNIQUE (actor_id, tenant_id);
    CREATE TABLE tenant_salesforce_authorization_audits (
      authorization_audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      tenant_id uuid NOT NULL
        REFERENCES tenant_connections(tenant_id),
      actor_id varchar(128) NOT NULL,
      salesforce_org_id varchar(18) NOT NULL,
      salesforce_user_id varchar(18) NOT NULL,
      credential_version integer NOT NULL,
      authorized_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT tenant_salesforce_authorization_audits_actor_tenant
        FOREIGN KEY (actor_id, tenant_id)
        REFERENCES tenant_administrator_bindings(actor_id, tenant_id),
      CONSTRAINT tenant_salesforce_authorization_audits_org_id_shape
        CHECK (salesforce_org_id ~ '^00D[A-Za-z0-9]{15}$'),
      CONSTRAINT tenant_salesforce_authorization_audits_user_id_shape
        CHECK (salesforce_user_id ~ '^005[A-Za-z0-9]{15}$'),
      CONSTRAINT tenant_salesforce_authorization_audits_credential_version
        CHECK (credential_version >= 1)
    )`,
  }),
  Object.freeze({
    id: '0006_publication_attempts',
    sql: `CREATE TABLE tenant_publication_attempts (
      publication_attempt_id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL,
      actor_id varchar(128) NOT NULL,
      salesforce_org_id varchar(18) NOT NULL,
      form_version_id varchar(18) NOT NULL,
      outcome varchar(16) NOT NULL DEFAULT 'started',
      publication_digest char(64),
      xform_version_id varchar(18),
      xlsform_version_id varchar(18),
      failure_code varchar(128),
      salesforce_request_count integer,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      completed_at timestamptz,
      CONSTRAINT tenant_publication_attempts_actor_tenant
        FOREIGN KEY (actor_id, tenant_id)
        REFERENCES tenant_administrator_bindings(actor_id, tenant_id),
      CONSTRAINT tenant_publication_attempts_tenant
        FOREIGN KEY (tenant_id)
        REFERENCES tenant_administrator_tenants(tenant_id),
      CONSTRAINT tenant_publication_attempts_org_shape
        CHECK (salesforce_org_id ~ '^00D[A-Za-z0-9]{15}$'),
      CONSTRAINT tenant_publication_attempts_form_version_shape
        CHECK (form_version_id ~ '^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$'),
      CONSTRAINT tenant_publication_attempts_outcome
        CHECK (outcome IN ('started', 'succeeded', 'failed', 'partial')),
      CONSTRAINT tenant_publication_attempts_digest_shape
        CHECK (publication_digest IS NULL OR publication_digest ~ '^[0-9a-f]{64}$'),
      CONSTRAINT tenant_publication_attempts_xform_shape
        CHECK (xform_version_id IS NULL OR xform_version_id ~ '^068[A-Za-z0-9]{15}$'),
      CONSTRAINT tenant_publication_attempts_xlsform_shape
        CHECK (xlsform_version_id IS NULL OR xlsform_version_id ~ '^068[A-Za-z0-9]{15}$'),
      CONSTRAINT tenant_publication_attempts_request_count
        CHECK (salesforce_request_count IS NULL OR salesforce_request_count >= 0),
      CONSTRAINT tenant_publication_attempts_terminal_shape CHECK (
        (outcome = 'started' AND completed_at IS NULL
          AND publication_digest IS NULL AND xform_version_id IS NULL
          AND xlsform_version_id IS NULL AND failure_code IS NULL
          AND salesforce_request_count IS NULL)
        OR
        (outcome = 'succeeded' AND completed_at IS NOT NULL
          AND publication_digest IS NOT NULL AND xform_version_id IS NULL
          AND xlsform_version_id IS NULL AND failure_code IS NULL
          AND salesforce_request_count IS NOT NULL)
        OR
        (outcome = 'failed' AND completed_at IS NOT NULL
          AND publication_digest IS NULL AND xform_version_id IS NULL
          AND xlsform_version_id IS NULL AND failure_code IS NOT NULL
          AND salesforce_request_count IS NOT NULL)
        OR
        (outcome = 'partial' AND completed_at IS NOT NULL
          AND publication_digest IS NOT NULL AND xform_version_id IS NOT NULL
          AND xlsform_version_id IS NOT NULL AND failure_code IS NOT NULL
          AND salesforce_request_count IS NOT NULL)
      )
    )`,
  }),
]);

export class MigrationError extends Error {
  constructor() {
    super('DATABASE_MIGRATION_FAILED');
    this.name = 'MigrationError';
  }
}

const checksum = (sql: string): string =>
  createHash('sha256').update(sql, 'utf8').digest('hex');

export type MigrationTarget =
  | '0001_tenant_connections'
  | '0002_tenant_oauth_transactions'
  | '0003_administrator_sessions'
  | '0004_administrator_tenants'
  | '0005_salesforce_authorization_audits'
  | '0006_publication_attempts';

/** Apply the checked plan through an optional exact target for upgrade verification. */
export async function applyMigrations(
  pool: Pool,
  through?: MigrationTarget,
): Promise<void> {
  const targetIndex =
    through === undefined
      ? migrations.length - 1
      : migrations.findIndex((migration) => migration.id === through);
  if (targetIndex < 0) throw new MigrationError();
  const client = await pool.connect().catch(() => {
    throw new MigrationError();
  });
  let transaction = false;
  try {
    await client.query('BEGIN');
    transaction = true;
    await client.query('SELECT pg_advisory_xact_lock($1)', [migrationLock]);
    await client.query(`CREATE TABLE IF NOT EXISTS kusanya_schema_migrations (
      migration_id varchar(128) PRIMARY KEY,
      checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`);
    for (const migration of migrations.slice(0, targetIndex + 1)) {
      const digest = checksum(migration.sql);
      const existing = await client.query<{ checksum: string }>(
        `SELECT checksum
         FROM kusanya_schema_migrations
         WHERE migration_id = $1`,
        [migration.id],
      );
      if (existing.rowCount === 1) {
        if (
          existing.rows.length !== 1 ||
          existing.rows[0]!.checksum.trim() !== digest
        )
          throw new MigrationError();
        continue;
      }
      if (existing.rowCount !== 0 || existing.rows.length !== 0)
        throw new MigrationError();
      await client.query(migration.sql);
      await client.query(
        `INSERT INTO kusanya_schema_migrations (migration_id, checksum)
         VALUES ($1, $2)`,
        [migration.id, digest],
      );
    }
    await client.query('COMMIT');
    transaction = false;
  } catch {
    if (transaction) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The fixed migration failure below is authoritative.
      }
    }
    throw new MigrationError();
  } finally {
    client.release();
  }
}
