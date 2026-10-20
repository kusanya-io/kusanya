/** Browser composition for trusted administrator login, CSRF bootstrap and logout. */
import { timingSafeEqual } from 'node:crypto';
import { types } from 'node:util';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireHardenedRequestLogging } from '../http-security.js';
import type {
  AdministratorSessionConfiguration,
  AdministratorSessionStore,
  TrustedAdministratorContext,
} from './administrator-session.js';

const loginPath = '/api/admin/session/login';
const csrfPath = '/api/admin/session/csrf';
const logoutPath = '/api/admin/session/logout';
const cookieName = '__Host-kusanya_admin_session';
const sessionPattern = /^[A-Za-z0-9_-]{43}$/;
const actorPattern = /^[A-Za-z0-9:_-]{1,128}$/;
const csrfPattern = /^[A-Za-z0-9_-]{43}$/;

class AdministratorHttpInputError extends Error {}

export interface AdministratorRouteDependencies {
  /** Provider-specific verifier; it must return a stable trusted actor only after login. */
  readonly verifyLoginRequest: (request: FastifyRequest) => Promise<unknown>;
  readonly sessionStore: Pick<
    AdministratorSessionStore,
    'issue' | 'authenticate' | 'revoke'
  >;
  readonly sessionConfiguration: AdministratorSessionConfiguration;
  readonly externalOrigin: string;
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
    throw new Error('ADMINISTRATOR_ROUTE_CONFIGURATION');
  return parsed.origin;
}

function exactActor(value: unknown): string {
  if (typeof value !== 'string' || !actorPattern.test(value))
    throw new AdministratorHttpInputError();
  return value;
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new AdministratorHttpInputError();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'),
    )
  )
    throw new AdministratorHttpInputError();
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
}

function trustedActor(value: unknown): string {
  const record = plainRecord(value);
  if (Object.keys(record).join(',') !== 'actorId')
    throw new AdministratorHttpInputError();
  return exactActor(record.actorId);
}

function emptyRequest(request: FastifyRequest): boolean {
  const query = request.query;
  if (query === null || typeof query !== 'object' || types.isProxy(query))
    throw new AdministratorHttpInputError();
  const descriptors = Object.getOwnPropertyDescriptors(query);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'),
    )
  )
    throw new AdministratorHttpInputError();
  return Object.keys(descriptors).length === 0 && request.body === undefined;
}

function cookieValue(request: FastifyRequest): string | undefined {
  const header = request.headers.cookie;
  if (header === undefined) return undefined;
  const matches: string[] = [];
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) throw new AdministratorHttpInputError();
    if (part.slice(0, separator).trim() === cookieName)
      matches.push(part.slice(separator + 1).trim());
  }
  if (matches.length > 1) throw new AdministratorHttpInputError();
  return matches[0];
}

