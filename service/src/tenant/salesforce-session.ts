/** Attempt-scoped Salesforce access obtained from one trusted tenant binding. */
import { types } from 'node:util';
import { createSalesforceNames } from '../salesforce-names.js';
import {
  normalizeSalesforceOrgId,
  type TenantConnection,
  type LockedTenantRefreshResult,
  type TenantRefreshResult,
} from './connection-store.js';

const tenantIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const tokenPattern = /^[\x21-\x7e]+$/;
const clientCredentialPattern = /^[\x21-\x7e]+$/;
const userIdPattern = /^005[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;
const maximumResponseBytes = 65_536;

export type TenantSalesforceSessionFailureCode =
  | 'TENANT_SALESFORCE_SESSION_INPUT'
  | 'TENANT_SALESFORCE_SESSION_NOT_CONNECTED'
  | 'TENANT_SALESFORCE_SESSION_REFRESH'
  | 'TENANT_SALESFORCE_SESSION_ROTATION';

export class TenantSalesforceSessionError extends Error {
  constructor(readonly code: TenantSalesforceSessionFailureCode) {
    super(code);
    this.name = 'TenantSalesforceSessionError';
  }
}

export interface SalesforceOAuthClientConfiguration {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly timeoutMs: number;
}

export interface TenantSalesforceSession {
  readonly tenantId: string;
  readonly salesforceOrgId: string;
  readonly instanceOrigin: string;
  readonly namespacePrefix: string;
  readonly credentialVersion: number;
  getAccessToken(): Promise<string>;
}

export interface TenantConnectionSessionStore {
  withRefreshLock<Value>(
    tenantId: string,
    operation: (
      connection: TenantConnection,
    ) => Promise<TenantRefreshResult<Value>>,
  ): Promise<LockedTenantRefreshResult<Value> | undefined>;
}

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function fail(code: TenantSalesforceSessionFailureCode): never {
  throw new TenantSalesforceSessionError(code);
}

function plainRecord(
  value: unknown,
  code: TenantSalesforceSessionFailureCode,
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
  code: TenantSalesforceSessionFailureCode,
): void {
  if (Object.keys(value).sort().join(',') !== [...expected].sort().join(','))
    fail(code);
}

function salesforceOrigin(
  value: unknown,
  code: TenantSalesforceSessionFailureCode,
): string {
  if (typeof value !== 'string' || value.length > 2048) fail(code);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail(code);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.origin !== value ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    !parsed.hostname.endsWith('.salesforce.com')
  )
    fail(code);
  return parsed.origin;
}

function responseSalesforceOrigin(
  value: unknown,
  code: TenantSalesforceSessionFailureCode,
): string {
  if (typeof value !== 'string' || value.length > 2049) fail(code);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail(code);
  }
  if (
    parsed.protocol !== 'https:' ||
    (parsed.pathname !== '/' && parsed.pathname !== '') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    !parsed.hostname.endsWith('.salesforce.com')
  )
    fail(code);
  return parsed.origin;
}

function normalizedOrgId(
  value: unknown,
  code: TenantSalesforceSessionFailureCode,
): string {
  try {
    return normalizeSalesforceOrgId(value);
  } catch {
    fail(code);
  }
}

function configuration(value: unknown): SalesforceOAuthClientConfiguration {
  const decoded = plainRecord(value, 'TENANT_SALESFORCE_SESSION_INPUT');
  exactKeys(
    decoded,
    ['clientId', 'clientSecret', 'timeoutMs'],
    'TENANT_SALESFORCE_SESSION_INPUT',
  );
  if (
    typeof decoded.clientId !== 'string' ||
    decoded.clientId.length < 1 ||
    decoded.clientId.length > 512 ||
    !clientCredentialPattern.test(decoded.clientId) ||
    typeof decoded.clientSecret !== 'string' ||
    decoded.clientSecret.length < 1 ||
    decoded.clientSecret.length > 2048 ||
    !clientCredentialPattern.test(decoded.clientSecret) ||
    !Number.isSafeInteger(decoded.timeoutMs) ||
    (decoded.timeoutMs as number) < 1 ||
    (decoded.timeoutMs as number) > 30_000
  )
    fail('TENANT_SALESFORCE_SESSION_INPUT');
  return {
    clientId: decoded.clientId,
    clientSecret: decoded.clientSecret,
    timeoutMs: decoded.timeoutMs as number,
  };
}

