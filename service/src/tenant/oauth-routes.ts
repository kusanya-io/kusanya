/** Browser-facing adapter for a trusted administrator Salesforce OAuth grant. */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { types } from 'node:util';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  beginTenantSalesforceAuthorization,
  completeTenantSalesforceAuthorization,
  TenantOAuthError,
  type TenantOAuthConfiguration,
  type TenantOAuthTransactionStore,
} from './oauth-authorization.js';
import type { TenantConnectionStore } from './connection-store.js';
import type { TrustedAdministratorContext } from './administrator-session.js';

const startPath = '/api/admin/salesforce/authorization';
const callbackPath = '/api/admin/salesforce/callback';
const administratorCookie = '__Host-kusanya_admin_session';
const bindingCookie = '__Host-kusanya_oauth_binding';
const opaquePattern = /^[A-Za-z0-9_-]{43,512}$/;
const csrfPattern = /^[A-Za-z0-9_-]{43}$/;
const statePattern = /^[A-Za-z0-9_-]{43}$/;
const digestPattern = /^[0-9a-f]{64}$/;

class AdministratorRouteInputError extends Error {}

export interface TenantOAuthRouteDependencies {
  /** Verifies the opaque server-issued session and returns its immutable binding. */
  readonly authenticateAdministrator: (
    opaqueSession: string,
  ) => Promise<unknown>;
  readonly transactionStore: TenantOAuthTransactionStore;
  readonly connectionStore: Pick<TenantConnectionStore, 'save'>;
  readonly oauthConfiguration: TenantOAuthConfiguration;
  /** Exact public HTTPS origin that owns these routes and the session cookie. */
  readonly externalOrigin: string;
  readonly fetchImplementation?: typeof fetch;
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'),
    )
  )
    return undefined;
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
}

function exactString(value: unknown, pattern: RegExp, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length > maximum ||
    !pattern.test(value)
  )
    throw new AdministratorRouteInputError();
  return value;
}

function decodeContext(value: unknown): TrustedAdministratorContext {
  const record = plainRecord(value);
  if (
    record === undefined ||
    Object.keys(record).sort().join(',') !==
      [
        'actorId',
        'authorizationOrigin',
        'csrfToken',
        'expectedSalesforceOrgId',
        'namespacePrefix',
        'tenantId',
      ]
        .sort()
        .join(',')
  )
    throw new AdministratorRouteInputError();
  return Object.freeze({
    actorId: exactString(record.actorId, /^[A-Za-z0-9:_-]{1,128}$/, 128),
    tenantId: exactString(
      record.tenantId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      36,
    ),
    expectedSalesforceOrgId: exactString(
      record.expectedSalesforceOrgId,
      /^00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/,
      18,
    ),
    authorizationOrigin: exactString(
      record.authorizationOrigin,
      /^https:\/\/[A-Za-z0-9.-]+\.salesforce\.com$/,
      2048,
    ),
    namespacePrefix: exactString(
      record.namespacePrefix,
      /^(?:|[a-z][a-z0-9]{0,14}__)$/,
      17,
    ),
    csrfToken: exactString(record.csrfToken, csrfPattern, 43),
  });
}

function cookieValue(
  request: FastifyRequest,
  name: string,
): string | undefined {
  const header = request.headers.cookie;
  if (header === undefined) return undefined;
  const matches: string[] = [];
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) throw new AdministratorRouteInputError();
    if (part.slice(0, separator).trim() === name)
      matches.push(part.slice(separator + 1).trim());
  }
  if (matches.length > 1) throw new AdministratorRouteInputError();
  return matches[0];
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function stateBinding(
  secret: Buffer,
  state: string,
  administratorSession: string,
): string {
  return createHmac('sha256', secret)
    .update('kusanya:tenant-oauth-browser:v1\0', 'utf8')
    .update(state, 'ascii')
    .update('\0', 'ascii')
    .update(administratorSession, 'ascii')
    .digest('hex');
}

function browserCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
}

function publicOrigin(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== 'https:' ||
    parsed.origin !== value ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== ''
  )
    throw new Error('ADMIN_ROUTE_CONFIGURATION');
  return parsed.origin;
}

function stateSecret(configuration: TenantOAuthConfiguration): Buffer {
  const secret = Buffer.from(configuration.stateSecret, 'base64');
  if (
    secret.length !== 32 ||
    secret.toString('base64') !== configuration.stateSecret
  )
    throw new Error('ADMIN_ROUTE_CONFIGURATION');
  return secret;
}

function queryRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || types.isProxy(value))
    throw new AdministratorRouteInputError();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'),
    )
  )
    throw new AdministratorRouteInputError();
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
}

