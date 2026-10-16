import { ConfigurationError, readConfig } from './config.js';
import { createPostgresPool } from './database.js';
import { applyMigrations, MigrationError } from './migrations.js';

async function main(): Promise<void> {
  const config = readConfig();
  const pool = createPostgresPool(config, () => {});
  try {
    await applyMigrations(pool);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    error instanceof ConfigurationError
      ? `${error.message}\n`
      : error instanceof MigrationError
        ? `${error.message}\n`
        : 'Database migration failed\n',
  );
  process.exitCode = 1;
});
