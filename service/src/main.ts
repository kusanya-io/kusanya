import { createApp } from './app.js';
import { ConfigurationError, readConfig } from './config.js';
import { createDatabase } from './database.js';

async function main(): Promise<void> {
  const config = readConfig();
  const database = createDatabase(config, () => {
    process.stderr.write('Database connection became unavailable\n');
  });
  const app = createApp(config, database);
  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => process.exit(1), 10000);
    deadline.unref();
    try {
      await app.close();
    } catch {
      process.stderr.write('Service shutdown failed\n');
      process.exitCode = 1;
    } finally {
      clearTimeout(deadline);
    }
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch {
    await shutdown();
    throw new Error('Service startup failed');
  }
}
void main().catch((error: unknown) => {
  process.stderr.write(
    error instanceof ConfigurationError
      ? `${error.message}\n`
      : 'Service startup failed\n',
  );
  process.exitCode = 1;
});
