/** One-time Salesforce administrator authorization-code + PKCE boundary. */
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { types } from 'node:util';
import { createSalesforceNames } from '../salesforce-names.js';
import {
  normalizeSalesforceOrgId,
  type QueryExecutor,
  type TenantConnectionStore,
} from './connection-store.js';

const tenantIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const statePattern = /^[A-Za-z0-9_-]{43}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const tokenPattern = /^[\x21-\x7e]+$/;
const userIdPattern = /^005[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;
const maximumBodyBytes = 65_536;

export type TenantOAuthFailureCode =
  | 'TENANT_OAUTH_INPUT'
  | 'TENANT_OAUTH_STORAGE'
  | 'TENANT_OAUTH_STATE'
  | 'TENANT_OAUTH_PROVIDER'
  | 'TENANT_OAUTH_BINDING'
  | 'TENANT_OAUTH_CONNECTION';

export class TenantOAuthError extends Error {
  constructor(readonly code: TenantOAuthFailureCode) {
    super(code);
    this.name = 'TenantOAuthError';
  }
}

export interface TenantOAuthConfiguration {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  /** Canonical base64 for exactly 32 deployment-secret bytes. */
  readonly stateSecret: string;
  readonly timeoutMs: number;
  readonly transactionTtlSeconds: number;
}

export interface StartTenantAuthorizationInput {
  readonly trustedTenantId: string;
  readonly expectedSalesforceOrgId: string;
  readonly authorizationOrigin: string;
  readonly namespacePrefix: string;
}

export interface TenantAuthorizationStart {
  readonly authorizationUrl: string;
}

export type TenantAuthorizationCallback =
  | Readonly<{ state: string; code: string }>
  | Readonly<{ state: string; error: string }>;

export interface TenantAuthorizationResult {
  readonly tenantId: string;
  readonly salesforceOrgId: string;
  /** Salesforce user that granted the tenant connection; retained for audit composition. */
  readonly salesforceUserId: string;
  readonly instanceOrigin: string;
  readonly namespacePrefix: string;
  readonly credentialVersion: number;
}

interface OAuthTransaction {
  readonly tenantId: string;
  readonly expectedSalesforceOrgId: string;
  readonly authorizationOrigin: string;
  readonly namespacePrefix: string;
}

interface OAuthTransactionRow {
  tenant_id: unknown;
  expected_salesforce_org_id: unknown;
  authorization_origin: unknown;
  namespace_prefix: unknown;
}

interface DecodedConfiguration {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  stateSecret: Buffer;
  timeoutMs: number;
  transactionTtlSeconds: number;
}

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function fail(code: TenantOAuthFailureCode): never {
  throw new TenantOAuthError(code);
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail('TENANT_OAUTH_INPUT');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'),
    )
  )
    fail('TENANT_OAUTH_INPUT');
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
}

function exactKeys(value: Record<string, unknown>, expected: string[]): void {
  if (Object.keys(value).sort().join(',') !== expected.sort().join(','))
    fail('TENANT_OAUTH_INPUT');
}

function boundedToken(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    !tokenPattern.test(value)
  )
    fail('TENANT_OAUTH_INPUT');
  return value;
}

function tenantId(value: unknown): string {
  if (typeof value !== 'string' || !tenantIdPattern.test(value))
    fail('TENANT_OAUTH_INPUT');
  return value;
}

function salesforceOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048)
    fail('TENANT_OAUTH_INPUT');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail('TENANT_OAUTH_INPUT');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.origin !== value ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    !parsed.hostname.endsWith('.salesforce.com')
  )
    fail('TENANT_OAUTH_INPUT');
  return parsed.origin;
}

function exactHttpsUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048)
    fail('TENANT_OAUTH_INPUT');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail('TENANT_OAUTH_INPUT');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.href !== value ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hash !== ''
  )
    fail('TENANT_OAUTH_INPUT');
  return parsed.href;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    fail('TENANT_OAUTH_INPUT');
  return value;
}

