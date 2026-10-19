/** Encrypt and authenticate tenant Salesforce credentials with rotatable keys. */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { types } from 'node:util';

const keyIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const canonicalKeyPattern = /^[A-Za-z0-9+/]{43}=$/;
const canonicalBase64Pattern =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const tenantIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const orgIdPattern = /^[A-Za-z0-9]{18}$/;
const tokenPattern = /^[\x21-\x7e]+$/;
const maximumCredentialLength = 4096;
const nonceLength = 12;
const tagLength = 16;

export type TenantCredentialFailureCode =
  | 'TENANT_CREDENTIAL_CONFIGURATION'
  | 'TENANT_CREDENTIAL_INPUT'
  | 'TENANT_CREDENTIAL_DECRYPTION';

export class TenantCredentialError extends Error {
  constructor(readonly code: TenantCredentialFailureCode) {
    super(code);
    this.name = 'TenantCredentialError';
  }
}

export interface TenantCredentialContext {
  readonly tenantId: string;
  readonly salesforceOrgId: string;
}

export interface EncryptedTenantCredential {
  readonly schemaVersion: 1;
  readonly keyId: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly tag: string;
}

export interface TenantCredentialVaultConfiguration {
  readonly activeKeyId: string;
  readonly keys: Readonly<Record<string, string>>;
}

export interface TenantCredentialVault {
  readonly activeKeyId: string;
  seal(
    context: TenantCredentialContext,
    refreshToken: string,
  ): EncryptedTenantCredential;
  open(
    context: TenantCredentialContext,
    encrypted: EncryptedTenantCredential,
  ): string;
  needsRotation(encrypted: EncryptedTenantCredential): boolean;
  rewrap(
    context: TenantCredentialContext,
    encrypted: EncryptedTenantCredential,
  ): EncryptedTenantCredential;
}

export function readTenantCredentialVault(
  env: NodeJS.ProcessEnv = process.env,
): TenantCredentialVault {
  const activeKeyId = env.TENANT_CREDENTIAL_ACTIVE_KEY_ID;
  const serialized = env.TENANT_CREDENTIAL_KEYS;
  if (
    typeof activeKeyId !== 'string' ||
    typeof serialized !== 'string' ||
    serialized.length < 1 ||
    serialized.length > 4096
  )
    fail('TENANT_CREDENTIAL_CONFIGURATION');
  const keys: Record<string, string> = {};
  const entries = serialized.split(',');
  if (entries.length < 1 || entries.length > 8)
    fail('TENANT_CREDENTIAL_CONFIGURATION');
  for (const entry of entries) {
    const separator = entry.indexOf(':');
    if (separator < 1 || entry.indexOf(':', separator + 1) !== -1)
      fail('TENANT_CREDENTIAL_CONFIGURATION');
    const keyId = entry.slice(0, separator);
    const encoded = entry.slice(separator + 1);
    if (
      !keyIdPattern.test(keyId) ||
      !canonicalKeyPattern.test(encoded) ||
      Object.hasOwn(keys, keyId)
    )
      fail('TENANT_CREDENTIAL_CONFIGURATION');
    keys[keyId] = encoded;
  }
  return createTenantCredentialVault({ activeKeyId, keys });
}

function fail(code: TenantCredentialFailureCode): never {
  throw new TenantCredentialError(code);
}

function plainRecord(
  value: unknown,
  code: TenantCredentialFailureCode,
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'),
    )
  )
    fail(code);
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  code: TenantCredentialFailureCode,
): void {
  const actual = Object.keys(value).sort().join(',');
  if (actual !== [...expected].sort().join(',')) fail(code);
}

function canonicalBase64(
  value: unknown,
  expectedBytes: number | undefined,
  code: TenantCredentialFailureCode,
): Buffer {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 8192 ||
    !canonicalBase64Pattern.test(value)
  )
    fail(code);
  const bytes = Buffer.from(value, 'base64');
  if (
    bytes.toString('base64') !== value ||
    (expectedBytes !== undefined && bytes.byteLength !== expectedBytes)
  )
    fail(code);
  return bytes;
}

function contextBytes(value: unknown): Buffer {
  const context = plainRecord(value, 'TENANT_CREDENTIAL_INPUT');
  exactKeys(
    context,
    ['tenantId', 'salesforceOrgId'],
    'TENANT_CREDENTIAL_INPUT',
  );
  if (
    typeof context.tenantId !== 'string' ||
    !tenantIdPattern.test(context.tenantId) ||
    typeof context.salesforceOrgId !== 'string' ||
    !orgIdPattern.test(context.salesforceOrgId)
  )
    fail('TENANT_CREDENTIAL_INPUT');
  return Buffer.from(
    `kusanya:tenant-credential:v1\0${context.tenantId}\0${context.salesforceOrgId}`,
    'utf8',
  );
}

