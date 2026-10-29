/** Browser composition for trusted administrator login, CSRF bootstrap and logout. */
import { timingSafeEqual } from 'node:crypto';
import { types } from 'node:util';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireHardenedRequestLogging } from '../http-security.js';
import {
  AdministratorInvitationError,
  type AdministratorInvitationStore,
} from './administrator-invitation.js';
import {
  administratorSessionCookieName,
  isAdministratorSessionValue,
  serializeAdministratorSessionCookie,
} from './administrator-cookie.js';
import type {
  AdministratorSessionConfiguration,
  AdministratorSessionStore,
} from './administrator-session.js';
import {
  AdministratorSessionError,
  decodeTrustedAdministratorContext,
} from './administrator-session.js';
import { AdministratorOidcError } from './oidc-login.js';

const loginPath = '/api/admin/session/login';
const csrfPath = '/api/admin/session/csrf';
const logoutPath = '/api/admin/session/logout';
const actorPattern = /^[A-Za-z0-9:_-]{1,128}$/;
const csrfPattern = /^[A-Za-z0-9_-]{43}$/;
const invitationPattern = /^[A-Za-z0-9_-]{43}$/;

class AdministratorHttpInputError extends Error {}

export interface AdministratorRouteDependencies {
  /** Provider-specific verifier; it must return a stable trusted actor only after login. */
  readonly verifyLoginRequest: (request: FastifyRequest) => Promise<unknown>;
  readonly sessionStore: Pick<
    AdministratorSessionStore,
    'issue' | 'authenticate' | 'revoke'
  >;
  readonly invitationStore: Pick<AdministratorInvitationStore, 'accept'>;
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

function trustedContext(value: unknown) {
  try {
    return decodeTrustedAdministratorContext(value);
  } catch {
    throw new AdministratorHttpInputError();
  }
}

function emptyQuery(request: FastifyRequest): boolean {
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
  return Object.keys(descriptors).length === 0;
}

function invitationToken(request: FastifyRequest): string | undefined {
  if (request.body === undefined) return undefined;
  const body = plainRecord(request.body);
  if (
    Object.keys(body).join(',') !== 'invitationToken' ||
    typeof body.invitationToken !== 'string' ||
    !invitationPattern.test(body.invitationToken)
  )
    throw new AdministratorHttpInputError();
  return body.invitationToken;
}

function emptyRequest(request: FastifyRequest): boolean {
  return emptyQuery(request) && request.body === undefined;
}

function cookieValue(request: FastifyRequest): string | undefined {
  const header = request.headers.cookie;
  if (header === undefined) return undefined;
  const matches: string[] = [];
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) throw new AdministratorHttpInputError();
    if (part.slice(0, separator).trim() === administratorSessionCookieName)
      matches.push(part.slice(separator + 1).trim());
  }
  if (matches.length > 1) throw new AdministratorHttpInputError();
  return matches[0];
}

function clearSessionCookie(): string {
  return serializeAdministratorSessionCookie('', 0);
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'ascii');
  const b = Buffer.from(right, 'ascii');
  return a.length === b.length && timingSafeEqual(a, b);
}

function sameOrigin(request: FastifyRequest, origin: string): boolean {
  return request.headers.origin === origin;
}

function isLoginRejection(error: unknown): boolean {
  return (
    error instanceof AdministratorHttpInputError ||
    error instanceof AdministratorOidcError ||
    (error instanceof AdministratorInvitationError &&
      error.code !== 'ADMINISTRATOR_INVITATION_STORAGE') ||
    (error instanceof AdministratorSessionError &&
      error.code === 'ADMINISTRATOR_SESSION_ABSENT')
  );
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
      if (!sameOrigin(request, origin) || !emptyQuery(request)) {
        reply.header('Set-Cookie', clearSessionCookie());
        return reply.code(400).send({ error: 'Request rejected' });
      }
      const token = invitationToken(request);
      const actor = trustedActor(
        await dependencies.verifyLoginRequest(request),
      );
      const issued =
        token === undefined
          ? await dependencies.sessionStore.issue(
              actor,
              dependencies.sessionConfiguration,
            )
          : await dependencies.invitationStore.accept(
              { actorId: actor, invitationToken: token },
              dependencies.sessionConfiguration,
            );
      reply.header(
        'Set-Cookie',
        serializeAdministratorSessionCookie(
          issued.opaqueSession,
          issued.expiresInSeconds,
        ),
      );
      return reply.code(204).send();
    } catch (error) {
      const rejected = isLoginRejection(error);
      reply.header('Set-Cookie', clearSessionCookie());
      return reply.code(rejected ? 401 : 503).send({
        error: rejected ? 'Authentication required' : 'Login unavailable',
      });
    }
  });

  app.post(csrfPath, async (request, reply) => {
    try {
      if (!sameOrigin(request, origin) || !emptyRequest(request))
        return reply.code(400).send({ error: 'Request rejected' });
      const session = cookieValue(request);
      if (!isAdministratorSessionValue(session))
        throw new AdministratorHttpInputError();
      const context = trustedContext(
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
      if (!isAdministratorSessionValue(session))
        throw new AdministratorHttpInputError();
      const context = trustedContext(
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
