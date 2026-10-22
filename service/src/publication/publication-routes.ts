/** Hardened administrator route for one tenant-bound Salesforce publication. */
import { timingSafeEqual } from 'node:crypto';
import { types } from 'node:util';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireHardenedRequestLogging } from '../http-security.js';
import {
  AdministratorSessionError,
  decodeTrustedAdministratorContext,
  type TrustedAdministratorContext,
} from '../tenant/administrator-session.js';
import type { TenantConnectionSessionStore } from '../tenant/salesforce-session.js';
import type { ValidateXForm } from './odk-validate.js';
import type { PublicationAttemptStore } from './publication-attempt-store.js';
import { publishTenantSalesforceDefinition } from './tenant-salesforce-publisher.js';
import type { TenantSalesforcePublisherConfiguration } from './tenant-salesforce-publisher.js';

const publishPath = '/api/admin/salesforce/publications';
const cookieName = '__Host-kusanya_admin_session';
const sessionPattern = /^[A-Za-z0-9_-]{43}$/;
const csrfPattern = /^[A-Za-z0-9_-]{43}$/;
const idPattern = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface PublicationRouteDependencies {
  readonly authenticateAdministrator: (
    opaqueSession: string,
  ) => Promise<TrustedAdministratorContext>;
  readonly connectionStore: TenantConnectionSessionStore;
  readonly attemptStore: Pick<PublicationAttemptStore, 'start' | 'complete'>;
  readonly publisherConfiguration: TenantSalesforcePublisherConfiguration;
  readonly validateXForm: ValidateXForm;
  readonly externalOrigin: string;
  readonly fetchImplementation?: FetchImplementation;
  /** Test seam; production omits it and uses the reviewed tenant composition. */
  readonly publisher?: typeof publishTenantSalesforceDefinition;
}

class PublicationHttpInputError extends Error {}

function origin(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== 'https:' ||
    parsed.origin !== value ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== ''
  )
    throw new Error('PUBLICATION_ROUTE_CONFIGURATION');
  return parsed.origin;
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new PublicationHttpInputError();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'),
    )
  )
    throw new PublicationHttpInputError();
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
}

function formVersion(value: unknown): string {
  const body = plainRecord(value);
  if (
    Object.keys(body).join(',') !== 'formVersionId' ||
    typeof body.formVersionId !== 'string' ||
    !idPattern.test(body.formVersionId)
  )
    throw new PublicationHttpInputError();
  return body.formVersionId;
}

function emptyQuery(request: FastifyRequest): boolean {
  return Object.keys(plainRecord(request.query)).length === 0;
}

function cookieValue(request: FastifyRequest): string | undefined {
  const header = request.headers.cookie;
  if (header === undefined) return undefined;
  const matches: string[] = [];
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) throw new PublicationHttpInputError();
    if (part.slice(0, separator).trim() === cookieName)
      matches.push(part.slice(separator + 1).trim());
  }
  if (matches.length > 1) throw new PublicationHttpInputError();
  return matches[0];
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'ascii');
  const b = Buffer.from(right, 'ascii');
  return a.length === b.length && timingSafeEqual(a, b);
}

function failureCode(result: {
  diagnostics: readonly { code: string }[];
}): string {
  const code = result.diagnostics[0]?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(code)
    ? code
    : 'PUBLICATION_REJECTED';
}

/** Register only on the hardened host; production composition remains explicit. */
export function registerPublicationRoutes(
  app: FastifyInstance,
  dependencies: PublicationRouteDependencies,
): void {
  requireHardenedRequestLogging(app);
  const expectedOrigin = origin(dependencies.externalOrigin);

  app.post(publishPath, async (request, reply) => {
    let selectedFormVersion: string;
    try {
      if (request.headers.origin !== expectedOrigin || !emptyQuery(request))
        throw new PublicationHttpInputError();
      selectedFormVersion = formVersion(request.body);
    } catch {
      return reply.code(400).send({ error: 'Request rejected' });
    }

    let context: TrustedAdministratorContext;
    try {
      const opaqueSession = cookieValue(request);
      if (opaqueSession === undefined || !sessionPattern.test(opaqueSession))
        throw new PublicationHttpInputError();
      context = decodeTrustedAdministratorContext(
        await dependencies.authenticateAdministrator(opaqueSession),
      );
    } catch (error) {
      const authenticationFailure =
        error instanceof PublicationHttpInputError ||
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
      !safeEqual(suppliedCsrf, context.csrfToken)
    )
      return reply.code(403).send({ error: 'Request rejected' });

    let attemptId: string;
    try {
      attemptId = await dependencies.attemptStore.start(
        context,
        selectedFormVersion,
      );
    } catch {
      return reply.code(503).send({ error: 'Publication unavailable' });
    }

    let partialRecorded = false;
    let result;
    try {
      result = await (
        dependencies.publisher ?? publishTenantSalesforceDefinition
      )(
        dependencies.connectionStore,
        context,
        dependencies.publisherConfiguration,
        { formVersionId: selectedFormVersion },
        dependencies.validateXForm,
        dependencies.fetchImplementation,
        async (partial) => {
          await dependencies.attemptStore.complete(
            attemptId,
            context.tenantId,
            {
              outcome: 'partial',
              failureCode: 'PUBLICATION_PUBLISHER_PARTIAL',
              publicationDigest: partial.publicationDigest,
              xformVersionId: partial.xformVersionId,
              xlsformVersionId: partial.xlsformVersionId,
              salesforceRequestCount: partial.requestCount,
            },
          );
          partialRecorded = true;
        },
      );
    } catch {
      return reply.code(503).send({
        status: 'unresolved',
        attemptId,
        error: 'Publication outcome requires reconciliation',
      });
    }

    if (result.ok) {
      try {
        await dependencies.attemptStore.complete(attemptId, context.tenantId, {
          outcome: 'succeeded',
          publicationDigest: result.publicationDigest,
          salesforceRequestCount: result.requestCount,
        });
      } catch {
        return reply.code(503).send({
          status: 'unresolved',
          attemptId,
          error: 'Publication outcome requires reconciliation',
        });
      }
      return reply.code(200).send({
        status: 'published',
        attemptId,
        publicationDigest: result.publicationDigest,
        alreadyCommitted: result.alreadyCommitted,
        salesforceRequestCount: result.requestCount,
      });
    }

    const code = failureCode(result);
    if (
      code === 'PUBLICATION_PUBLISHER_PARTIAL' ||
      code === 'PUBLICATION_PUBLISHER_PARTIAL_RECORDING'
    ) {
      return reply.code(409).send({
        status: partialRecorded ? 'partial' : 'unresolved',
        attemptId,
        error: 'Publication outcome requires reconciliation',
        salesforceRequestCount: result.requestCount,
      });
    }
    try {
      await dependencies.attemptStore.complete(attemptId, context.tenantId, {
        outcome: 'failed',
        failureCode: code,
        salesforceRequestCount: result.requestCount,
      });
    } catch {
      return reply.code(503).send({
        status: 'unresolved',
        attemptId,
        error: 'Publication outcome requires reconciliation',
      });
    }
    return reply.code(422).send({
      status: 'rejected',
      attemptId,
      diagnostics: result.diagnostics,
      salesforceRequestCount: result.requestCount,
    });
  });
}

export const publicationRoutePaths = Object.freeze({ publish: publishPath });