function connection(
  value: unknown,
  expectedTenantId: string,
): TenantConnection {
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail('TENANT_SALESFORCE_SESSION_REFRESH');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expected = [
    'tenantId',
    'salesforceOrgId',
    'authorizationOrigin',
    'instanceOrigin',
    'namespacePrefix',
    'credentialVersion',
    'needsEncryptionRotation',
    'getRefreshToken',
  ];
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string') ||
    Object.keys(descriptors).sort().join(',') !== expected.sort().join(',') ||
    expected.some(
      (key) =>
        !Object.hasOwn(descriptors[key]!, 'value') ||
        (key === 'getRefreshToken') !== !descriptors[key]!.enumerable,
    )
  )
    fail('TENANT_SALESFORCE_SESSION_REFRESH');
  const values = Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
  if (
    values.tenantId !== expectedTenantId ||
    typeof values.salesforceOrgId !== 'string' ||
    normalizedOrgId(
      values.salesforceOrgId,
      'TENANT_SALESFORCE_SESSION_REFRESH',
    ) !== values.salesforceOrgId ||
    typeof values.namespacePrefix !== 'string' ||
    !Number.isSafeInteger(values.credentialVersion) ||
    (values.credentialVersion as number) < 1 ||
    typeof values.needsEncryptionRotation !== 'boolean' ||
    typeof values.getRefreshToken !== 'function'
  )
    fail('TENANT_SALESFORCE_SESSION_REFRESH');
  salesforceOrigin(
    values.authorizationOrigin,
    'TENANT_SALESFORCE_SESSION_REFRESH',
  );
  salesforceOrigin(values.instanceOrigin, 'TENANT_SALESFORCE_SESSION_REFRESH');
  try {
    createSalesforceNames(values.namespacePrefix);
  } catch {
    fail('TENANT_SALESFORCE_SESSION_REFRESH');
  }
  return value as TenantConnection;
}

async function boundedBytes(
  response: Response,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > maximumResponseBytes
    )
      fail('TENANT_SALESFORCE_SESSION_REFRESH');
  }
  if (response.body === null) fail('TENANT_SALESFORCE_SESSION_REFRESH');
  const reader = response.body.getReader();
  const cancel = (): void => void reader.cancel().catch(() => undefined);
  if (signal.aborted) cancel();
  else signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > maximumResponseBytes)
        fail('TENANT_SALESFORCE_SESSION_REFRESH');
      chunks.push(item.value);
    }
  } catch (error) {
    if (error instanceof TenantSalesforceSessionError) throw error;
    fail('TENANT_SALESFORCE_SESSION_REFRESH');
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function tokenValue(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 4096 ||
    !tokenPattern.test(value)
  )
    fail('TENANT_SALESFORCE_SESSION_REFRESH');
  return value;
}

function oauthResponse(
  value: unknown,
  expected: TenantConnection,
): { accessToken: string; rotatedRefreshToken?: string } {
  const decoded = plainRecord(value, 'TENANT_SALESFORCE_SESSION_REFRESH');
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
  if (Object.keys(decoded).some((key) => !allowed.has(key)))
    fail('TENANT_SALESFORCE_SESSION_REFRESH');
  if (
    decoded.token_type !== 'Bearer' ||
    responseSalesforceOrigin(
      decoded.instance_url,
      'TENANT_SALESFORCE_SESSION_REFRESH',
    ) !== expected.instanceOrigin ||
    (decoded.token_format !== undefined && decoded.token_format !== 'jwt') ||
    typeof decoded.id !== 'string'
  )
    fail('TENANT_SALESFORCE_SESSION_REFRESH');
  let identity: URL;
  try {
    identity = new URL(decoded.id);
  } catch {
    fail('TENANT_SALESFORCE_SESSION_REFRESH');
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
    normalizedOrgId(segments[2], 'TENANT_SALESFORCE_SESSION_REFRESH') !==
      expected.salesforceOrgId ||
    !userIdPattern.test(segments[3]!)
  )
    fail('TENANT_SALESFORCE_SESSION_REFRESH');
  const result: { accessToken: string; rotatedRefreshToken?: string } = {
    accessToken: tokenValue(decoded.access_token),
  };
  if (decoded.refresh_token !== undefined)
    result.rotatedRefreshToken = tokenValue(decoded.refresh_token);
  return result;
}

