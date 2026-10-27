import { Pool } from 'pg';
import type { Config } from './config.js';
import type {
  QueryConnection,
  QueryExecutor,
} from './tenant/connection-store.js';

/** The shared PostgreSQL pool and the Phase 0 operational probe. */
export interface Database {
  ping(): Promise<void>;
  close(): Promise<void>;
}

export function createPostgresPool(
  config: Config,
  onIdleError: () => void,
): Pool {
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
  return pool;
}

/** Adapt pg without exposing its wider Client.connect shape to tenant stores. */
export function createQueryExecutor(pool: Pool): QueryExecutor {
  const query = async <Row>(text: string, values: unknown[] = []) => {
    const result = await pool.query(text, values);
    return { rows: result.rows as Row[], rowCount: result.rowCount };
  };
  return {
    query,
    async connect(): Promise<QueryConnection> {
      const client = await pool.connect();
      return {
        async query<Row>(text: string, values: unknown[] = []) {
          const result = await client.query(text, values);
          return { rows: result.rows as Row[], rowCount: result.rowCount };
        },
        release() {
          client.release();
        },
      };
    },
  };
}

export function createDatabase(
  config: Config,
  onIdleError: () => void,
): Database {
  const pool = createPostgresPool(config, onIdleError);
  return {
    async ping() {
      await pool.query('SELECT 1');
    },
    async close() {
      await pool.end();
    },
  };
}