function callbackInput(
  value: unknown,
):
  | Readonly<{ state: string; code: string }>
  | Readonly<{ state: string; error: string }> {
  const query = queryRecord(value);
  const keys = Object.keys(query).sort().join(',');
  if (
    keys !== 'code,state' &&
    keys !== 'error,state' &&
    keys !== 'error,error_description,state'
  )
    throw new AdministratorRouteInputError();
  const state = exactString(query.state, statePattern, 43);
  if (keys === 'code,state')
    return {
      state,
      code: exactString(query.code, /^[\x21-\x7e]+$/, 4096),
    };
  // Salesforce's human-readable description is accepted only to remove it at
  // the HTTP edge. It is never logged, reflected, or passed to the core.
  if (keys === 'error,error_description,state') {
    if (
      typeof query.error_description !== 'string' ||
      query.error_description.length < 1 ||
      query.error_description.length > 1024
    )
      throw new AdministratorRouteInputError();
  }
  return {
    state,
    error: exactString(query.error, /^[A-Za-z0-9_.-]{1,256}$/, 256),
  };
}

function emptyRequest(request: FastifyRequest): boolean {
  return (
    Object.keys(queryRecord(request.query)).length === 0 &&
    request.body === undefined
  );
}

/** Register routes only after a concrete trusted-session verifier is supplied. */
export function registerTenantOAuthRoutes(
  app: FastifyInstance,
  dependencies: TenantOAuthRouteDependencies,
): void {
  const origin = publicOrigin(dependencies.externalOrigin);
  const secret = stateSecret(dependencies.oauthConfiguration);
  if (
    dependencies.oauthConfiguration.redirectUri !== `${origin}${callbackPath}`
  )
    throw new Error('ADMIN_ROUTE_CONFIGURATION');

  app.post(startPath, async (request, reply) => {
    try {
      if (!emptyRequest(request))
        return reply.code(400).send({ error: 'Request rejected' });
      const session = cookieValue(request, administratorCookie);
      if (session === undefined || !opaquePattern.test(session))
        return reply.code(401).send({ error: 'Authentication required' });
      let context: TrustedAdministratorContext;
      try {
        context = decodeContext(
          await dependencies.authenticateAdministrator(session),
        );
      } catch {
        return reply.code(401).send({ error: 'Authentication required' });
      }
      const suppliedCsrf = request.headers['x-csrf-token'];
      if (
        request.headers.origin !== origin ||
        typeof suppliedCsrf !== 'string' ||
        !csrfPattern.test(suppliedCsrf) ||
        !safeEqual(suppliedCsrf, context.csrfToken)
      )
        return reply.code(403).send({ error: 'Request rejected' });
      const started = await beginTenantSalesforceAuthorization(
        dependencies.transactionStore,
        {
          trustedTenantId: context.tenantId,
          expectedSalesforceOrgId: context.expectedSalesforceOrgId,
          authorizationOrigin: context.authorizationOrigin,
          namespacePrefix: context.namespacePrefix,
        },
        dependencies.oauthConfiguration,
      );
      const state = new URL(started.authorizationUrl).searchParams.get('state');
      if (state === null || !statePattern.test(state))
        throw new Error('ADMIN_ROUTE_INTERNAL');
      reply.header(
        'Set-Cookie',
        browserCookie(
          bindingCookie,
          stateBinding(secret, state, session),
          dependencies.oauthConfiguration.transactionTtlSeconds,
        ),
      );
      return reply
        .code(303)
        .header('Location', started.authorizationUrl)
        .send();
    } catch (error) {
      return reply
        .code(error instanceof AdministratorRouteInputError ? 400 : 503)
        .send({
          error:
            error instanceof AdministratorRouteInputError
              ? 'Request rejected'
              : 'Authorization unavailable',
        });
    }
  });

  app.get(callbackPath, async (request, reply) => {
    reply.header('Set-Cookie', browserCookie(bindingCookie, '', 0));
    try {
      const input = callbackInput(request.query);
      const suppliedBinding = cookieValue(request, bindingCookie);
      const session = cookieValue(request, administratorCookie);
      if (session === undefined || !opaquePattern.test(session))
        return reply.code(401).send({ error: 'Authentication required' });
      try {
        decodeContext(await dependencies.authenticateAdministrator(session));
      } catch {
        return reply.code(401).send({ error: 'Authentication required' });
      }
      const expectedBinding = stateBinding(secret, input.state, session);
      if (
        suppliedBinding === undefined ||
        !digestPattern.test(suppliedBinding) ||
        !safeEqual(suppliedBinding, expectedBinding)
      )
        return reply.code(400).send({ error: 'Authorization failed' });
      await completeTenantSalesforceAuthorization(
        dependencies.transactionStore,
        dependencies.connectionStore,
        input,
        dependencies.oauthConfiguration,
        dependencies.fetchImplementation,
      );
      return reply.code(200).send({ status: 'connected' });
    } catch (error) {
      const unavailable =
        error instanceof TenantOAuthError &&
        (error.code === 'TENANT_OAUTH_STORAGE' ||
          error.code === 'TENANT_OAUTH_CONNECTION');
      return reply
        .code(unavailable ? 503 : 400)
        .send({ error: 'Authorization failed' });
    }
  });
}

export const tenantOAuthRoutePaths = Object.freeze({
  start: startPath,
  callback: callbackPath,
});