function configuration(value: unknown): DecodedConfiguration {
  const input = plainRecord(value);
  exactKeys(input, [
    'clientId',
    'clientSecret',
    'redirectUri',
    'stateSecret',
    'timeoutMs',
    'transactionTtlSeconds',
  ]);
  const encoded = boundedToken(input.stateSecret, 64);
  let stateSecret: Buffer;
  try {
    stateSecret = Buffer.from(encoded, 'base64');
  } catch {
    fail('TENANT_OAUTH_INPUT');
  }
  if (stateSecret.length !== 32 || stateSecret.toString('base64') !== encoded)
    fail('TENANT_OAUTH_INPUT');
  return {
    clientId: boundedToken(input.clientId, 256),
    clientSecret: boundedToken(input.clientSecret, 4096),
    redirectUri: exactHttpsUrl(input.redirectUri),
    stateSecret,
    timeoutMs: integer(input.timeoutMs, 1, 30_000),
    transactionTtlSeconds: integer(input.transactionTtlSeconds, 60, 900),
  };
}

function startInput(value: unknown): OAuthTransaction {
  const input = plainRecord(value);
  exactKeys(input, [
    'authorizationOrigin',
    'expectedSalesforceOrgId',
    'namespacePrefix',
    'trustedTenantId',
  ]);
  if (typeof input.namespacePrefix !== 'string') fail('TENANT_OAUTH_INPUT');
  try {
    createSalesforceNames(input.namespacePrefix);
  } catch {
    fail('TENANT_OAUTH_INPUT');
  }
  let expectedSalesforceOrgId: string;
  try {
    expectedSalesforceOrgId = normalizeSalesforceOrgId(
      input.expectedSalesforceOrgId,
    );
  } catch {
    fail('TENANT_OAUTH_INPUT');
  }
  return {
    tenantId: tenantId(input.trustedTenantId),
    expectedSalesforceOrgId,
    authorizationOrigin: salesforceOrigin(input.authorizationOrigin),
    namespacePrefix: input.namespacePrefix,
  };
}

function callback(value: unknown): TenantAuthorizationCallback {
  const input = plainRecord(value);
  const keys = Object.keys(input).sort().join(',');
  if (keys !== 'code,state' && keys !== 'error,state')
    fail('TENANT_OAUTH_INPUT');
  if (typeof input.state !== 'string' || !statePattern.test(input.state))
    fail('TENANT_OAUTH_INPUT');
  return keys === 'code,state'
    ? { state: input.state, code: boundedToken(input.code, 4096) }
    : { state: input.state, error: boundedToken(input.error, 256) };
}

function stateDigest(state: string): string {
  return createHash('sha256').update(state, 'ascii').digest('hex');
}

function codeVerifier(secret: Buffer, state: string): string {
  return createHmac('sha256', secret)
    .update('kusanya:tenant-oauth-pkce:v1\0', 'utf8')
    .update(state, 'ascii')
    .digest('base64url');
}

function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

function decodeTransaction(row: OAuthTransactionRow): OAuthTransaction {
  try {
    if (row === null || typeof row !== 'object' || types.isProxy(row))
      fail('TENANT_OAUTH_STORAGE');
    if (typeof row.namespace_prefix !== 'string') fail('TENANT_OAUTH_STORAGE');
    createSalesforceNames(row.namespace_prefix);
    return {
      tenantId: tenantId(row.tenant_id),
      expectedSalesforceOrgId: normalizeSalesforceOrgId(
        row.expected_salesforce_org_id,
      ),
      authorizationOrigin: salesforceOrigin(row.authorization_origin),
      namespacePrefix: row.namespace_prefix,
    };
  } catch {
    fail('TENANT_OAUTH_STORAGE');
  }
}

export class TenantOAuthTransactionStore {
  constructor(private readonly database: QueryExecutor) {}

