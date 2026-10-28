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
  Object.freeze({
    id: '0007_publication_attempt_reconciliation',
    sql: `ALTER TABLE tenant_publication_attempts
      ADD COLUMN reconciliation_status varchar(32),
      ADD COLUMN reconciliation_request_count integer,
      ADD COLUMN reconciled_at timestamptz,
      ADD CONSTRAINT tenant_publication_attempts_reconciliation_shape CHECK (
        (reconciliation_status IS NULL
          AND reconciliation_request_count IS NULL
          AND reconciled_at IS NULL)
        OR
        (outcome = 'started'
          AND reconciliation_status = 'indeterminate'
          AND reconciliation_request_count = 0
          AND reconciled_at IS NOT NULL)
        OR
        (outcome = 'partial'
          AND reconciliation_status IN (
            'committed', 'unlinked', 'artifacts_missing'
          )
          AND reconciliation_request_count >= 1
          AND reconciled_at IS NOT NULL)
      )`,
  }),
  Object.freeze({
    id: '0008_administrator_lifecycle',
    sql: `ALTER TABLE tenant_administrator_bindings
      ADD COLUMN active boolean NOT NULL DEFAULT true,
      ADD COLUMN deprovisioned_at timestamptz,
      ADD CONSTRAINT tenant_administrator_bindings_lifecycle CHECK (
        (active AND deprovisioned_at IS NULL)
        OR
        (NOT active AND deprovisioned_at IS NOT NULL)
      );
    CREATE INDEX tenant_administrator_bindings_tenant_actor
      ON tenant_administrator_bindings(tenant_id, actor_id);
    CREATE TABLE tenant_administrator_lifecycle_audits (
      administrator_lifecycle_audit_id bigint
        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      tenant_id uuid NOT NULL
        REFERENCES tenant_administrator_tenants(tenant_id),
      performed_by_actor_id varchar(128) NOT NULL,
      target_actor_id varchar(128) NOT NULL,
      action varchar(16) NOT NULL,
      occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT tenant_administrator_lifecycle_audits_performer
        FOREIGN KEY (performed_by_actor_id, tenant_id)
        REFERENCES tenant_administrator_bindings(actor_id, tenant_id),
      CONSTRAINT tenant_administrator_lifecycle_audits_target
        FOREIGN KEY (target_actor_id, tenant_id)
        REFERENCES tenant_administrator_bindings(actor_id, tenant_id),
      CONSTRAINT tenant_administrator_lifecycle_audits_action
        CHECK (action IN ('bootstrap', 'deprovision')),
      CONSTRAINT tenant_administrator_lifecycle_audits_bootstrap_actor
        CHECK (action <> 'bootstrap' OR performed_by_actor_id = target_actor_id)
    )`,
  }),
  Object.freeze({
    id: '0009_administrator_roles',
    sql: `ALTER TABLE tenant_administrator_bindings
      ADD COLUMN role varchar(16);
    UPDATE tenant_administrator_bindings
      SET role = 'administrator';
    ALTER TABLE tenant_administrator_bindings
      ALTER COLUMN role SET NOT NULL,
      ADD CONSTRAINT tenant_administrator_bindings_role
        CHECK (role IN ('administrator', 'publisher', 'reviewer'));
    CREATE TABLE tenant_administrator_role_audits (
      administrator_role_audit_id bigint
        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      tenant_id uuid NOT NULL
        REFERENCES tenant_administrator_tenants(tenant_id),
      performed_by_actor_id varchar(128) NOT NULL,
      target_actor_id varchar(128) NOT NULL,
      action varchar(16) NOT NULL,
      previous_role varchar(16),
      new_role varchar(16) NOT NULL,
      occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT tenant_administrator_role_audits_performer
        FOREIGN KEY (performed_by_actor_id, tenant_id)
        REFERENCES tenant_administrator_bindings(actor_id, tenant_id),
      CONSTRAINT tenant_administrator_role_audits_target
        FOREIGN KEY (target_actor_id, tenant_id)
        REFERENCES tenant_administrator_bindings(actor_id, tenant_id),
      CONSTRAINT tenant_administrator_role_audits_action
        CHECK (action IN ('enrol', 'change')),
      CONSTRAINT tenant_administrator_role_audits_previous
        CHECK (
          (action = 'enrol' AND previous_role IS NULL)
          OR
          (action = 'change' AND previous_role IS NOT NULL
            AND previous_role <> new_role)
        ),
      CONSTRAINT tenant_administrator_role_audits_roles
        CHECK (
          (previous_role IS NULL OR previous_role IN (
            'administrator', 'publisher', 'reviewer'
          ))
          AND new_role IN ('administrator', 'publisher', 'reviewer')
        )
    )`,
  }),
  Object.freeze({
    id: '0010_administrator_invitations',
    sql: `CREATE TABLE tenant_administrator_invitations (
      invitation_id uuid PRIMARY KEY,
      token_digest char(64) NOT NULL UNIQUE,
      tenant_id uuid NOT NULL
        REFERENCES tenant_administrator_tenants(tenant_id),
      issued_by_actor_id varchar(128) NOT NULL,
      target_actor_id varchar(128) NOT NULL,
      role varchar(16) NOT NULL,
      issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      expires_at timestamptz NOT NULL,
      accepted_at timestamptz,
      accepted_by_actor_id varchar(128),
      revoked_at timestamptz,
      revoked_by_actor_id varchar(128),
      CONSTRAINT tenant_administrator_invitations_issuer
        FOREIGN KEY (issued_by_actor_id, tenant_id)
        REFERENCES tenant_administrator_bindings(actor_id, tenant_id),
      CONSTRAINT tenant_administrator_invitations_accepted_actor
        FOREIGN KEY (accepted_by_actor_id, tenant_id)
        REFERENCES tenant_administrator_bindings(actor_id, tenant_id),
      CONSTRAINT tenant_administrator_invitations_revoker
        FOREIGN KEY (revoked_by_actor_id, tenant_id)
        REFERENCES tenant_administrator_bindings(actor_id, tenant_id),
      CONSTRAINT tenant_administrator_invitations_token
        CHECK (token_digest ~ '^[0-9a-f]{64}$'),
      CONSTRAINT tenant_administrator_invitations_target
        CHECK (target_actor_id ~ '^[A-Za-z0-9:_-]{1,128}$'),
      CONSTRAINT tenant_administrator_invitations_role
        CHECK (role IN ('administrator', 'publisher', 'reviewer')),
      CONSTRAINT tenant_administrator_invitations_expiry
        CHECK (expires_at > issued_at),
      CONSTRAINT tenant_administrator_invitations_terminal_state
        CHECK (
          (accepted_at IS NULL AND accepted_by_actor_id IS NULL)
          OR
          (accepted_at IS NOT NULL
            AND accepted_by_actor_id = target_actor_id
            AND accepted_at <= expires_at)
        ),
      CONSTRAINT tenant_administrator_invitations_revocation_state
        CHECK (
          (revoked_at IS NULL AND revoked_by_actor_id IS NULL)
          OR
          (revoked_at IS NOT NULL AND revoked_by_actor_id IS NOT NULL)
        ),
      CONSTRAINT tenant_administrator_invitations_one_terminal_state
        CHECK (accepted_at IS NULL OR revoked_at IS NULL)
    );
    CREATE FUNCTION kusanya_guard_administrator_invitation_immutable()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.invitation_id IS DISTINCT FROM OLD.invitation_id
        OR NEW.token_digest IS DISTINCT FROM OLD.token_digest
        OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.issued_by_actor_id IS DISTINCT FROM OLD.issued_by_actor_id
        OR NEW.target_actor_id IS DISTINCT FROM OLD.target_actor_id
        OR NEW.role IS DISTINCT FROM OLD.role
        OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
        OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
        OR (OLD.accepted_at IS NOT NULL AND (
          NEW.accepted_at IS DISTINCT FROM OLD.accepted_at
          OR NEW.accepted_by_actor_id IS DISTINCT FROM OLD.accepted_by_actor_id
        ))
        OR (OLD.revoked_at IS NOT NULL AND (
          NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
          OR NEW.revoked_by_actor_id IS DISTINCT FROM OLD.revoked_by_actor_id
        ))
      THEN
        RAISE EXCEPTION 'administrator invitation state is immutable'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER tenant_administrator_invitations_immutable
      BEFORE UPDATE ON tenant_administrator_invitations
      FOR EACH ROW
      EXECUTE FUNCTION kusanya_guard_administrator_invitation_immutable()`,
  }),
  Object.freeze({
    id: '0011_publication_attempt_retention',
    sql: `ALTER TABLE tenant_administrator_tenants
      ADD COLUMN publication_attempt_retention_days smallint
        NOT NULL DEFAULT 90,
      ADD CONSTRAINT tenant_administrator_tenants_attempt_retention
        CHECK (publication_attempt_retention_days BETWEEN 30 AND 3650);
    CREATE TABLE tenant_publication_attempt_retention_audits (
      publication_attempt_retention_audit_id bigint
        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      tenant_id uuid NOT NULL
        REFERENCES tenant_administrator_tenants(tenant_id),
      publication_attempt_id uuid NOT NULL,
      performed_by_actor_id varchar(128) NOT NULL,
      outcome varchar(16) NOT NULL,
      reconciliation_status varchar(32),
      terminal_at timestamptz NOT NULL,
      retention_days smallint NOT NULL,
      deleted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT tenant_publication_attempt_retention_audits_actor
        FOREIGN KEY (performed_by_actor_id, tenant_id)
        REFERENCES tenant_administrator_bindings(actor_id, tenant_id),
      CONSTRAINT tenant_publication_attempt_retention_audits_attempt
        UNIQUE (tenant_id, publication_attempt_id),
      CONSTRAINT tenant_publication_attempt_retention_audits_outcome
        CHECK (outcome IN ('succeeded', 'failed', 'partial')),
      CONSTRAINT tenant_publication_attempt_retention_audits_resolution
        CHECK (
          (outcome IN ('succeeded', 'failed')
            AND reconciliation_status IS NULL)
          OR
          (outcome = 'partial'
            AND reconciliation_status IS NOT NULL
            AND reconciliation_status IN ('committed', 'artifacts_missing'))
        ),
      CONSTRAINT tenant_publication_attempt_retention_audits_days
        CHECK (retention_days BETWEEN 30 AND 3650),
      CONSTRAINT tenant_publication_attempt_retention_audits_time
        CHECK (deleted_at >= terminal_at)
    );
    CREATE FUNCTION kusanya_guard_publication_attempt_retention()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
      retention_actor varchar(128);
      retained_days smallint;
      terminal_time timestamptz;
    BEGIN
      retention_actor := current_setting(
        'kusanya.publication_retention_actor', true
      );
      SELECT tenant.publication_attempt_retention_days
        INTO retained_days
      FROM tenant_administrator_tenants AS tenant
      JOIN tenant_administrator_bindings AS binding
        ON binding.tenant_id = tenant.tenant_id
       AND binding.actor_id = retention_actor
       AND binding.active
       AND binding.role = 'administrator'
      WHERE tenant.tenant_id = OLD.tenant_id;
      terminal_time := COALESCE(OLD.reconciled_at, OLD.completed_at);
      IF retained_days IS NULL
        OR terminal_time IS NULL
        OR terminal_time > clock_timestamp()
          - (retained_days * interval '1 day')
        OR NOT (
          (
            (OLD.outcome IN ('succeeded', 'failed')
              AND OLD.reconciliation_status IS NULL)
            OR
            (OLD.outcome = 'partial'
              AND OLD.reconciliation_status IS NOT NULL
              AND OLD.reconciliation_status IN (
                'committed', 'artifacts_missing'
              ))
          ) IS TRUE
        )
      THEN
        RAISE EXCEPTION 'publication attempt is not retention eligible'
          USING ERRCODE = '23514';
      END IF;
      INSERT INTO tenant_publication_attempt_retention_audits (
        tenant_id, publication_attempt_id, performed_by_actor_id,
        outcome, reconciliation_status, terminal_at, retention_days
      ) VALUES (
        OLD.tenant_id, OLD.publication_attempt_id, retention_actor,
        OLD.outcome, OLD.reconciliation_status, terminal_time, retained_days
      );
      RETURN OLD;
    END;
    $$;
    CREATE TRIGGER tenant_publication_attempts_retention_guard
      BEFORE DELETE ON tenant_publication_attempts
      FOR EACH ROW
      EXECUTE FUNCTION kusanya_guard_publication_attempt_retention()`,
  }),
  Object.freeze({
    id: '0012_bootstrap_uniqueness',
    sql: `DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM tenant_administrator_lifecycle_audits
        WHERE action = 'bootstrap'
        GROUP BY tenant_id
        HAVING count(*) > 1
      ) THEN
        RAISE EXCEPTION 'duplicate tenant bootstrap audits require operator review'
          USING ERRCODE = '23514';
      END IF;
    END;
    $$;
    CREATE UNIQUE INDEX kusanya_one_bootstrap_per_tenant
      ON tenant_administrator_lifecycle_audits (tenant_id)
      WHERE action = 'bootstrap'`,
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
  | '0006_publication_attempts'
  | '0007_publication_attempt_reconciliation'
  | '0008_administrator_lifecycle'
  | '0009_administrator_roles'
  | '0010_administrator_invitations'
  | '0011_publication_attempt_retention'
  | '0012_bootstrap_uniqueness';

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
