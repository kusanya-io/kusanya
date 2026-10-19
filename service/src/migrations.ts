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
]);

export class MigrationError extends Error {
  constructor() {
    super('DATABASE_MIGRATION_FAILED');
    this.name = 'MigrationError';
  }
}

const checksum = (sql: string): string =>
  createHash('sha256').update(sql, 'utf8').digest('hex');

export async function applyMigrations(pool: Pool): Promise<void> {
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
    for (const migration of migrations) {
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
