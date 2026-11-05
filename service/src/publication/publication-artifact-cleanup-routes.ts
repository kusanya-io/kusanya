/** Administrator-only command for exact unlinked Salesforce File cleanup. */
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
import type { TenantConnectionSessionStore } from '../tenant/salesforce-session.js';
import { cleanupPublicationArtifacts } from './publication-artifact-cleanup.js';
import {
  PublicationArtifactCleanupError,
  type PublicationAttemptStore,
} from './publication-attempt-store.js';
import type { TenantSalesforcePublisherConfiguration } from './tenant-salesforce-publisher.js';

const cleanupPath = '/api/admin/salesforce/publication-artifact-cleanups';
const csrfPattern = /^[A-Za-z0-9_-]{43}$/;
const attemptIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class CleanupHttpInputError extends Error {}

export interface PublicationArtifactCleanupRouteDependencies {
  readonly authenticateAdministrator: (
    opaqueSession: string,
  ) => Promise<TrustedAdministratorContext>;
  readonly connectionStore: TenantConnectionSessionStore;
  readonly attemptStore: Pick<
    PublicationAttemptStore,
    'startArtifactCleanup' | 'completeArtifactCleanup'
  >;
  readonly publisherConfiguration: TenantSalesforcePublisherConfiguration;
  readonly externalOrigin: string;
  readonly cleanup?: typeof cleanupPublicationArtifacts;
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new CleanupHttpInputError();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'),
    )
  )
    throw new CleanupHttpInputError();
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
}

function attemptId(value: unknown): string {
  const input = plainRecord(value);
  if (
    Object.keys(input).join(',') !== 'attemptId' ||
    typeof input.attemptId !== 'string' ||
    !attemptIdPattern.test(input.attemptId)
  )
    throw new CleanupHttpInputError();
  return input.attemptId;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'ascii');
  const b = Buffer.from(right, 'ascii');
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieValue(request: FastifyRequest): string | undefined {
  try {
    return readAdministratorSessionCookie(request.headers.cookie);
  } catch {
    throw new CleanupHttpInputError();
  }
}

export function registerPublicationArtifactCleanupRoutes(
  app: FastifyInstance,
  dependencies: PublicationArtifactCleanupRouteDependencies,
): void {
  requireHardenedRequestLogging(app);
  const expectedOrigin = new URL(dependencies.externalOrigin);
  if (
    expectedOrigin.protocol !== 'https:' ||
    expectedOrigin.origin !== dependencies.externalOrigin ||
    expectedOrigin.username !== '' ||
    expectedOrigin.password !== '' ||
    expectedOrigin.port !== ''
  )
    throw new Error('PUBLICATION_ARTIFACT_CLEANUP_ROUTE_CONFIGURATION');

  app.post(cleanupPath, async (request: FastifyRequest, reply) => {
    let sourceAttemptId: string;
    try {
      if (
        request.headers.origin !== expectedOrigin.origin ||
        Object.keys(plainRecord(request.query)).length !== 0
      )
        throw new CleanupHttpInputError();
      sourceAttemptId = attemptId(request.body);
    } catch {
      return reply.code(400).send({ error: 'Request rejected' });
    }

    let context: TrustedAdministratorContext;
    try {
      const cookie = cookieValue(request);
      if (cookie === undefined) throw new CleanupHttpInputError();
      context = decodeTrustedAdministratorContext(
        await dependencies.authenticateAdministrator(cookie),
      );
    } catch (error) {
      const authenticationFailure =
        error instanceof CleanupHttpInputError ||
        (error instanceof AdministratorSessionError &&
          error.code !== 'ADMINISTRATOR_SESSION_STORAGE');
      return reply.code(authenticationFailure ? 401 : 503).send({
        error: authenticationFailure
          ? 'Authentication required'
          : 'Artifact cleanup unavailable',
      });
    }

    const suppliedCsrf = request.headers['x-csrf-token'];
    if (
      typeof suppliedCsrf !== 'string' ||
      !csrfPattern.test(suppliedCsrf) ||
      !safeEqual(suppliedCsrf, context.csrfToken) ||
      !administratorHasCapability(
        context,
        administratorRoutePolicy.salesforceArtifactCleanup,
      )
    )
      return reply.code(403).send({ error: 'Request rejected' });

    try {
      const result = await (
        dependencies.cleanup ?? cleanupPublicationArtifacts
      )(
        dependencies.attemptStore,
        dependencies.connectionStore,
        context,
        sourceAttemptId,
        dependencies.publisherConfiguration,
      );
      if (result.ok) return reply.code(200).send({ outcome: 'succeeded' });
      return reply.code(result.outcome === 'failed' ? 409 : 503).send({
        error:
          result.outcome === 'failed'
            ? 'Artifact cleanup refused'
            : 'Artifact cleanup requires investigation',
      });
    } catch (error) {
      if (error instanceof PublicationArtifactCleanupError)
        return reply.code(409).send({ error: 'Artifact cleanup refused' });
      return reply.code(503).send({ error: 'Artifact cleanup unavailable' });
    }
  });
}

export const publicationArtifactCleanupRoutePaths = Object.freeze({
  cleanup: cleanupPath,
});
