/** Hardened delivery boundary for reviewer-only definition HTML. */
import { timingSafeEqual } from 'node:crypto';
import { types } from 'node:util';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireHardenedRequestLogging } from '../http-security.js';
import type { TenantSalesforcePublisherConfiguration } from '../publication/tenant-salesforce-publisher.js';
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
import type { TenantConnectionSessionStore } from '../tenant/salesforce-session.js';
import { printViewContentSecurityPolicy, renderPrintView } from './render.js';
import {
  reviewTenantSalesforceDefinition,
  type TenantSalesforceReviewRequest,
  type TenantSalesforceReviewResult,
} from './tenant-reviewer.js';

const reviewerPath = '/api/admin/salesforce/reviewer-print';
const csrfPattern = /^[A-Za-z0-9_-]{43}$/;
const idPattern = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type Reviewer = (
  store: TenantConnectionSessionStore,
  context: TrustedAdministratorContext,
  configuration: TenantSalesforcePublisherConfiguration,
  request: TenantSalesforceReviewRequest,
  fetchImplementation?: FetchImplementation,
  renderer?: typeof renderPrintView,
) => Promise<TenantSalesforceReviewResult>;

export interface ReviewerPrintRouteDependencies {
  readonly authenticateAdministrator: (
    opaqueSession: string,
  ) => Promise<TrustedAdministratorContext>;
  readonly connectionStore: TenantConnectionSessionStore;
  readonly publisherConfiguration: TenantSalesforcePublisherConfiguration;
  readonly externalOrigin: string;
  readonly fetchImplementation?: FetchImplementation;
  /** Test seam; production omits it and uses the tenant-bound reviewer. */
  readonly reviewer?: Reviewer;
}

class ReviewerPrintHttpInputError extends Error {}

function origin(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== 'https:' ||
    parsed.origin !== value ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== ''
  )
    throw new Error('REVIEWER_PRINT_ROUTE_CONFIGURATION');
  return parsed.origin;
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    throw new ReviewerPrintHttpInputError();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'),
    )
  )
    throw new ReviewerPrintHttpInputError();
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
    throw new ReviewerPrintHttpInputError();
  return body.formVersionId;
}

function emptyQuery(request: FastifyRequest): boolean {
  return Object.keys(plainRecord(request.query)).length === 0;
}

function cookieValue(request: FastifyRequest): string | undefined {
  try {
    return readAdministratorSessionCookie(request.headers.cookie);
  } catch {
    throw new ReviewerPrintHttpInputError();
  }
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'ascii');
  const b = Buffer.from(right, 'ascii');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Register a review route with no publication or business-data mutation path. */
export function registerReviewerPrintRoutes(
  app: FastifyInstance,
  dependencies: ReviewerPrintRouteDependencies,
): void {
  requireHardenedRequestLogging(app);
  const expectedOrigin = origin(dependencies.externalOrigin);

  app.post(reviewerPath, async (request, reply) => {
    let selectedFormVersion: string;
    try {
      if (request.headers.origin !== expectedOrigin || !emptyQuery(request))
        throw new ReviewerPrintHttpInputError();
      selectedFormVersion = formVersion(request.body);
    } catch {
      return reply.code(400).send({ error: 'Request rejected' });
    }

    let context: TrustedAdministratorContext;
    try {
      const opaqueSession = cookieValue(request);
      if (opaqueSession === undefined) throw new ReviewerPrintHttpInputError();
      context = decodeTrustedAdministratorContext(
        await dependencies.authenticateAdministrator(opaqueSession),
      );
    } catch (error) {
      const authenticationFailure =
        error instanceof ReviewerPrintHttpInputError ||
        (error instanceof AdministratorSessionError &&
          error.code !== 'ADMINISTRATOR_SESSION_STORAGE');
      return reply.code(authenticationFailure ? 401 : 503).send({
        error: authenticationFailure
          ? 'Authentication required'
          : 'Reviewer view unavailable',
      });
    }

    const suppliedCsrf = request.headers['x-csrf-token'];
    if (
      typeof suppliedCsrf !== 'string' ||
      !csrfPattern.test(suppliedCsrf) ||
      !safeEqual(suppliedCsrf, context.csrfToken) ||
      !administratorHasCapability(
        context,
        administratorRoutePolicy.reviewerPrint,
      )
    )
      return reply.code(403).send({ error: 'Request rejected' });

    let result: TenantSalesforceReviewResult;
    try {
      result = await (
        dependencies.reviewer ?? reviewTenantSalesforceDefinition
      )(
        dependencies.connectionStore,
        context,
        dependencies.publisherConfiguration,
        { formVersionId: selectedFormVersion },
        dependencies.fetchImplementation,
      );
    } catch {
      return reply.code(503).send({ error: 'Reviewer view unavailable' });
    }
    if (!result.ok) {
      const storedDefinitionRefused =
        result.code === 'TENANT_REVIEW_DEFINITION' ||
        result.code === 'TENANT_REVIEW_RENDER';
      return reply
        .code(storedDefinitionRefused ? 422 : 503)
        .send({ error: 'Reviewer view unavailable' });
    }

    reply.headers({
      'Cache-Control': 'no-store',
      'Content-Security-Policy': printViewContentSecurityPolicy,
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy':
        'camera=(), display-capture=(), geolocation=(), microphone=(), payment=(), usb=()',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
    return reply.type('text/html; charset=utf-8').send(result.html);
  });
}

export const reviewerPrintRoutePaths = Object.freeze({
  render: reviewerPath,
});
