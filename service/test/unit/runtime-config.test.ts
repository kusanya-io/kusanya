import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigurationError } from '../../src/config.js';
import { readPublicationSurfaceRuntimeConfig } from '../../src/runtime-config.js';

const valid = {
  ADMIN_EXTERNAL_ORIGIN: 'https://kusanya.example',
  ADMIN_OIDC_ISSUER: 'https://login.microsoftonline.com/tenant-id/v2.0',
  ADMIN_OIDC_AUDIENCE: '11111111-2222-3333-4444-555555555555',
  ADMIN_OIDC_JWKS_URI:
    'https://login.microsoftonline.com/tenant-id/discovery/v2.0/keys',
  ADMIN_SESSION_SECRET: Buffer.alloc(32, 7).toString('base64'),
  ADMIN_SESSION_TTL_SECONDS: '28800',
  TENANT_CREDENTIAL_ACTIVE_KEY_ID: 'current',
  TENANT_CREDENTIAL_KEYS: `current:${Buffer.alloc(32, 8).toString('base64')}`,
  SALESFORCE_OAUTH_CLIENT_ID: 'salesforce-client',
  SALESFORCE_OAUTH_CLIENT_SECRET: 'salesforce-secret',
  SALESFORCE_REFRESH_TIMEOUT_MS: '10000',
  SALESFORCE_REQUEST_TIMEOUT_MS: '10000',
  SALESFORCE_PUBLICATION_TIMEOUT_MS: '120000',
  ODK_VALIDATE_JAVA_EXECUTABLE: '/usr/bin/java',
  ODK_VALIDATE_JAR_PATH: '/opt/kusanya/ODK-Validate-v1.20.0.jar',
};

void test('mounted surface configuration is complete, bounded and immutable', () => {
  const config = readPublicationSurfaceRuntimeConfig(valid);
  assert.equal(config.externalOrigin, valid.ADMIN_EXTERNAL_ORIGIN);
  assert.deepEqual(config.oidc, {
    issuer: valid.ADMIN_OIDC_ISSUER,
    audience: valid.ADMIN_OIDC_AUDIENCE,
    jwksUri: valid.ADMIN_OIDC_JWKS_URI,
  });
  assert.equal(config.session.ttlSeconds, 28800);
  assert.equal(config.publisher.overallTimeoutMs, 120000);
  assert.equal(config.validator.jarPath, valid.ODK_VALIDATE_JAR_PATH);
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.oidc));
  assert.ok(Object.isFrozen(config.session));
});

void test('main runtime refuses every absent guard setting without leaking values', () => {
  for (const name of Object.keys(valid)) {
    const environment = { ...valid } as Record<string, string | undefined>;
    delete environment[name];
    assert.throws(
      () => readPublicationSurfaceRuntimeConfig(environment),
      (error: unknown) =>
        error instanceof ConfigurationError &&
        error.message.includes(name) &&
        !error.message.includes('salesforce-secret'),
      name,
    );
  }
});

void test('mounted runtime refuses malformed secrets, origins, paths and bounds', () => {
  for (const [name, value] of [
    ['ADMIN_EXTERNAL_ORIGIN', 'http://secret.example'],
    ['ADMIN_EXTERNAL_ORIGIN', 'https://secret.example/path'],
    ['ADMIN_SESSION_SECRET', 'secret-value'],
    ['TENANT_CREDENTIAL_KEYS', 'secret-value'],
    ['ADMIN_SESSION_TTL_SECONDS', '59'],
    ['SALESFORCE_REQUEST_TIMEOUT_MS', '30001'],
    ['SALESFORCE_PUBLICATION_TIMEOUT_MS', '9999'],
    ['ODK_VALIDATE_JAVA_EXECUTABLE', 'java'],
    ['ODK_VALIDATE_JAR_PATH', 'secret.jar'],
  ] as const)
    assert.throws(
      () => readPublicationSurfaceRuntimeConfig({ ...valid, [name]: value }),
      (error: unknown) =>
        error instanceof ConfigurationError &&
        error.message.includes(name) &&
        !error.message.includes('secret-value') &&
        !error.message.includes('secret.example'),
    );
});
