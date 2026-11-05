/** Administrator-only retry of one safely classified publication attempt. */
import { timingSafeEqual } from 'node:crypto';
import { types } from 'node:util';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireHardenedRequestLogging } from '../http-security.js';
import {
  administratorHasCapability,
  administratorRoutePolicy,
} from '../tenant/administrator-authorization.js';
import { readAdministratorSessionCookie } from '../tenant/administrator-cookie.js';
import {
  AdministratorSessionError,
  decodeTrustedAdministratorContext,
  type TrustedAdministratorContext,
} from '../tenant/administrator-session.js';
import {
  PublicationAttemptRetryError,
  type PublicationAttemptStore,
} from './publication-attempt-store.js';
import {
  executePublicationAttempt,
  type PublicationExecutionDependencies,
} from './publication-routes.js';

const retryPath = '/api/admin/salesforce/publication-retries';
const csrfPattern = /^[A-Za-z0-9_-]{43}$/;
const attemptIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class PublicationRetryHttpInputError extends Error {}

export interface PublicationRetryRouteDependencies extends Omit<
  PublicationExecutionDependencies,
  'attemptStore'
> {
  readonly authenticateAdministrator: (
    opaqueSession: string,
  ) => Promise<TrustedAdministratorContext>;
  readonly attemptStore: Pick<
    PublicationAttemptStore,
    'startRetry' | 'complete'
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
    throw new Error('PUBLICATION_RETRY_ROUTE_CONFIGURATION');
  return parsed.origin;
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new PublicationRetryHttpInputError();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'),
    )
  )
    throw new PublicationRetryHttpInputError();
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
}

function sourceAttempt(value: unknown): string {
  const body = plainRecord(value);
  if (
    Object.keys(body).join(',') !== 'attemptId' ||
    typeof body.attemptId !== 'string' ||
    !attemptIdPattern.test(body.attemptId)
  )
    throw new PublicationRetryHttpInputError();
  return body.attemptId;
}

function emptyQuery(request: FastifyRequest): boolean {
  return Object.keys(plainRecord(request.query)).length === 0;
}

function cookieValue(request: FastifyRequest): string | undefined {
  try {
    return readAdministratorSessionCookie(request.headers.cookie);
  } catch {
    throw new PublicationRetryHttpInputError();
  }
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'ascii');
  const b = Buffer.from(right, 'ascii');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Register a separate command so ordinary publishing cannot forge retry lineage. */
export function registerPublicationRetryRoutes(
  app: FastifyInstance,
  dependencies: PublicationRetryRouteDependencies,
): void {
  requireHardenedRequestLogging(app);
  const expectedOrigin = origin(dependencies.externalOrigin);

  app.post(retryPath, async (request, reply) => {
    let sourceAttemptId: string;
    try {
      if (request.headers.origin !== expectedOrigin || !emptyQuery(request))
        throw new PublicationRetryHttpInputError();
      sourceAttemptId = sourceAttempt(request.body);
    } catch {
      return reply.code(400).send({ error: 'Request rejected' });
    }

    let context: TrustedAdministratorContext;
    try {
      const opaqueSession = cookieValue(request);
      if (opaqueSession === undefined)
        throw new PublicationRetryHttpInputError();
      context = decodeTrustedAdministratorContext(
        await dependencies.authenticateAdministrator(opaqueSession),
      );
    } catch (error) {
      const authenticationFailure =
        error instanceof PublicationRetryHttpInputError ||
        (error instanceof AdministratorSessionError &&
          error.code !== 'ADMINISTRATOR_SESSION_STORAGE');
      return reply.code(authenticationFailure ? 401 : 503).send({
        error: authenticationFailure
          ? 'Authentication required'
          : 'Publication unavailable',
      });
    }

    const suppliedCsrf = request.headers['x-csrf-token'];
    if (
      typeof suppliedCsrf !== 'string' ||
      !csrfPattern.test(suppliedCsrf) ||
      !safeEqual(suppliedCsrf, context.csrfToken) ||
      !administratorHasCapability(
        context,
        administratorRoutePolicy.salesforcePublicationRetry,
      )
    )
      return reply.code(403).send({ error: 'Request rejected' });

    let started;
    try {
      started = await dependencies.attemptStore.startRetry(
        context,
        sourceAttemptId,
      );
    } catch (error) {
      if (error instanceof PublicationAttemptRetryError)
        return reply.code(409).send({ error: 'Publication retry refused' });
      return reply.code(503).send({ error: 'Publication unavailable' });
    }

    const response = await executePublicationAttempt(
      dependencies,
      context,
      started.formVersionId,
      started.attemptId,
    );
    return reply.code(response.statusCode).send(response.body);
  });
}

export const publicationRetryRoutePaths = Object.freeze({ retry: retryPath });
