import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import {
  connect as connectTcp,
  createServer as createTcpServer,
  type Server,
} from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { createPostgresPool, createQueryExecutor } from '../../src/database.js';
import { applyMigrations } from '../../src/migrations.js';
import { PublicationAttemptStore } from '../../src/publication/publication-attempt-store.js';
import { AdministratorInvitationStore } from '../../src/tenant/administrator-invitation.js';
import { AdministratorSessionStore } from '../../src/tenant/administrator-session.js';
import {
  normalizeSalesforceOrgId,
  TenantConnectionStore,
} from '../../src/tenant/connection-store.js';
import { createTenantCredentialVault } from '../../src/tenant/credential-vault.js';
import { AdministratorOidcError } from '../../src/tenant/oidc-login.js';
import { TenantOAuthTransactionStore } from '../../src/tenant/oauth-authorization.js';

const databaseUrl = process.env.DATABASE_URL;
const databaseRequired = process.env.REQUIRE_DATABASE_TESTS === 'true';
const externalHost = 'kusanya.test';
const externalOrigin = `https://${externalHost}`;
const accessToken = `${'a'.repeat(24)}.${'b'.repeat(24)}.${'c'.repeat(24)}`;
const formVersionId = 'a0V000000000001EAA';

async function run(
  executable: string,
  arguments_: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly input?: string;
  } = {},
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  const child = spawn(executable, arguments_, {
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.stdin.end(options.input);
  const [code] = (await once(child, 'close')) as [number | null];
  return {
    code,
    stderr: Buffer.concat(stderr).toString('utf8'),
    stdout: Buffer.concat(stdout).toString('utf8'),
  };
}

async function generateCertificate(directory: string): Promise<{
  readonly certificatePath: string;
  readonly key: Buffer;
  readonly certificate: Buffer;
}> {
  const certificatePath = join(directory, `${externalHost}.crt`);
  const keyPath = join(directory, `${externalHost}.key`);
  const executable =
    process.env.OPENSSL_EXECUTABLE ??
    (process.platform === 'win32'
      ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe'
      : 'openssl');
  const generated = await run(executable, [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-sha256',
    '-nodes',
    '-days',
    '1',
    '-subj',
    `/CN=${externalHost}`,
    '-addext',
    `subjectAltName=DNS:${externalHost}`,
    '-keyout',
    keyPath,
    '-out',
    certificatePath,
  ]);
  if (generated.code !== 0) throw new Error('TLS_TEST_CERTIFICATE');
  return {
    certificatePath,
    key: await readFile(keyPath),
    certificate: await readFile(certificatePath),
  };
}

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('TLS_TEST_LISTENER');
  return address.port;
}

async function close(server: Server | undefined): Promise<void> {
  if (server?.listening)
    await new Promise<void>((resolve) => server.close(() => resolve()));
}

function connectProxy(targetPort: number): Server {
  return createTcpServer((client) => {
    let request = Buffer.alloc(0);
    const refuse = (): void => {
      client.destroy();
    };
    client.on('error', () => undefined);
    const onData = (chunk: Buffer): void => {
      request = Buffer.concat([request, chunk]);
      if (request.length > 8192) return refuse();
      const boundary = request.indexOf('\r\n\r\n');
      if (boundary === -1) return;
      client.off('data', onData);
      const header = request.subarray(0, boundary).toString('ascii');
      if (!header.startsWith(`CONNECT ${externalHost}:443 HTTP/1.1\r\n`))
        return refuse();
      const remainder = request.subarray(boundary + 4);
      const target = connectTcp(targetPort, '127.0.0.1');
      target.on('error', refuse);
      target.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (remainder.length > 0) target.write(remainder);
        client.pipe(target);
        target.pipe(client);
      });
    };
    client.on('data', onData);
  });
}

