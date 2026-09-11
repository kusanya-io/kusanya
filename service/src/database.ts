import { Pool } from 'pg';
import type { Config } from './config.js';

/** The Phase 0 operational probe. Tenant repositories and migrations come later. */
export interface Database {
  ping(): Promise<void>;
  close(): Promise<void>;
}

export function createDatabase(
  config: Config,
  onIdleError: () => void,
): Database {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: config.databaseSsl ? { rejectUnauthorized: true } : false,
    max: config.databasePoolMax,
    connectionTimeoutMillis: config.databaseTimeoutMs,
    query_timeout: config.databaseTimeoutMs,
    statement_timeout: config.databaseTimeoutMs,
    idleTimeoutMillis: 10000,
    application_name: 'kusanya-service',
  });
  // Idle clients can fail outside a query. Never log raw driver errors or URLs.
  pool.on('error', onIdleError);
  return {
    async ping() {
      await pool.query('SELECT 1');
    },
    async close() {
      await pool.end();
    },
  };
}
