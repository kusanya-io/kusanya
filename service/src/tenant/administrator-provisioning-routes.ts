/** Same-tenant self-service enrollment of OIDC-derived administrator actors. */
import { timingSafeEqual } from 'node:crypto';
import { types } from 'node:util';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireHardenedRequestLogging } from '../http-security.js';
import {
  administratorHasCapability,
  administratorRoutePolicy,
} from './administrator-authorization.js';
import {
  administratorRole,
  AdministratorSessionError,
  decodeTrustedAdministratorContext,
  type AdministratorRole,
  type AdministratorSessionStore,
  type TrustedAdministratorContext,
} from './administrator-session.js';
import { readAdministratorSessionCookie } from './administrator-cookie.js';

const provisionPath = '/api/admin/administrators';
const csrfPattern = /^[A-Za-z0-9_-]{43}$/;

class AdministratorProvisioningInputError extends Error {}

export interface AdministratorProvisioningRouteDependencies {
  readonly authenticateAdministrator: (
    opaqueSession: string,
  ) => Promise<TrustedAdministratorContext>;
  readonly actorIdForSubject: (subject: string) => string;
  readonly sessionStore: Pick<
    AdministratorSessionStore,
    'changeRole' | 'deprovision'
  >;
  readonly externalOrigin: string;
}

function origin(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== 'https:' ||
    parsed.origin !== value ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== ''
  )
    throw new Error('ADMINISTRATOR_PROVISIONING_CONFIGURATION');
  return parsed.origin;
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new AdministratorProvisioningInputError();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'),
    )
  )
    throw new AdministratorProvisioningInputError();
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
}

function requestedSubject(value: unknown): string {
  const body = plainRecord(value);
  if (
    Object.keys(body).join(',') !== 'subject' ||
    typeof body.subject !== 'string'
  )
    throw new AdministratorProvisioningInputError();
  return body.subject;
}

function requestedSubjectRole(value: unknown): {
  subject: string;
  role: AdministratorRole;
} {
  const body = plainRecord(value);
  if (
    Object.keys(body).sort().join(',') !== 'role,subject' ||
    typeof body.subject !== 'string'
  )
    throw new AdministratorProvisioningInputError();
  try {
    return { subject: body.subject, role: administratorRole(body.role) };
  } catch {
    throw new AdministratorProvisioningInputError();
  }
}

function emptyQuery(request: FastifyRequest): boolean {
  return Object.keys(plainRecord(request.query)).length === 0;
}

function cookieValue(request: FastifyRequest): string | undefined {
  try {
    return readAdministratorSessionCookie(request.headers.cookie);
  } catch {
    throw new AdministratorProvisioningInputError();
  }
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'ascii');
  const b = Buffer.from(right, 'ascii');
  return a.length === b.length && timingSafeEqual(a, b);
}

const errorSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['error'],
  properties: { error: { type: 'string' } },
} as const;

/** Register the only HTTP paths that can change active actors in an existing tenant. */
export function registerAdministratorProvisioningRoutes(
  app: FastifyInstance,
  dependencies: AdministratorProvisioningRouteDependencies,
): void {
  requireHardenedRequestLogging(app);
  const expectedOrigin = origin(dependencies.externalOrigin);

  app.delete(
    provisionPath,
    {
      schema: {
        response: {
          204: { type: 'null' },
          400: errorSchema,
          401: errorSchema,
          403: errorSchema,
          503: errorSchema,
        },
      },
    },
    async (request, reply) => {
      if (request.headers.origin !== expectedOrigin)
        return reply.code(400).send({ error: 'Request rejected' });

      let context: TrustedAdministratorContext;
      try {
        const opaqueSession = cookieValue(request);
        if (opaqueSession === undefined)
          throw new AdministratorProvisioningInputError();
        context = decodeTrustedAdministratorContext(
          await dependencies.authenticateAdministrator(opaqueSession),
        );
      } catch (error) {
        const authenticationFailure =
          error instanceof AdministratorProvisioningInputError ||
          (error instanceof AdministratorSessionError &&
            error.code !== 'ADMINISTRATOR_SESSION_STORAGE');
        return reply.code(authenticationFailure ? 401 : 503).send({
          error: authenticationFailure
            ? 'Authentication required'
            : 'Provisioning unavailable',
        });
      }

      const suppliedCsrf = request.headers['x-csrf-token'];
      if (
        typeof suppliedCsrf !== 'string' ||
        !csrfPattern.test(suppliedCsrf) ||
        !safeEqual(suppliedCsrf, context.csrfToken) ||
        !administratorHasCapability(
          context,
          administratorRoutePolicy.administratorLifecycle,
        )
      )
        return reply.code(403).send({ error: 'Request rejected' });

      let targetActorId: string;
      try {
        if (!emptyQuery(request))
          throw new AdministratorProvisioningInputError();
        targetActorId = dependencies.actorIdForSubject(
          requestedSubject(request.body),
        );
      } catch {
        return reply.code(400).send({ error: 'Request rejected' });
      }

      try {
        await dependencies.sessionStore.deprovision({
          performedByActorId: context.actorId,
          targetActorId,
          tenantId: context.tenantId,
        });
        return reply.code(204).send();
      } catch {
        return reply.code(503).send({ error: 'Provisioning unavailable' });
      }
    },
  );

  app.patch(
    provisionPath,
    {
      schema: {
        response: {
          204: { type: 'null' },
          400: errorSchema,
          401: errorSchema,
          403: errorSchema,
          503: errorSchema,
        },
      },
    },
    async (request, reply) => {
      if (request.headers.origin !== expectedOrigin)
        return reply.code(400).send({ error: 'Request rejected' });

      let context: TrustedAdministratorContext;
      try {
        const opaqueSession = cookieValue(request);
        if (opaqueSession === undefined)
          throw new AdministratorProvisioningInputError();
        context = decodeTrustedAdministratorContext(
          await dependencies.authenticateAdministrator(opaqueSession),
        );
      } catch (error) {
        const authenticationFailure =
          error instanceof AdministratorProvisioningInputError ||
          (error instanceof AdministratorSessionError &&
            error.code !== 'ADMINISTRATOR_SESSION_STORAGE');
        return reply.code(authenticationFailure ? 401 : 503).send({
          error: authenticationFailure
            ? 'Authentication required'
            : 'Provisioning unavailable',
        });
      }

      const suppliedCsrf = request.headers['x-csrf-token'];
      if (
        typeof suppliedCsrf !== 'string' ||
        !csrfPattern.test(suppliedCsrf) ||
        !safeEqual(suppliedCsrf, context.csrfToken) ||
        !administratorHasCapability(
          context,
          administratorRoutePolicy.administratorLifecycle,
        )
      )
        return reply.code(403).send({ error: 'Request rejected' });

      let requested: { subject: string; role: AdministratorRole };
      let targetActorId: string;
      try {
        if (!emptyQuery(request))
          throw new AdministratorProvisioningInputError();
        requested = requestedSubjectRole(request.body);
        targetActorId = dependencies.actorIdForSubject(requested.subject);
      } catch {
        return reply.code(400).send({ error: 'Request rejected' });
      }

      try {
        await dependencies.sessionStore.changeRole({
          performedByActorId: context.actorId,
          targetActorId,
          tenantId: context.tenantId,
          role: requested.role,
        });
        return reply.code(204).send();
      } catch {
        return reply.code(503).send({ error: 'Provisioning unavailable' });
      }
    },
  );
}

export const administratorProvisioningRoutePaths = Object.freeze({
  provision: provisionPath,
});
