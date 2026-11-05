/** Administrator-only disconnect and disconnected-tenant rebind boundary. */
import { timingSafeEqual } from 'node:crypto';
import { types } from 'node:util';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireHardenedRequestLogging } from '../http-security.js';
import {
  administratorHasCapability,
  administratorRoutePolicy,
} from './administrator-authorization.js';
import { readAdministratorSessionCookie } from './administrator-cookie.js';
import {
  normalizeSalesforceOrgId,
  TenantConnectionError,
  type TenantConnectionStore,
} from './connection-store.js';
import {
  administratorNamespacePrefix,
  AdministratorSessionError,
  decodeTrustedAdministratorContext,
  type TrustedAdministratorContext,
} from './administrator-session.js';

const disconnectPath = '/api/admin/salesforce/connection/disconnect';
const rebindPath = '/api/admin/salesforce/connection/rebind';
const csrfPattern = /^[A-Za-z0-9_-]{43}$/;

class TenantConnectionLifecycleInputError extends Error {}
class TenantConnectionLifecycleAuthenticationError extends Error {}
class TenantConnectionLifecycleAuthorizationError extends Error {}

export interface TenantConnectionLifecycleRouteDependencies {
  readonly authenticateAdministrator: (
    opaqueSession: string,
  ) => Promise<TrustedAdministratorContext>;
  readonly connectionStore: Pick<
    TenantConnectionStore,
    'disconnect' | 'rebind'
  >;
  readonly externalOrigin: string;
}

function exactOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048)
    throw new TenantConnectionLifecycleInputError();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TenantConnectionLifecycleInputError();
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.origin !== value ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    !parsed.hostname.endsWith('.salesforce.com')
  )
    throw new TenantConnectionLifecycleInputError();
  return parsed.origin;
}

function serviceOrigin(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== 'https:' ||
    parsed.origin !== value ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== ''
  )
    throw new Error('TENANT_CONNECTION_LIFECYCLE_CONFIGURATION');
  return parsed.origin;
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new TenantConnectionLifecycleInputError();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'),
    )
  )
    throw new TenantConnectionLifecycleInputError();
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
}

function rebindTarget(value: unknown): {
  salesforceOrgId: string;
  authorizationOrigin: string;
  namespacePrefix: string;
} {
  const input = plainRecord(value);
  if (
    Object.keys(input).sort().join(',') !==
    'authorizationOrigin,namespacePrefix,salesforceOrgId'
  )
    throw new TenantConnectionLifecycleInputError();
  try {
    return Object.freeze({
      salesforceOrgId: normalizeSalesforceOrgId(input.salesforceOrgId),
      authorizationOrigin: exactOrigin(input.authorizationOrigin),
      namespacePrefix: administratorNamespacePrefix(input.namespacePrefix),
    });
  } catch {
    throw new TenantConnectionLifecycleInputError();
  }
}