  async begin(
    digest: string,
    transaction: OAuthTransaction,
    ttlSeconds: number,
  ): Promise<void> {
    if (!digestPattern.test(digest)) fail('TENANT_OAUTH_INPUT');
    const decoded = startInput({
      trustedTenantId: transaction.tenantId,
      expectedSalesforceOrgId: transaction.expectedSalesforceOrgId,
      authorizationOrigin: transaction.authorizationOrigin,
      namespacePrefix: transaction.namespacePrefix,
    });
    const ttl = integer(ttlSeconds, 60, 900);
    try {
      const result = await this.database.query(
        `INSERT INTO tenant_oauth_transactions (
           state_digest, tenant_id, expected_salesforce_org_id,
           authorization_origin, namespace_prefix, expires_at
         ) VALUES ($1, $2::uuid, $3, $4, $5,
                   clock_timestamp() + ($6 * interval '1 second'))
         ON CONFLICT (tenant_id) DO UPDATE SET
           state_digest = EXCLUDED.state_digest,
           expected_salesforce_org_id = EXCLUDED.expected_salesforce_org_id,
           authorization_origin = EXCLUDED.authorization_origin,
           namespace_prefix = EXCLUDED.namespace_prefix,
           expires_at = EXCLUDED.expires_at,
           created_at = clock_timestamp()`,
        [
          digest,
          decoded.tenantId,
          decoded.expectedSalesforceOrgId,
          decoded.authorizationOrigin,
          decoded.namespacePrefix,
          ttl,
        ],
      );
      if (result.rowCount !== 1) fail('TENANT_OAUTH_STORAGE');
    } catch (error) {
      if (error instanceof TenantOAuthError) throw error;
      fail('TENANT_OAUTH_STORAGE');
    }
  }

  async consume(digest: string): Promise<OAuthTransaction | undefined> {
    if (!digestPattern.test(digest)) fail('TENANT_OAUTH_INPUT');
    let result;
    try {
      result = await this.database.query<OAuthTransactionRow>(
        `WITH consumed AS (
           DELETE FROM tenant_oauth_transactions
           WHERE state_digest = $1
           RETURNING tenant_id, expected_salesforce_org_id,
                     authorization_origin, namespace_prefix, expires_at
         )
         SELECT tenant_id, expected_salesforce_org_id,
                authorization_origin, namespace_prefix
         FROM consumed
         WHERE expires_at > clock_timestamp()`,
        [digest],
      );
    } catch {
      fail('TENANT_OAUTH_STORAGE');
    }
    if (result.rowCount === 0 && result.rows.length === 0) return undefined;
    if (result.rowCount !== 1 || result.rows.length !== 1)
      fail('TENANT_OAUTH_STORAGE');
    return decodeTransaction(result.rows[0]!);
  }
}

export async function beginTenantSalesforceAuthorization(
  store: Pick<TenantOAuthTransactionStore, 'begin'>,
  inputValue: StartTenantAuthorizationInput,
  configurationValue: TenantOAuthConfiguration,
): Promise<TenantAuthorizationStart> {
  if (
    store === null ||
    typeof store !== 'object' ||
    typeof store.begin !== 'function'
  )
    fail('TENANT_OAUTH_INPUT');
  const input = startInput(inputValue);
  const decoded = configuration(configurationValue);
  const state = randomBytes(32).toString('base64url');
  const verifier = codeVerifier(decoded.stateSecret, state);
  await store.begin(stateDigest(state), input, decoded.transactionTtlSeconds);
  const authorization = new URL(
    '/services/oauth2/authorize',
    input.authorizationOrigin,
  );
  authorization.search = new URLSearchParams({
    response_type: 'code',
    client_id: decoded.clientId,
    redirect_uri: decoded.redirectUri,
    scope: 'api refresh_token',
    state,
    code_challenge: codeChallenge(verifier),
    code_challenge_method: 'S256',
  }).toString();
  return Object.freeze({ authorizationUrl: authorization.href });
}

async function boundedBytes(
  response: Response,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const length = response.headers.get('content-length');
  if (
    length !== null &&
    (!/^\d+$/.test(length) || Number(length) > maximumBodyBytes)
  )
    fail('TENANT_OAUTH_PROVIDER');
  if (response.body === null) fail('TENANT_OAUTH_PROVIDER');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) fail('TENANT_OAUTH_PROVIDER');
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maximumBodyBytes) fail('TENANT_OAUTH_PROVIDER');
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function providerRecord(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail('TENANT_OAUTH_PROVIDER');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'),
    )
  )
    fail('TENANT_OAUTH_PROVIDER');
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
}

