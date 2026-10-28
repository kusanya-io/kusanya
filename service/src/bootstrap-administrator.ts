/** Server-only, one-shot bootstrap for the first administrator of a tenant. */
import { TextDecoder } from 'node:util';
import { ConfigurationError, readConfig } from './config.js';
import { createPostgresPool, createQueryExecutor } from './database.js';
import {
  AdministratorSessionError,
  AdministratorSessionStore,
  type AdministratorProvisioningInput,
} from './tenant/administrator-session.js';
import {
  administratorOidcActorId,
  AdministratorOidcError,
} from './tenant/oidc-login.js';

const maximumInputBytes = 16_384;

interface BootstrapDocument {
  readonly subject: unknown;
  readonly tenantId: unknown;
  readonly expectedSalesforceOrgId: unknown;
  readonly authorizationOrigin: unknown;
  readonly namespacePrefix: unknown;
}

function bootstrapDocument(value: unknown): BootstrapDocument {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new AdministratorSessionError('ADMINISTRATOR_SESSION_INPUT');
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).sort().join(',') !==
    [
      'authorizationOrigin',
      'expectedSalesforceOrgId',
      'namespacePrefix',
      'subject',
      'tenantId',
    ].join(',')
  )
    throw new AdministratorSessionError('ADMINISTRATOR_SESSION_INPUT');
  return input as unknown as BootstrapDocument;
}

async function readBoundedInput(
  input: AsyncIterable<Buffer | string>,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    size += bytes.length;
    if (size > maximumInputBytes)
      throw new AdministratorSessionError('ADMINISTRATOR_SESSION_INPUT');
    chunks.push(bytes);
  }
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
    ) as unknown;
  } catch {
    throw new AdministratorSessionError('ADMINISTRATOR_SESSION_INPUT');
  }
}

/** Decode stdin only; no bootstrap tuple is accepted through HTTP or argv. */
export async function bootstrapAdministratorFromInput(
  input: AsyncIterable<Buffer | string>,
  issuer: string,
  store: Pick<AdministratorSessionStore, 'bootstrap'>,
): Promise<void> {
  const document = bootstrapDocument(await readBoundedInput(input));
  if (typeof document.subject !== 'string')
    throw new AdministratorSessionError('ADMINISTRATOR_SESSION_INPUT');
  const provisioning: AdministratorProvisioningInput = {
    actorId: administratorOidcActorId(issuer, document.subject),
    tenantId: document.tenantId as string,
    expectedSalesforceOrgId: document.expectedSalesforceOrgId as string,
    authorizationOrigin: document.authorizationOrigin as string,
    namespacePrefix: document.namespacePrefix as string,
  };
  await store.bootstrap(provisioning);
}

async function main(): Promise<void> {
  const config = readConfig();
  const issuer = process.env.ADMIN_OIDC_ISSUER;
  if (issuer === undefined || issuer.length === 0)
    throw new ConfigurationError('ADMIN_OIDC_ISSUER');
  const pool = createPostgresPool(config, () => {});
  try {
    await bootstrapAdministratorFromInput(
      process.stdin,
      issuer,
      new AdministratorSessionStore(createQueryExecutor(pool)),
    );
    process.stdout.write('Administrator bootstrapped\n');
  } finally {
    await pool.end().catch(() => undefined);
  }
}

if (process.argv[1]?.endsWith('bootstrap-administrator.js'))
  void main().catch((error: unknown) => {
    process.stderr.write(
      error instanceof ConfigurationError
        ? `${error.message}\n`
        : error instanceof AdministratorSessionError ||
            error instanceof AdministratorOidcError
          ? 'Administrator bootstrap refused\n'
          : 'Administrator bootstrap failed\n',
    );
    process.exitCode = 1;
  });