void test(
  'shipped CLI crosses real TLS, composed routes and PostgreSQL without contract drift',
  {
    timeout: 30_000,
    skip:
      !databaseUrl && !databaseRequired
        ? 'Set DATABASE_URL to a disposable PostgreSQL 17 database'
        : false,
  },
  async (context) => {
    assert.ok(databaseUrl);
    const config = readConfig({
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
    });
    const pool = createPostgresPool(config, () => {});
    const executor = createQueryExecutor(pool);
    const tenantId = randomUUID();
    const actorId = `oidc:${randomUUID()}`;
    const orgId = normalizeSalesforceOrgId(
      `00D${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    );
    const sessionConfiguration = Object.freeze({
      sessionSecret: Buffer.alloc(32, 73).toString('base64'),
      ttlSeconds: 900,
    });
    const sessionStore = new AdministratorSessionStore(executor);
    const attemptStore = new PublicationAttemptStore(executor);
    const connectionStore = new TenantConnectionStore(
      executor,
      createTenantCredentialVault({
        activeKeyId: 'test',
        keys: { test: Buffer.alloc(32, 74).toString('base64') },
      }),
    );
    const temporary = await mkdtemp(join(tmpdir(), 'kusanya-publish-cli-'));
    const resources: {
      app?: FastifyInstance;
      proxyServer?: Server;
      tlsServer?: Server;
    } = {};

    context.after(async () => {
      await close(resources.proxyServer);
      await close(resources.tlsServer);
      await resources.app?.close().catch(() => undefined);
      try {
        await pool.query(
          'DELETE FROM administrator_sessions WHERE actor_id = $1',
          [actorId],
        );
        const cleanup = await pool.connect();
        try {
          await cleanup.query('BEGIN');
          await cleanup.query(
            `SELECT set_config(
               'kusanya.publication_retention_actor', $1, true
             )`,
            [actorId],
          );
          await cleanup.query(
            `UPDATE tenant_publication_attempts
             SET completed_at = clock_timestamp() - interval '4000 days'
             WHERE tenant_id = $1 AND outcome = 'failed'`,
            [tenantId],
          );
          await cleanup.query(
            'DELETE FROM tenant_publication_attempts WHERE tenant_id = $1',
            [tenantId],
          );
          await cleanup.query('COMMIT');
        } catch (error) {
          await cleanup.query('ROLLBACK');
          throw error;
        } finally {
          cleanup.release();
        }
        await pool.query(
          'DELETE FROM tenant_publication_attempt_retention_audits WHERE tenant_id = $1',
          [tenantId],
        );
        await pool.query(
          'DELETE FROM tenant_administrator_lifecycle_audits WHERE tenant_id = $1',
          [tenantId],
        );
        await pool.query(
          'DELETE FROM tenant_administrator_bindings WHERE actor_id = $1',
          [actorId],
        );
        await pool.query(
          'DELETE FROM tenant_administrator_tenants WHERE tenant_id = $1',
          [tenantId],
        );
      } finally {
        await pool.end();
        await rm(temporary, { force: true, recursive: true });
      }
    });

    await applyMigrations(pool);
    await sessionStore.bootstrap({
      actorId,
      tenantId,
      expectedSalesforceOrgId: orgId,
      authorizationOrigin: 'https://login.salesforce.com',
      namespacePrefix: '',
    });
    resources.app = createApp(
      config,
      { async ping() {}, async close() {} },
      false,
      {
        administratorIdentity: {
          async verifyLoginRequest(request) {
            if (request.headers.authorization !== `Bearer ${accessToken}`)
              throw new AdministratorOidcError();
            return { actorId };
          },
          actorIdForSubject: (subject) => `oidc:${subject}`,
        },
        sessionStore,
        invitationStore: new AdministratorInvitationStore(executor),
        invitationConfiguration: { ttlSeconds: 3600 },
        sessionConfiguration,
        connectionStore,
        oauthTransactionStore: new TenantOAuthTransactionStore(executor),
        oauthConfiguration: {
          clientId: 'synthetic-client',
          clientSecret: 'synthetic-secret',
          redirectUri: `${externalOrigin}/api/admin/salesforce/callback`,
          stateSecret: Buffer.alloc(32, 75).toString('base64'),
          timeoutMs: 1000,
          transactionTtlSeconds: 300,
        },
        attemptStore,
        publisherConfiguration: {
          clientId: 'synthetic-client',
          clientSecret: 'synthetic-secret',
          refreshTimeoutMs: 1000,
          perRequestTimeoutMs: 1000,
          overallTimeoutMs: 5000,
        },
        validateXForm: async () => ({ ok: true }),
        externalOrigin,
      },
    );
    await resources.app.ready();
    const certificate = await generateCertificate(temporary);
    resources.tlsServer = createHttpsServer(
      { cert: certificate.certificate, key: certificate.key },
      resources.app.routing.bind(resources.app),
    );
    const tlsPort = await listen(resources.tlsServer);
    resources.proxyServer = connectProxy(tlsPort);
    const proxyPort = await listen(resources.proxyServer);
    const executable = fileURLToPath(
      new URL('../../src/publish-definition.js', import.meta.url),
    );
    const childEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
      HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
      http_proxy: `http://127.0.0.1:${proxyPort}`,
      https_proxy: `http://127.0.0.1:${proxyPort}`,
      NODE_EXTRA_CA_CERTS: certificate.certificatePath,
      NO_PROXY: '',
      no_proxy: '',
    };
    const result = await run(
      process.execPath,
      ['--use-env-proxy', executable],
      {
        env: childEnvironment,
        input: JSON.stringify({
          accessToken,
          formVersionId,
          serviceOrigin: externalOrigin,
        }),
      },
    );
    assert.equal(result.code, 1);
    assert.equal(result.stderr, '');
    assert.doesNotMatch(result.stdout, new RegExp(accessToken));
    const output = JSON.parse(result.stdout) as {
      publication: {
        status: string;
        attemptId: string;
        diagnostics: unknown;
        salesforceRequestCount: number;
      };
      sessionCleanup: string;
    };
    assert.deepEqual(output, {
      publication: {
        status: 'rejected',
        attemptId: output.publication.attemptId,
        diagnostics: [
          {
            code: 'TENANT_PUBLICATION_NOT_CONNECTED',
            location: 'publisher',
          },
        ],
        salesforceRequestCount: 0,
      },
      sessionCleanup: 'confirmed',
    });
    assert.deepEqual(
      (
        await pool.query<{
          attempt_id: string;
          failure_code: string;
          outcome: string;
          sessions: number;
        }>(
          `SELECT attempt.publication_attempt_id::text AS attempt_id,
                  attempt.outcome, attempt.failure_code,
                  (SELECT count(*)::integer FROM administrator_sessions
                   WHERE actor_id = $2) AS sessions
           FROM tenant_publication_attempts attempt
           WHERE attempt.tenant_id = $1`,
          [tenantId, actorId],
        )
      ).rows,
      [
        {
          attempt_id: output.publication.attemptId,
          failure_code: 'TENANT_PUBLICATION_NOT_CONNECTED',
          outcome: 'failed',
          sessions: 0,
        },
      ],
    );

    const authenticationFailure = await run(
      process.execPath,
      ['--use-env-proxy', executable],
      {
        env: childEnvironment,
        input: JSON.stringify({
          accessToken: `${'x'.repeat(24)}.${'y'.repeat(24)}.${'z'.repeat(24)}`,
          formVersionId,
          serviceOrigin: externalOrigin,
        }),
      },
    );
    assert.deepEqual(authenticationFailure, {
      code: 2,
      stdout: '',
      stderr: 'Publication CLI failed\n',
    });
  },
);