function sessionCookie(value: string, maxAge: number): string {
  return `${cookieName}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
}

function clearSessionCookie(): string {
  return sessionCookie('', 0);
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'ascii');
  const b = Buffer.from(right, 'ascii');
  return a.length === b.length && timingSafeEqual(a, b);
}

function decodeContext(value: unknown): TrustedAdministratorContext {
  const record = plainRecord(value);
  if (
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
    throw new AdministratorHttpInputError();
  if (
    typeof record.actorId !== 'string' ||
    !actorPattern.test(record.actorId) ||
    typeof record.tenantId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      record.tenantId,
    ) ||
    typeof record.expectedSalesforceOrgId !== 'string' ||
    !/^00D[A-Za-z0-9]{15}$/.test(record.expectedSalesforceOrgId) ||
    typeof record.authorizationOrigin !== 'string' ||
    !/^https:\/\/[A-Za-z0-9.-]+\.salesforce\.com$/.test(
      record.authorizationOrigin,
    ) ||
    typeof record.namespacePrefix !== 'string' ||
    !/^(?:|[a-z][a-z0-9]{0,14}__)$/.test(record.namespacePrefix) ||
    typeof record.csrfToken !== 'string' ||
    !csrfPattern.test(record.csrfToken)
  )
    throw new AdministratorHttpInputError();
  return Object.freeze({
    actorId: record.actorId,
    tenantId: record.tenantId,
    expectedSalesforceOrgId: record.expectedSalesforceOrgId,
    authorizationOrigin: record.authorizationOrigin,
    namespacePrefix: record.namespacePrefix,
    csrfToken: record.csrfToken,
  });
}

function sameOrigin(request: FastifyRequest, origin: string): boolean {
  return request.headers.origin === origin;
}

/** Register only on the hardened Kusanya host and behind a trusted login verifier. */
export function registerAdministratorSessionRoutes(
  app: FastifyInstance,
  dependencies: AdministratorRouteDependencies,
): void {
  requireHardenedRequestLogging(app);
  const origin = publicOrigin(dependencies.externalOrigin);

  app.post(loginPath, async (request, reply) => {
    try {
      if (!sameOrigin(request, origin) || !emptyRequest(request)) {
        reply.header('Set-Cookie', clearSessionCookie());
        return reply.code(400).send({ error: 'Request rejected' });
      }
      const actor = trustedActor(
        await dependencies.verifyLoginRequest(request),
      );
      const issued = await dependencies.sessionStore.issue(
        actor,
        dependencies.sessionConfiguration,
      );
      reply.header(
        'Set-Cookie',
        sessionCookie(issued.opaqueSession, issued.expiresInSeconds),
      );
      return reply.code(204).send();
    } catch (error) {
      reply.header('Set-Cookie', clearSessionCookie());
      return reply
        .code(error instanceof AdministratorHttpInputError ? 401 : 503)
        .send({
          error:
            error instanceof AdministratorHttpInputError
              ? 'Authentication required'
              : 'Login unavailable',
        });
    }
  });

  app.post(csrfPath, async (request, reply) => {
    try {
      if (!sameOrigin(request, origin) || !emptyRequest(request))
        return reply.code(400).send({ error: 'Request rejected' });
      const session = cookieValue(request);
      if (session === undefined || !sessionPattern.test(session))
        throw new AdministratorHttpInputError();
      const context = decodeContext(
        await dependencies.sessionStore.authenticate(
          session,
          dependencies.sessionConfiguration,
        ),
      );
      return reply.code(200).send({ csrfToken: context.csrfToken });
    } catch (error) {
      if (error instanceof AdministratorHttpInputError)
        reply.header('Set-Cookie', clearSessionCookie());
      return reply
        .code(error instanceof AdministratorHttpInputError ? 401 : 503)
        .send({
          error:
            error instanceof AdministratorHttpInputError
              ? 'Authentication required'
              : 'Session unavailable',
        });
    }
  });

  app.post(logoutPath, async (request, reply) => {
    try {
      if (!sameOrigin(request, origin) || !emptyRequest(request))
        return reply.code(400).send({ error: 'Request rejected' });
      const session = cookieValue(request);
      if (session === undefined || !sessionPattern.test(session))
        throw new AdministratorHttpInputError();
      const context = decodeContext(
        await dependencies.sessionStore.authenticate(
          session,
          dependencies.sessionConfiguration,
        ),
      );
      const suppliedCsrf = request.headers['x-csrf-token'];
      if (
        typeof suppliedCsrf !== 'string' ||
        !csrfPattern.test(suppliedCsrf) ||
        !safeEqual(suppliedCsrf, context.csrfToken)
      )
        return reply.code(403).send({ error: 'Request rejected' });
      if (!(await dependencies.sessionStore.revoke(session)))
        throw new AdministratorHttpInputError();
      reply.header('Set-Cookie', clearSessionCookie());
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof AdministratorHttpInputError)
        reply.header('Set-Cookie', clearSessionCookie());
      return reply
        .code(error instanceof AdministratorHttpInputError ? 401 : 503)
        .send({
          error:
            error instanceof AdministratorHttpInputError
              ? 'Authentication required'
              : 'Logout unavailable',
        });
    }
  });
}

export const administratorSessionRoutePaths = Object.freeze({
  login: loginPath,
  csrf: csrfPath,
  logout: logoutPath,
});