function encryptedEnvelope(value: unknown): EncryptedTenantCredential {
  const envelope = plainRecord(value, 'TENANT_CREDENTIAL_INPUT');
  exactKeys(
    envelope,
    ['schemaVersion', 'keyId', 'nonce', 'ciphertext', 'tag'],
    'TENANT_CREDENTIAL_INPUT',
  );
  if (
    envelope.schemaVersion !== 1 ||
    typeof envelope.keyId !== 'string' ||
    !keyIdPattern.test(envelope.keyId)
  )
    fail('TENANT_CREDENTIAL_INPUT');
  canonicalBase64(envelope.nonce, nonceLength, 'TENANT_CREDENTIAL_INPUT');
  const ciphertext = canonicalBase64(
    envelope.ciphertext,
    undefined,
    'TENANT_CREDENTIAL_INPUT',
  );
  if (
    ciphertext.byteLength < 1 ||
    ciphertext.byteLength > maximumCredentialLength
  )
    fail('TENANT_CREDENTIAL_INPUT');
  canonicalBase64(envelope.tag, tagLength, 'TENANT_CREDENTIAL_INPUT');
  return Object.freeze({
    schemaVersion: 1,
    keyId: envelope.keyId,
    nonce: envelope.nonce as string,
    ciphertext: envelope.ciphertext as string,
    tag: envelope.tag as string,
  });
}

function keyConfiguration(value: unknown): {
  activeKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
} {
  const configuration = plainRecord(value, 'TENANT_CREDENTIAL_CONFIGURATION');
  exactKeys(
    configuration,
    ['activeKeyId', 'keys'],
    'TENANT_CREDENTIAL_CONFIGURATION',
  );
  if (
    typeof configuration.activeKeyId !== 'string' ||
    !keyIdPattern.test(configuration.activeKeyId)
  )
    fail('TENANT_CREDENTIAL_CONFIGURATION');
  const source = plainRecord(
    configuration.keys,
    'TENANT_CREDENTIAL_CONFIGURATION',
  );
  const entries = Object.entries(source);
  if (entries.length < 1 || entries.length > 8)
    fail('TENANT_CREDENTIAL_CONFIGURATION');
  const keys = new Map<string, Buffer>();
  for (const [keyId, encoded] of entries) {
    if (!keyIdPattern.test(keyId) || typeof encoded !== 'string')
      fail('TENANT_CREDENTIAL_CONFIGURATION');
    if (!canonicalKeyPattern.test(encoded))
      fail('TENANT_CREDENTIAL_CONFIGURATION');
    keys.set(
      keyId,
      canonicalBase64(encoded, 32, 'TENANT_CREDENTIAL_CONFIGURATION'),
    );
  }
  if (!keys.has(configuration.activeKeyId))
    fail('TENANT_CREDENTIAL_CONFIGURATION');
  return { activeKeyId: configuration.activeKeyId, keys };
}

export function createTenantCredentialVault(
  configuration: TenantCredentialVaultConfiguration,
): TenantCredentialVault {
  const decoded = keyConfiguration(configuration);
  const activeKeyId = decoded.activeKeyId;

  const open = (
    context: TenantCredentialContext,
    encryptedValue: EncryptedTenantCredential,
  ): string => {
    const aad = contextBytes(context);
    const encrypted = encryptedEnvelope(encryptedValue);
    const key = decoded.keys.get(encrypted.keyId);
    if (!key) fail('TENANT_CREDENTIAL_DECRYPTION');
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        canonicalBase64(
          encrypted.nonce,
          nonceLength,
          'TENANT_CREDENTIAL_DECRYPTION',
        ),
        { authTagLength: tagLength },
      );
      decipher.setAAD(aad);
      decipher.setAuthTag(
        canonicalBase64(
          encrypted.tag,
          tagLength,
          'TENANT_CREDENTIAL_DECRYPTION',
        ),
      );
      const plaintext = Buffer.concat([
        decipher.update(
          canonicalBase64(
            encrypted.ciphertext,
            undefined,
            'TENANT_CREDENTIAL_DECRYPTION',
          ),
        ),
        decipher.final(),
      ]).toString('utf8');
      if (
        plaintext.length < 1 ||
        plaintext.length > maximumCredentialLength ||
        !tokenPattern.test(plaintext)
      )
        fail('TENANT_CREDENTIAL_DECRYPTION');
      return plaintext;
    } catch (error) {
      if (error instanceof TenantCredentialError) throw error;
      fail('TENANT_CREDENTIAL_DECRYPTION');
    }
  };

  const seal = (
    context: TenantCredentialContext,
    refreshToken: string,
  ): EncryptedTenantCredential => {
    const aad = contextBytes(context);
    if (
      typeof refreshToken !== 'string' ||
      refreshToken.length < 1 ||
      refreshToken.length > maximumCredentialLength ||
      !tokenPattern.test(refreshToken)
    )
      fail('TENANT_CREDENTIAL_INPUT');
    const key = decoded.keys.get(activeKeyId)!;
    const nonce = randomBytes(nonceLength);
    const cipher = createCipheriv('aes-256-gcm', key, nonce, {
      authTagLength: tagLength,
    });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([
      cipher.update(refreshToken, 'utf8'),
      cipher.final(),
    ]);
    return Object.freeze({
      schemaVersion: 1,
      keyId: activeKeyId,
      nonce: nonce.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    });
  };

  return Object.freeze({
    activeKeyId,
    seal,
    open,
    needsRotation(encrypted: EncryptedTenantCredential): boolean {
      return encryptedEnvelope(encrypted).keyId !== activeKeyId;
    },
    rewrap(
      context: TenantCredentialContext,
      encrypted: EncryptedTenantCredential,
    ): EncryptedTenantCredential {
      return seal(context, open(context, encrypted));
    },
  });
}
