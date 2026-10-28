/** Fail-closed production settings for the mounted administrator surface. */
import { isAbsolute } from 'node:path';
import { ConfigurationError } from './config.js';
import type { TenantSalesforcePublisherConfiguration } from './publication/tenant-salesforce-publisher.js';
import type { OdkValidateConfiguration } from './publication/odk-validate.js';
import type { AdministratorSessionConfiguration } from './tenant/administrator-session.js';
import type { AdministratorInvitationConfiguration } from './tenant/administrator-invitation.js';
import {
  readTenantCredentialVault,
  type TenantCredentialVault,
} from './tenant/credential-vault.js';
import type { AdministratorOidcConfiguration } from './tenant/oidc-login.js';

export interface PublicationSurfaceRuntimeConfig {
  readonly externalOrigin: string;
  readonly oidc: AdministratorOidcConfiguration;
  readonly session: AdministratorSessionConfiguration;
  readonly invitation: AdministratorInvitationConfiguration;
  readonly publisher: TenantSalesforcePublisherConfiguration;
  readonly validator: OdkValidateConfiguration;
  readonly credentialVault: TenantCredentialVault;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.length < 1)
    throw new ConfigurationError(name);
  return value;
}

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const raw = required(env, name);
  if (!/^\d+$/.test(raw)) throw new ConfigurationError(name);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new ConfigurationError(name);
  return value;
}

function exactHttpsOrigin(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== 'https:' ||
      parsed.origin !== value ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.port !== ''
    )
      throw new Error();
  } catch {
    throw new ConfigurationError(name);
  }
  return value;
}

function sessionSecret(env: NodeJS.ProcessEnv): string {
  const value = required(env, 'ADMIN_SESSION_SECRET');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== value)
    throw new ConfigurationError('ADMIN_SESSION_SECRET');
  return value;
}

function absolutePath(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  if (!isAbsolute(value)) throw new ConfigurationError(name);
  return value;
}

/** Read every setting needed before any administrator route can be mounted. */
export function readPublicationSurfaceRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): PublicationSurfaceRuntimeConfig {
  const perRequestTimeoutMs = integer(
    env,
    'SALESFORCE_REQUEST_TIMEOUT_MS',
    1,
    30_000,
  );
  const overallTimeoutMs = integer(
    env,
    'SALESFORCE_PUBLICATION_TIMEOUT_MS',
    perRequestTimeoutMs,
    120_000,
  );
  required(env, 'TENANT_CREDENTIAL_ACTIVE_KEY_ID');
  required(env, 'TENANT_CREDENTIAL_KEYS');
  let credentialVault: TenantCredentialVault;
  try {
    credentialVault = readTenantCredentialVault(env);
  } catch {
    throw new ConfigurationError('TENANT_CREDENTIAL_KEYS');
  }
  return Object.freeze({
    externalOrigin: exactHttpsOrigin(env, 'ADMIN_EXTERNAL_ORIGIN'),
    oidc: Object.freeze({
      issuer: required(env, 'ADMIN_OIDC_ISSUER'),
      audience: required(env, 'ADMIN_OIDC_AUDIENCE'),
      jwksUri: required(env, 'ADMIN_OIDC_JWKS_URI'),
    }),
    session: Object.freeze({
      sessionSecret: sessionSecret(env),
      ttlSeconds: integer(env, 'ADMIN_SESSION_TTL_SECONDS', 60, 86_400),
    }),
    invitation: Object.freeze({
      ttlSeconds: integer(env, 'ADMIN_INVITATION_TTL_SECONDS', 300, 604_800),
    }),
    publisher: Object.freeze({
      clientId: required(env, 'SALESFORCE_OAUTH_CLIENT_ID'),
      clientSecret: required(env, 'SALESFORCE_OAUTH_CLIENT_SECRET'),
      refreshTimeoutMs: integer(
        env,
        'SALESFORCE_REFRESH_TIMEOUT_MS',
        1,
        30_000,
      ),
      perRequestTimeoutMs,
      overallTimeoutMs,
    }),
    validator: Object.freeze({
      javaExecutable: absolutePath(env, 'ODK_VALIDATE_JAVA_EXECUTABLE'),
      jarPath: absolutePath(env, 'ODK_VALIDATE_JAR_PATH'),
    }),
    credentialVault,
  });
}
