/** Same-origin issuance and revocation of tenant operator invitations. */
import { timingSafeEqual } from 'node:crypto';
import { types } from 'node:util';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireHardenedRequestLogging } from '../http-security.js';
import {
  administratorHasCapability,
  administratorRoutePolicy,
} from './administrator-authorization.js';
import type {
  AdministratorInvitationConfiguration,
  AdministratorInvitationStore,
} from './administrator-invitation.js';
import {
  administratorRole,
  AdministratorSessionError,
  decodeTrustedAdministratorContext,
  type AdministratorRole,
  type TrustedAdministratorContext,
} from './administrator-session.js';
import { readAdministratorSessionCookie } from './administrator-cookie.js';

const invitationPath = '/api/admin/administrator-invitations';
const csrfPattern = /^[A-Za-z0-9_-]{43}$/;
const invitationIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class AdministratorInvitationInputError extends Error {}

export interface AdministratorInvitationRouteDependencies {
  readonly authenticateAdministrator: (
    opaqueSession: string,
  ) => Promise<TrustedAdministratorContext>;
  readonly actorIdForSubject: (subject: string) => string;
  readonly invitationStore: Pick<
    AdministratorInvitationStore,
    'issue' | 'revoke'
  >;
  readonly invitationConfiguration: AdministratorInvitationConfiguration;
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
    throw new Error('ADMINISTRATOR_INVITATION_CONFIGURATION');
  return parsed.origin;
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new AdministratorInvitationInputError();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'),
    )
  )
    throw new AdministratorInvitationInputError();
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
}

function requestedInvitation(value: unknown): {
  readonly subject: string;
  readonly role: AdministratorRole;
} {
  const body = plainRecord(value);
  if (
    Object.keys(body).sort().join(',') !== 'role,subject' ||
    typeof body.subject !== 'string'
  )
    throw new AdministratorInvitationInputError();
  try {
    return Object.freeze({
      subject: body.subject,
      role: administratorRole(body.role),
    });
  } catch {
    throw new AdministratorInvitationInputError();
  }
}

function requestedRevocation(value: unknown): string {
  const body = plainRecord(value);
  if (
    Object.keys(body).join(',') !== 'invitationId' ||
    typeof body.invitationId !== 'string' ||
    !invitationIdPattern.test(body.invitationId)
  )
    throw new AdministratorInvitationInputError();
  return body.invitationId;
}

function emptyQuery(request: FastifyRequest): boolean {
  return Object.keys(plainRecord(request.query)).length === 0;
}

function cookieValue(request: FastifyRequest): string | undefined {
  try {
    return readAdministratorSessionCookie(request.headers.cookie);
  } catch {
    throw new AdministratorInvitationInputError();
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

async function authorize(
  request: FastifyRequest,
  dependencies: AdministratorInvitationRouteDependencies,
): Promise<TrustedAdministratorContext> {
  const opaqueSession = cookieValue(request);
  if (opaqueSession === undefined)
    throw new AdministratorInvitationInputError();
  return decodeTrustedAdministratorContext(
    await dependencies.authenticateAdministrator(opaqueSession),
  );
}

/** Mount the only browser API that can create or revoke an invitation. */
export function registerAdministratorInvitationRoutes(
  app: FastifyInstance,
  dependencies: AdministratorInvitationRouteDependencies,
): void {
  requireHardenedRequestLogging(app);
  const expectedOrigin = origin(dependencies.externalOrigin);

  app.post(
    invitationPath,
    {
      schema: {
        response: {
          201: {
            type: 'object',
            additionalProperties: false,
            required: ['invitationId', 'invitationToken', 'expiresInSeconds'],
            properties: {
              invitationId: { type: 'string' },
              invitationToken: { type: 'string' },
              expiresInSeconds: { type: 'integer' },
            },
          },
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
        context = await authorize(request, dependencies);
      } catch (error) {
        const authenticationFailure =
          error instanceof AdministratorInvitationInputError ||
          (error instanceof AdministratorSessionError &&
            error.code !== 'ADMINISTRATOR_SESSION_STORAGE');
        return reply.code(authenticationFailure ? 401 : 503).send({
          error: authenticationFailure
            ? 'Authentication required'
            : 'Invitation unavailable',
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

      let requested: ReturnType<typeof requestedInvitation>;
      let targetActorId: string;
      try {
        if (!emptyQuery(request)) throw new AdministratorInvitationInputError();
        requested = requestedInvitation(request.body);
        targetActorId = dependencies.actorIdForSubject(requested.subject);
      } catch {
        return reply.code(400).send({ error: 'Request rejected' });
      }
      try {
        const invitation = await dependencies.invitationStore.issue(
          {
            performedByActorId: context.actorId,
            targetActorId,
            tenantId: context.tenantId,
            role: requested.role,
          },
          dependencies.invitationConfiguration,
        );
        return reply
          .header('Cache-Control', 'no-store')
          .code(201)
          .send(invitation);
      } catch {
        return reply.code(503).send({ error: 'Invitation unavailable' });
      }
    },
  );

  app.delete(
    invitationPath,
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
        context = await authorize(request, dependencies);
      } catch (error) {
        const authenticationFailure =
          error instanceof AdministratorInvitationInputError ||
          (error instanceof AdministratorSessionError &&
            error.code !== 'ADMINISTRATOR_SESSION_STORAGE');
        return reply.code(authenticationFailure ? 401 : 503).send({
          error: authenticationFailure
            ? 'Authentication required'
            : 'Invitation unavailable',
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

      let id: string;
      try {
        if (!emptyQuery(request)) throw new AdministratorInvitationInputError();
        id = requestedRevocation(request.body);
      } catch {
        return reply.code(400).send({ error: 'Request rejected' });
      }
      try {
        await dependencies.invitationStore.revoke({
          performedByActorId: context.actorId,
          invitationId: id,
          tenantId: context.tenantId,
        });
        return reply.code(204).send();
      } catch {
        return reply.code(503).send({ error: 'Invitation unavailable' });
      }
    },
  );
}

export const administratorInvitationRoutePaths = Object.freeze({
  invitations: invitationPath,
});