function providerToken(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 4096 ||
    !tokenPattern.test(value)
  )
    fail('TENANT_OAUTH_PROVIDER');
  return value;
}

function providerOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048)
    fail('TENANT_OAUTH_PROVIDER');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail('TENANT_OAUTH_PROVIDER');
  }
  if (
    parsed.protocol !== 'https:' ||
    !parsed.hostname.endsWith('.salesforce.com') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  )
    fail('TENANT_OAUTH_PROVIDER');
  return parsed.origin;
}

function tokenResponse(
  value: unknown,
  expected: OAuthTransaction,
  clientSecret: string,
): {
  instanceOrigin: string;
  refreshToken: string;
  salesforceUserId: string;
} {
  const body = providerRecord(value);
  const allowed = new Set([
    'access_token',
    'refresh_token',
    'signature',
    'scope',
    'instance_url',
    'id',
    'token_type',
    'issued_at',
    'token_format',
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key)))
    fail('TENANT_OAUTH_PROVIDER');
  providerToken(body.access_token);
  const refreshToken = providerToken(body.refresh_token);
  if (body.token_type !== 'Bearer') fail('TENANT_OAUTH_PROVIDER');
  if (typeof body.scope !== 'string') fail('TENANT_OAUTH_PROVIDER');
  const scopes = body.scope.split(' ');
  if (
    scopes.length !== 2 ||
    new Set(scopes).size !== 2 ||
    !scopes.includes('api') ||
    !scopes.includes('refresh_token')
  )
    fail('TENANT_OAUTH_PROVIDER');
  if (body.token_format !== undefined && body.token_format !== 'jwt')
    fail('TENANT_OAUTH_PROVIDER');
  const instanceOrigin = providerOrigin(body.instance_url);
  const identityValue = body.id;
  const issuedAt = body.issued_at;
  const signature = body.signature;
  if (
    typeof identityValue !== 'string' ||
    typeof issuedAt !== 'string' ||
    !/^\d{1,20}$/.test(issuedAt) ||
    typeof signature !== 'string' ||
    signature.length > 128
  )
    fail('TENANT_OAUTH_PROVIDER');
  let identity: URL;
  try {
    identity = new URL(identityValue);
  } catch {
    fail('TENANT_OAUTH_PROVIDER');
  }
  const segments = identity.pathname.split('/');
  if (
    identity.protocol !== 'https:' ||
    !identity.hostname.endsWith('.salesforce.com') ||
    identity.username !== '' ||
    identity.password !== '' ||
    identity.port !== '' ||
    identity.search !== '' ||
    identity.hash !== '' ||
    segments.length !== 4 ||
    segments[1] !== 'id' ||
    !userIdPattern.test(segments[3]!)
  )
    fail('TENANT_OAUTH_PROVIDER');
  let responseOrgId: string;
  try {
    responseOrgId = normalizeSalesforceOrgId(segments[2]);
  } catch {
    fail('TENANT_OAUTH_PROVIDER');
  }
  let suppliedSignature: Buffer;
  try {
    suppliedSignature = Buffer.from(signature, 'base64');
  } catch {
    fail('TENANT_OAUTH_PROVIDER');
  }
  const expectedSignature = createHmac('sha256', clientSecret)
    .update(identityValue + issuedAt, 'utf8')
    .digest();
  if (
    suppliedSignature.toString('base64') !== signature ||
    suppliedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(suppliedSignature, expectedSignature)
  )
    fail('TENANT_OAUTH_PROVIDER');
  if (responseOrgId !== expected.expectedSalesforceOrgId)
    fail('TENANT_OAUTH_BINDING');
  return {
    instanceOrigin,
    refreshToken,
    salesforceUserId: segments[3]!,
  };
}

