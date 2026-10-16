import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createTenantCredentialVault,
  readTenantCredentialVault,
  TenantCredentialError,
} from '../../src/tenant/credential-vault.js';
import { normalizeSalesforceOrgId } from '../../src/tenant/connection-store.js';

const firstKey = Buffer.alloc(32, 17).toString('base64');
const secondKey = Buffer.alloc(32, 29).toString('base64');
const context = Object.freeze({
  tenantId: 'a0000000-0000-4000-8000-000000000001',
  salesforceOrgId: normalizeSalesforceOrgId('00D000000000001'),
});

void test('credentials are authenticated, tenant-bound and nondeterministically encrypted', () => {
  const vault = createTenantCredentialVault({
    activeKeyId: 'local-v1',
    keys: { 'local-v1': firstKey },
  });
  const secret = 'synthetic-refresh-token';
  const first = vault.seal(context, secret);
  const second = vault.seal(context, secret);
  assert.equal(vault.open(context, first), secret);
  assert.equal(vault.open(context, second), secret);
  assert.notEqual(first.nonce, second.nonce);
  assert.notEqual(first.ciphertext, secret);
  assert.doesNotMatch(JSON.stringify(first), /synthetic-refresh-token/);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(vault));

  for (const changed of [
    { ...context, tenantId: '20000000-0000-4000-8000-000000000002' },
    {
      ...context,
      salesforceOrgId: normalizeSalesforceOrgId('00D000000000002'),
    },
  ])
    assert.throws(
      () => vault.open(changed, first),
      (error: unknown) =>
        error instanceof TenantCredentialError &&
        error.code === 'TENANT_CREDENTIAL_DECRYPTION' &&
        !error.message.includes(secret),
    );
});

void test('old keys decrypt only while present and rewrap under the active key', () => {
  const oldVault = createTenantCredentialVault({
    activeKeyId: 'key-2026-01',
    keys: { 'key-2026-01': firstKey },
  });
  const oldEnvelope = oldVault.seal(context, 'rotating-refresh-token');
  const rotatingVault = createTenantCredentialVault({
    activeKeyId: 'key-2026-02',
    keys: {
      'key-2026-01': firstKey,
      'key-2026-02': secondKey,
    },
  });
  assert.equal(rotatingVault.needsRotation(oldEnvelope), true);
  const rewrapped = rotatingVault.rewrap(context, oldEnvelope);
  assert.equal(rewrapped.keyId, 'key-2026-02');
  assert.equal(rotatingVault.needsRotation(rewrapped), false);
  assert.equal(
    rotatingVault.open(context, rewrapped),
    'rotating-refresh-token',
  );

  const retiredVault = createTenantCredentialVault({
    activeKeyId: 'key-2026-02',
    keys: { 'key-2026-02': secondKey },
  });
  assert.throws(
    () => retiredVault.open(context, oldEnvelope),
    /TENANT_CREDENTIAL_DECRYPTION/,
  );
  assert.equal(retiredVault.open(context, rewrapped), 'rotating-refresh-token');
});

void test('deployment keyrings parse bounded environment settings without secret reflection', () => {
  const vault = readTenantCredentialVault({
    TENANT_CREDENTIAL_ACTIVE_KEY_ID: 'current',
    TENANT_CREDENTIAL_KEYS: `previous:${firstKey},current:${secondKey}`,
  });
  assert.equal(vault.activeKeyId, 'current');
  const encrypted = vault.seal(context, 'environment-refresh-token');
  assert.equal(encrypted.keyId, 'current');
  assert.equal(vault.open(context, encrypted), 'environment-refresh-token');

  const secret = 'do-not-reflect-key-material';
  for (const env of [
    {},
    { TENANT_CREDENTIAL_ACTIVE_KEY_ID: 'current' },
    {
      TENANT_CREDENTIAL_ACTIVE_KEY_ID: 'current',
      TENANT_CREDENTIAL_KEYS: `current:${secondKey},current:${secondKey}`,
    },
    {
      TENANT_CREDENTIAL_ACTIVE_KEY_ID: 'missing',
      TENANT_CREDENTIAL_KEYS: `current:${secondKey}`,
    },
    {
      TENANT_CREDENTIAL_ACTIVE_KEY_ID: 'current',
      TENANT_CREDENTIAL_KEYS: `current:${secret}`,
    },
  ])
    assert.throws(
      () => readTenantCredentialVault(env),
      (error: unknown) =>
        error instanceof TenantCredentialError &&
        error.code === 'TENANT_CREDENTIAL_CONFIGURATION' &&
        !error.message.includes(secret),
    );
});

void test('configuration, context, tokens and envelopes fail closed without reflection', () => {
  const secret = 'do-not-reflect-this-secret';
  for (const configuration of [
    { activeKeyId: 'missing', keys: {} },
    { activeKeyId: 'bad key', keys: { 'bad key': firstKey } },
    { activeKeyId: 'key', keys: { key: firstKey.slice(1) } },
    { activeKeyId: 'key', keys: { key: `${firstKey}x` } },
    { activeKeyId: 'key', keys: { key: secret } },
  ])
    assert.throws(
      () => createTenantCredentialVault(configuration),
      (error: unknown) =>
        error instanceof TenantCredentialError &&
        error.code === 'TENANT_CREDENTIAL_CONFIGURATION' &&
        !error.message.includes(secret),
    );

  const vault = createTenantCredentialVault({
    activeKeyId: 'key',
    keys: { key: firstKey },
  });
  for (const invalid of ['', 'contains a space', 'x'.repeat(4097)])
    assert.throws(
      () => vault.seal(context, invalid),
      /TENANT_CREDENTIAL_INPUT/,
    );
  assert.throws(
    () =>
      vault.seal(
        { ...context, tenantId: context.tenantId.toUpperCase() },
        secret,
      ),
    (error: unknown) =>
      error instanceof TenantCredentialError && !error.message.includes(secret),
  );

  const encrypted = vault.seal(context, secret);
  for (const damaged of [
    { ...encrypted, schemaVersion: 2 },
    { ...encrypted, nonce: encrypted.nonce.slice(1) },
    { ...encrypted, ciphertext: `${encrypted.ciphertext}=` },
    { ...encrypted, tag: Buffer.alloc(16).toString('base64') },
    { ...encrypted, extra: secret },
  ])
    assert.throws(
      () => vault.open(context, damaged as typeof encrypted),
      (error: unknown) =>
        error instanceof TenantCredentialError &&
        !error.message.includes(secret),
    );
});

void test('accessor and proxy configuration is rejected without invocation', () => {
  let reads = 0;
  const accessor = {} as Record<string, unknown>;
  Object.defineProperty(accessor, 'activeKeyId', {
    enumerable: true,
    get() {
      reads++;
      return 'key';
    },
  });
  Object.defineProperty(accessor, 'keys', {
    enumerable: true,
    value: { key: firstKey },
  });
  assert.throws(
    () => createTenantCredentialVault(accessor as never),
    /TENANT_CREDENTIAL_CONFIGURATION/,
  );
  assert.equal(reads, 0);
  assert.throws(
    () =>
      createTenantCredentialVault(
        new Proxy({ activeKeyId: 'key', keys: { key: firstKey } }, {}),
      ),
    /TENANT_CREDENTIAL_CONFIGURATION/,
  );
});