/**
 * Create one short-lived Salesforce session for an already authenticated tenant.
 * Callers must not source trustedTenantId from a request header or Salesforce ID.
 */
export async function createTenantSalesforceSession(
  store: TenantConnectionSessionStore,
  trustedTenantId: string,
  configurationValue: SalesforceOAuthClientConfiguration,
  fetchImplementation: FetchImplementation = fetch,
): Promise<TenantSalesforceSession> {
  if (
    typeof trustedTenantId !== 'string' ||
    !tenantIdPattern.test(trustedTenantId) ||
    store === null ||
    typeof store !== 'object' ||
    typeof store.withRefreshLock !== 'function' ||
    typeof fetchImplementation !== 'function'
  )
    fail('TENANT_SALESFORCE_SESSION_INPUT');
  const decodedConfiguration = configuration(configurationValue);
  let locked:
    LockedTenantRefreshResult<ReturnType<typeof oauthResponse>> | undefined;
  let rotationSeen = false;
  try {
    locked = await store.withRefreshLock(trustedTenantId, async (selected) => {
      const current = connection(selected, trustedTenantId);
      let refreshToken: string;
      try {
        refreshToken = tokenValue(current.getRefreshToken());
      } catch {
        fail('TENANT_SALESFORCE_SESSION_REFRESH');
      }
      const controller = new AbortController();
      const timeout = new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          'abort',
          () =>
            reject(
              new TenantSalesforceSessionError(
                'TENANT_SALESFORCE_SESSION_REFRESH',
              ),
            ),
          { once: true },
        );
      });
      const timer = setTimeout(
        () => controller.abort(),
        decodedConfiguration.timeoutMs,
      );
      timer.unref();
      try {
        const exchange = async (): Promise<
          TenantRefreshResult<ReturnType<typeof oauthResponse>>
        > => {
          const body = new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: decodedConfiguration.clientId,
            client_secret: decodedConfiguration.clientSecret,
            refresh_token: refreshToken,
          }).toString();
          refreshToken = '';
          const response = await fetchImplementation(
            `${current.authorizationOrigin}/services/oauth2/token`,
            {
              method: 'POST',
              headers: {
                accept: 'application/json',
                'content-type':
                  'application/x-www-form-urlencoded; charset=UTF-8',
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
            fail('TENANT_SALESFORCE_SESSION_REFRESH');
          const bytes = await boundedBytes(response, controller.signal);
          let parsed: unknown;
          try {
            parsed = JSON.parse(
              new TextDecoder('utf-8', { fatal: true }).decode(bytes),
            ) as unknown;
          } catch {
            fail('TENANT_SALESFORCE_SESSION_REFRESH');
          }
          const decoded = oauthResponse(parsed, current);
          rotationSeen = decoded.rotatedRefreshToken !== undefined;
          return decoded.rotatedRefreshToken === undefined
            ? { value: decoded }
            : {
                value: decoded,
                rotatedRefreshToken: decoded.rotatedRefreshToken,
              };
        };
        return await Promise.race([exchange(), timeout]);
      } finally {
        clearTimeout(timer);
      }
    });
  } catch (error) {
    if (error instanceof TenantSalesforceSessionError) throw error;
    fail(
      rotationSeen
        ? 'TENANT_SALESFORCE_SESSION_ROTATION'
        : 'TENANT_SALESFORCE_SESSION_REFRESH',
    );
  }
  if (locked === undefined) fail('TENANT_SALESFORCE_SESSION_NOT_CONNECTED');
  const effective = connection(locked.connection, trustedTenantId);
  const accessToken = locked.value.accessToken;
  const session = {
    tenantId: effective.tenantId,
    salesforceOrgId: effective.salesforceOrgId,
    instanceOrigin: effective.instanceOrigin,
    namespacePrefix: effective.namespacePrefix,
    credentialVersion: effective.credentialVersion,
  } as Omit<TenantSalesforceSession, 'getAccessToken'> &
    Partial<Pick<TenantSalesforceSession, 'getAccessToken'>>;
  Object.defineProperty(session, 'getAccessToken', {
    configurable: false,
    enumerable: false,
    value: async (): Promise<string> => accessToken,
    writable: false,
  });
  return Object.freeze(session) as TenantSalesforceSession;
}