async function exchangeAuthorizationCode(
  transaction: OAuthTransaction,
  state: string,
  code: string,
  decoded: DecodedConfiguration,
  fetchImplementation: FetchImplementation,
): Promise<{
  instanceOrigin: string;
  refreshToken: string;
  salesforceUserId: string;
}> {
  const controller = new AbortController();
  const timeout = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => reject(new TenantOAuthError('TENANT_OAUTH_PROVIDER')),
      { once: true },
    );
  });
  const timer = setTimeout(() => controller.abort(), decoded.timeoutMs);
  timer.unref();
  try {
    const exchange = async () => {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: decoded.clientId,
        client_secret: decoded.clientSecret,
        redirect_uri: decoded.redirectUri,
        code,
        code_verifier: codeVerifier(decoded.stateSecret, state),
      }).toString();
      const response = await fetchImplementation(
        `${transaction.authorizationOrigin}/services/oauth2/token`,
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          },
          body,
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'manual',
          signal: controller.signal,
        },
      );
      if (
        response.status !== 200 ||
        response.redirected ||
        response.headers
          .get('content-type')
          ?.split(';', 1)[0]
          ?.trim()
          .toLowerCase() !== 'application/json'
      )
        fail('TENANT_OAUTH_PROVIDER');
      const bytes = await boundedBytes(response, controller.signal);
      let parsed: unknown;
      try {
        parsed = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        ) as unknown;
      } catch {
        fail('TENANT_OAUTH_PROVIDER');
      }
      return tokenResponse(parsed, transaction, decoded.clientSecret);
    };
    return await Promise.race([exchange(), timeout]);
  } catch (error) {
    if (
      error instanceof TenantOAuthError &&
      error.code === 'TENANT_OAUTH_BINDING'
    )
      throw error;
    fail('TENANT_OAUTH_PROVIDER');
  } finally {
    clearTimeout(timer);
  }
}

export async function completeTenantSalesforceAuthorization(
  transactionStore: Pick<TenantOAuthTransactionStore, 'consume'>,
  connectionStore: Pick<TenantConnectionStore, 'saveAuthorization'>,
  trustedActorId: string,
  callbackValue: TenantAuthorizationCallback,
  configurationValue: TenantOAuthConfiguration,
  fetchImplementation: FetchImplementation = fetch,
): Promise<TenantAuthorizationResult> {
  if (
    transactionStore === null ||
    typeof transactionStore !== 'object' ||
    typeof transactionStore.consume !== 'function' ||
    connectionStore === null ||
    typeof connectionStore !== 'object' ||
    typeof connectionStore.saveAuthorization !== 'function' ||
    typeof fetchImplementation !== 'function'
  )
    fail('TENANT_OAUTH_INPUT');
  const decodedCallback = callback(callbackValue);
  const decoded = configuration(configurationValue);
  const transaction = await transactionStore.consume(
    stateDigest(decodedCallback.state),
  );
  if (transaction === undefined) fail('TENANT_OAUTH_STATE');
  if ('error' in decodedCallback) fail('TENANT_OAUTH_PROVIDER');
  const exchanged = await exchangeAuthorizationCode(
    transaction,
    decodedCallback.state,
    decodedCallback.code,
    decoded,
    fetchImplementation,
  );
  try {
    const connection = await connectionStore.saveAuthorization({
      actorId: trustedActorId,
      tenantId: transaction.tenantId,
      salesforceOrgId: transaction.expectedSalesforceOrgId,
      salesforceUserId: exchanged.salesforceUserId,
      authorizationOrigin: transaction.authorizationOrigin,
      instanceOrigin: exchanged.instanceOrigin,
      namespacePrefix: transaction.namespacePrefix,
      refreshToken: exchanged.refreshToken,
    });
    return Object.freeze({
      tenantId: connection.tenantId,
      salesforceOrgId: connection.salesforceOrgId,
      salesforceUserId: exchanged.salesforceUserId,
      instanceOrigin: connection.instanceOrigin,
      namespacePrefix: connection.namespacePrefix,
      credentialVersion: connection.credentialVersion,
    });
  } catch {
    fail('TENANT_OAUTH_CONNECTION');
  }
}
