/** Production composition root for the mounted administrator publication surface. */
import { types } from 'node:util';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireHardenedRequestLogging } from './http-security.js';
import { registerPublicationAttemptPresentationRoutes } from './publication/publication-attempt-presentation-routes.js';
import type { PublicationAttemptStore } from './publication/publication-attempt-store.js';
import { registerPublicationRoutes } from './publication/publication-routes.js';
import type { TenantSalesforcePublisherConfiguration } from './publication/tenant-salesforce-publisher.js';
import type { ValidateXForm } from './publication/odk-validate.js';
import { registerAdministratorSessionRoutes } from './tenant/administrator-routes.js';
import type {
  AdministratorSessionConfiguration,
  AdministratorSessionStore,
} from './tenant/administrator-session.js';
import { AdministratorSessionError } from './tenant/administrator-session.js';
import type { TenantConnectionSessionStore } from './tenant/salesforce-session.js';

export interface PublicationSurfaceDependencies {
  readonly verifyLoginRequest: (request: FastifyRequest) => Promise<unknown>;
  readonly sessionStore: Pick<
    AdministratorSessionStore,
    'issue' | 'authenticate' | 'revoke'
  >;
  readonly sessionConfiguration: AdministratorSessionConfiguration;
  readonly connectionStore: TenantConnectionSessionStore;
  readonly attemptStore: Pick<
    PublicationAttemptStore,
    'start' | 'complete' | 'listForOperator'
  >;
  readonly publisherConfiguration: TenantSalesforcePublisherConfiguration;
  readonly validateXForm: ValidateXForm;
  readonly externalOrigin: string;
}

function ownDataRecord(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error('PUBLICATION_SURFACE_CONFIGURATION');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'),
    )
  )
    throw new Error('PUBLICATION_SURFACE_CONFIGURATION');
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
}

function checkedDependencies(
  value: PublicationSurfaceDependencies,
): PublicationSurfaceDependencies {
  const decoded = ownDataRecord(value);
  const keys = [
    'attemptStore',
    'connectionStore',
    'externalOrigin',
    'publisherConfiguration',
    'sessionConfiguration',
    'sessionStore',
    'validateXForm',
    'verifyLoginRequest',
  ];
  if (Object.keys(decoded).sort().join(',') !== keys.join(','))
    throw new Error('PUBLICATION_SURFACE_CONFIGURATION');
  if (
    typeof decoded.verifyLoginRequest !== 'function' ||
    typeof decoded.validateXForm !== 'function' ||
    typeof decoded.externalOrigin !== 'string'
  )
    throw new Error('PUBLICATION_SURFACE_CONFIGURATION');
  for (const [store, methods] of [
    [decoded.sessionStore, ['issue', 'authenticate', 'revoke']],
    [decoded.connectionStore, ['withRefreshLock']],
    [decoded.attemptStore, ['start', 'complete', 'listForOperator']],
  ] as const) {
    if (store === null || typeof store !== 'object' || types.isProxy(store))
      throw new Error('PUBLICATION_SURFACE_CONFIGURATION');
    for (const method of methods)
      if (
        typeof Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(store),
          method,
        )?.value !== 'function' &&
        typeof Object.getOwnPropertyDescriptor(store, method)?.value !==
          'function'
      )
        throw new Error('PUBLICATION_SURFACE_CONFIGURATION');
  }
  return value;
}

/** Mount all administrator publication routes as one fail-closed composition. */
export function registerPublicationSurface(
  app: FastifyInstance,
  dependenciesValue: PublicationSurfaceDependencies,
): void {
  requireHardenedRequestLogging(app);
  const dependencies = checkedDependencies(dependenciesValue);
  const authenticateAdministrator = async (opaqueSession: string) =>
    (await dependencies.sessionStore.authenticate(
      opaqueSession,
      dependencies.sessionConfiguration,
    )) ??
    (() => {
      throw new AdministratorSessionError('ADMINISTRATOR_SESSION_ABSENT');
    })();

  // Session issuance is registered first; every protected adapter receives only
  // the single live-session resolver constructed above.
  registerAdministratorSessionRoutes(app, {
    verifyLoginRequest: dependencies.verifyLoginRequest,
    sessionStore: dependencies.sessionStore,
    sessionConfiguration: dependencies.sessionConfiguration,
    externalOrigin: dependencies.externalOrigin,
  });
  registerPublicationRoutes(app, {
    authenticateAdministrator,
    connectionStore: dependencies.connectionStore,
    attemptStore: dependencies.attemptStore,
    publisherConfiguration: dependencies.publisherConfiguration,
    validateXForm: dependencies.validateXForm,
    externalOrigin: dependencies.externalOrigin,
  });
  registerPublicationAttemptPresentationRoutes(app, {
    authenticateAdministrator,
    attemptStore: dependencies.attemptStore,
    externalOrigin: dependencies.externalOrigin,
  });
}
