/** Read-only administrator presentation of tenant-scoped publication attempts. */
import { timingSafeEqual } from 'node:crypto';
import { types } from 'node:util';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireHardenedRequestLogging } from '../http-security.js';
import {
  AdministratorSessionError,
  decodeTrustedAdministratorContext,
  type TrustedAdministratorContext,
} from '../tenant/administrator-session.js';
import {
  publicationAttemptOperatorCursor,
  type PublicationAttemptStore,
} from './publication-attempt-store.js';

const attemptsPath = '/api/admin/salesforce/publication-attempts';
const cookieName = '__Host-kusanya_admin_session';
const sessionPattern = /^[A-Za-z0-9_-]{43}$/;
const csrfPattern = /^[A-Za-z0-9_-]{43}$/;

class PublicationAttemptPresentationInputError extends Error {}

export interface PublicationAttemptPresentationRouteDependencies {
  readonly authenticateAdministrator: (
    opaqueSession: string,
  ) => Promise<TrustedAdministratorContext>;
  readonly attemptStore: Pick<PublicationAttemptStore, 'listForOperator'>;
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
    throw new Error('PUBLICATION_ATTEMPT_PRESENTATION_CONFIGURATION');
  return parsed.origin;
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || types.isProxy(value))
    throw new PublicationAttemptPresentationInputError();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'),
    )
  )
    throw new PublicationAttemptPresentationInputError();
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
}

function bodyAbsent(request: FastifyRequest): boolean {
  return (
    request.body === undefined &&
    request.headers['content-length'] === undefined &&
    request.headers['transfer-encoding'] === undefined
  );
}

function requestCursor(request: FastifyRequest): string | undefined {
  const query = plainRecord(request.query);
  const keys = Object.keys(query);
  if (keys.length === 0) return undefined;
  if (keys.length !== 1 || keys[0] !== 'cursor')
    throw new PublicationAttemptPresentationInputError();
  try {
    return publicationAttemptOperatorCursor(query.cursor);
  } catch {
    throw new PublicationAttemptPresentationInputError();
  }
}

function cookieValue(request: FastifyRequest): string | undefined {
  const header = request.headers.cookie;
  if (header === undefined) return undefined;
  const matches: string[] = [];
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) throw new PublicationAttemptPresentationInputError();
    if (part.slice(0, separator).trim() === cookieName)
      matches.push(part.slice(separator + 1).trim());
  }
  if (matches.length > 1) throw new PublicationAttemptPresentationInputError();
  return matches[0];
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'ascii');
  const b = Buffer.from(right, 'ascii');
  return a.length === b.length && timingSafeEqual(a, b);
}

const nullableTimestamp = {
  anyOf: [{ type: 'string' }, { type: 'null' }],
} as const;

const responseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['attempts', 'nextCursor'],
  properties: {
    attempts: {
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'attemptId',
          'formVersionId',
          'operatorStatus',
          'startedAt',
          'completedAt',
          'reconciledAt',
        ],
        properties: {
          attemptId: { type: 'string' },
          formVersionId: { type: 'string' },
          operatorStatus: {
            type: 'string',
            enum: [
              'human_judgement_required_unresolved',
              'human_judgement_required_indeterminate',
              'published',
              'rejected',
              'published_confirmed',
              'unlinked_artifacts_confirmed',
              'artifacts_missing_confirmed',
            ],
          },
          startedAt: { type: 'string' },
          completedAt: nullableTimestamp,
          reconciledAt: nullableTimestamp,
        },
      },
    },
    nextCursor: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
    },
  },
} as const;

const errorSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['error'],
  properties: { error: { type: 'string' } },
} as const;

/** Register a bounded SELECT-only view on the same session and CSRF boundary. */
export function registerPublicationAttemptPresentationRoutes(
  app: FastifyInstance,
  dependencies: PublicationAttemptPresentationRouteDependencies,
): void {
  requireHardenedRequestLogging(app);
  const expectedOrigin = origin(dependencies.externalOrigin);

  app.get(
    attemptsPath,
    {
      schema: {
        response: {
          200: responseSchema,
          400: errorSchema,
          401: errorSchema,
          403: errorSchema,
          503: errorSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        if (request.headers.origin !== expectedOrigin || !bodyAbsent(request))
          throw new PublicationAttemptPresentationInputError();
      } catch {
        return reply.code(400).send({ error: 'Request rejected' });
      }

      let context: TrustedAdministratorContext;
      try {
        const opaqueSession = cookieValue(request);
        if (opaqueSession === undefined || !sessionPattern.test(opaqueSession))
          throw new PublicationAttemptPresentationInputError();
        context = decodeTrustedAdministratorContext(
          await dependencies.authenticateAdministrator(opaqueSession),
        );
      } catch (error) {
        const authenticationFailure =
          error instanceof PublicationAttemptPresentationInputError ||
          (error instanceof AdministratorSessionError &&
            error.code !== 'ADMINISTRATOR_SESSION_STORAGE');
        return reply.code(authenticationFailure ? 401 : 503).send({
          error: authenticationFailure
            ? 'Authentication required'
            : 'Publication history unavailable',
        });
      }

      const suppliedCsrf = request.headers['x-csrf-token'];
      if (
        typeof suppliedCsrf !== 'string' ||
        !csrfPattern.test(suppliedCsrf) ||
        !safeEqual(suppliedCsrf, context.csrfToken)
      )
        return reply.code(403).send({ error: 'Request rejected' });

      try {
        const cursor = requestCursor(request);
        const page = await dependencies.attemptStore.listForOperator(
          context,
          cursor,
        );
        return reply.code(200).send(page);
      } catch (error) {
        if (error instanceof PublicationAttemptPresentationInputError)
          return reply.code(400).send({ error: 'Request rejected' });
        return reply
          .code(503)
          .send({ error: 'Publication history unavailable' });
      }
    },
  );
}

export const publicationAttemptPresentationRoutePaths = Object.freeze({
  list: attemptsPath,
});
