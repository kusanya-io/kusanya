import { createApp } from './app.js';
import { ConfigurationError, readConfig } from './config.js';
import { createPostgresPool, createQueryExecutor } from './database.js';
import { createOdkValidateValidator } from './publication/odk-validate.js';
import { PublicationAttemptStore } from './publication/publication-attempt-store.js';
import { readPublicationSurfaceRuntimeConfig } from './runtime-config.js';
import { AdministratorSessionStore } from './tenant/administrator-session.js';
import { AdministratorInvitationStore } from './tenant/administrator-invitation.js';
import { TenantConnectionStore } from './tenant/connection-store.js';
import { createAdministratorOidcIdentity } from './tenant/oidc-login.js';

async function main(): Promise<void> {
  const config = readConfig();
  const runtime = readPublicationSurfaceRuntimeConfig();
  const administratorIdentity = createAdministratorOidcIdentity(runtime.oidc);
  const pool = createPostgresPool(config, () => {
    process.stderr.write('Database connection became unavailable\n');
  });
  const database = {
    async ping() {
      await pool.query('SELECT 1');
    },
    async close() {
      await pool.end();
    },
  };
  const executor = createQueryExecutor(pool);
  const sessionStore = new AdministratorSessionStore(executor);
  const invitationStore = new AdministratorInvitationStore(executor);
  const attemptStore = new PublicationAttemptStore(executor);
  const app = createApp(config, database, true, {
    administratorIdentity,
    sessionStore,
    invitationStore,
    invitationConfiguration: runtime.invitation,
    sessionConfiguration: runtime.session,
    connectionStore: new TenantConnectionStore(
      executor,
      runtime.credentialVault,
    ),
    attemptStore,
    publisherConfiguration: runtime.publisher,
    validateXForm: createOdkValidateValidator(runtime.validator),
    externalOrigin: runtime.externalOrigin,
  });
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