function cookieValue(request: FastifyRequest): string | undefined {
  try {
    return readAdministratorSessionCookie(request.headers.cookie);
  } catch {
    throw new TenantConnectionLifecycleInputError();
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
  dependencies: TenantConnectionLifecycleRouteDependencies,
  expectedOrigin: string,
): Promise<TrustedAdministratorContext> {
  if (request.headers.origin !== expectedOrigin)
    throw new TenantConnectionLifecycleInputError();
  let opaqueSession: string | undefined;
  try {
    opaqueSession = cookieValue(request);
  } catch {
    throw new TenantConnectionLifecycleAuthenticationError();
  }
  if (opaqueSession === undefined)
    throw new TenantConnectionLifecycleAuthenticationError();
  let context: TrustedAdministratorContext;
  try {
    context = decodeTrustedAdministratorContext(
      await dependencies.authenticateAdministrator(opaqueSession),
    );
  } catch (error) {
    if (
      error instanceof AdministratorSessionError &&
      error.code === 'ADMINISTRATOR_SESSION_STORAGE'
    )
      throw error;
    throw new TenantConnectionLifecycleAuthenticationError();
  }
  const suppliedCsrf = request.headers['x-csrf-token'];
  if (
    typeof suppliedCsrf !== 'string' ||
    !csrfPattern.test(suppliedCsrf) ||
    !safeEqual(suppliedCsrf, context.csrfToken) ||
    !administratorHasCapability(
      context,
      administratorRoutePolicy.salesforceConnectionLifecycle,
    )
  )
    throw new TenantConnectionLifecycleAuthorizationError();
  return context;
}

function currentBinding(context: TrustedAdministratorContext) {
  return {
    actorId: context.actorId,
    tenantId: context.tenantId,
    salesforceOrgId: context.expectedSalesforceOrgId,
    authorizationOrigin: context.authorizationOrigin,
    namespacePrefix: context.namespacePrefix,
  } as const;
}

function responseCode(error: unknown): 400 | 401 | 403 | 409 | 503 {
  if (error instanceof TenantConnectionLifecycleInputError) return 400;
  if (error instanceof TenantConnectionLifecycleAuthenticationError) return 401;
  if (error instanceof TenantConnectionLifecycleAuthorizationError) return 403;
  if (
    error instanceof TenantConnectionError &&
    error.code === 'TENANT_CONNECTION_CONFLICT'
  )
    return 409;
  if (
    error instanceof TenantConnectionError &&
    error.code === 'TENANT_CONNECTION_INPUT'
  )
    return 400;
  return 503;
}

function responseMessage(code: number): string {
  if (code === 400) return 'Request rejected';
  if (code === 401) return 'Authentication required';
  if (code === 403) return 'Request rejected';
  if (code === 409) return 'Connection change refused';
  return 'Connection change unavailable';
}

/** Mount the only HTTP paths that can disconnect or change a tenant org binding. */
export function registerTenantConnectionLifecycleRoutes(
  app: FastifyInstance,
  dependencies: TenantConnectionLifecycleRouteDependencies,
): void {
  requireHardenedRequestLogging(app);
  const expectedOrigin = serviceOrigin(dependencies.externalOrigin);
  app.post(
    disconnectPath,
    {
      schema: {
        response: {
          204: { type: 'null' },
          400: errorSchema,
          401: errorSchema,
          403: errorSchema,
          409: errorSchema,
          503: errorSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const context = await authorize(request, dependencies, expectedOrigin);
        if (
          Object.keys(plainRecord(request.query)).length !== 0 ||
          request.body !== undefined
        )
          return reply.code(400).send({ error: 'Request rejected' });
        await dependencies.connectionStore.disconnect(currentBinding(context));
        return reply.header('Cache-Control', 'no-store').code(204).send();
      } catch (error) {
        const code = responseCode(error);
        return reply.code(code).send({ error: responseMessage(code) });
      }
    },
  );

  app.post(
    rebindPath,
    {
      schema: {
        response: {
          204: { type: 'null' },
          400: errorSchema,
          401: errorSchema,
          403: errorSchema,
          409: errorSchema,
          503: errorSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const context = await authorize(request, dependencies, expectedOrigin);
        if (Object.keys(plainRecord(request.query)).length !== 0)
          return reply.code(400).send({ error: 'Request rejected' });
        const target = rebindTarget(request.body);
        if (
          target.salesforceOrgId === context.expectedSalesforceOrgId &&
          target.authorizationOrigin === context.authorizationOrigin &&
          target.namespacePrefix === context.namespacePrefix
        )
          return reply.code(400).send({ error: 'Request rejected' });
        await dependencies.connectionStore.rebind({
          ...currentBinding(context),
          newSalesforceOrgId: target.salesforceOrgId,
          newAuthorizationOrigin: target.authorizationOrigin,
          newNamespacePrefix: target.namespacePrefix,
        });
        return reply.header('Cache-Control', 'no-store').code(204).send();
      } catch (error) {
        const code = responseCode(error);
        return reply.code(code).send({ error: responseMessage(code) });
      }
    },
  );
}

export const tenantConnectionLifecycleRoutePaths = Object.freeze({
  disconnect: disconnectPath,
  rebind: rebindPath,
});
