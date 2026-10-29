/** Administrator-only execution of the database-owned attempt retention policy. */
import { timingSafeEqual } from 'node:crypto';
import { types } from 'node:util';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireHardenedRequestLogging } from '../http-security.js';
import {
  administratorHasCapability,
  administratorRoutePolicy,
} from '../tenant/administrator-authorization.js';
import {
  AdministratorSessionError,
  decodeTrustedAdministratorContext,
  type TrustedAdministratorContext,
} from '../tenant/administrator-session.js';
import { readAdministratorSessionCookie } from '../tenant/administrator-cookie.js';
import type { PublicationAttemptStore } from './publication-attempt-store.js';

const retentionPath = '/api/admin/publication-attempts/retention';
const csrfPattern = /^[A-Za-z0-9_-]{43}$/;

class PublicationAttemptRetentionInputError extends Error {}

export interface PublicationAttemptRetentionRouteDependencies {
  readonly authenticateAdministrator: (
    opaqueSession: string,
  ) => Promise<TrustedAdministratorContext>;
  readonly attemptStore: Pick<PublicationAttemptStore, 'applyRetention'>;
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
    throw new Error('PUBLICATION_RETENTION_CONFIGURATION');
  return parsed.origin;
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new PublicationAttemptRetentionInputError();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'),
    )
  )
    throw new PublicationAttemptRetentionInputError();
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
}

function cookieValue(request: FastifyRequest): string | undefined {
  try {
    return readAdministratorSessionCookie(request.headers.cookie);
  } catch {
    throw new PublicationAttemptRetentionInputError();
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

/** Mount a selector-free purge; tenant, cutoff and eligible states stay server-side. */
export function registerPublicationAttemptRetentionRoutes(
  app: FastifyInstance,
  dependencies: PublicationAttemptRetentionRouteDependencies,
): void {
  requireHardenedRequestLogging(app);
  const expectedOrigin = origin(dependencies.externalOrigin);
  app.post(
    retentionPath,
    {
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['deletedCount'],
            properties: {
              deletedCount: { type: 'integer', minimum: 0, maximum: 100 },
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
        const opaqueSession = cookieValue(request);
        if (opaqueSession === undefined)
          throw new PublicationAttemptRetentionInputError();
        context = decodeTrustedAdministratorContext(
          await dependencies.authenticateAdministrator(opaqueSession),
        );
      } catch (error) {
        const authenticationFailure =
          error instanceof PublicationAttemptRetentionInputError ||
          (error instanceof AdministratorSessionError &&
            error.code !== 'ADMINISTRATOR_SESSION_STORAGE');
        return reply.code(authenticationFailure ? 401 : 503).send({
          error: authenticationFailure
            ? 'Authentication required'
            : 'Retention unavailable',
        });
      }
      const suppliedCsrf = request.headers['x-csrf-token'];
      if (
        typeof suppliedCsrf !== 'string' ||
        !csrfPattern.test(suppliedCsrf) ||
        !safeEqual(suppliedCsrf, context.csrfToken) ||
        !administratorHasCapability(
          context,
          administratorRoutePolicy.publicationRetention,
        )
      )
        return reply.code(403).send({ error: 'Request rejected' });
      try {
        if (
          Object.keys(plainRecord(request.query)).length !== 0 ||
          request.body !== undefined
        )
          throw new PublicationAttemptRetentionInputError();
      } catch {
        return reply.code(400).send({ error: 'Request rejected' });
      }
      try {
        const result = await dependencies.attemptStore.applyRetention(context);
        return reply.header('Cache-Control', 'no-store').code(200).send(result);
      } catch {
        return reply.code(503).send({ error: 'Retention unavailable' });
      }
    },
  );
}

export const publicationAttemptRetentionRoutePaths = Object.freeze({
  retention: retentionPath,
});
