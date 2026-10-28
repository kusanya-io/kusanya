/** Production composition root for the mounted administrator publication surface. */
import { types } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { requireHardenedRequestLogging } from './http-security.js';
import { registerOperatorInterfaceRoutes } from './operator-interface-routes.js';
import { registerPublicationAttemptPresentationRoutes } from './publication/publication-attempt-presentation-routes.js';
import type { PublicationAttemptStore } from './publication/publication-attempt-store.js';
import { registerPublicationRoutes } from './publication/publication-routes.js';
import type { TenantSalesforcePublisherConfiguration } from './publication/tenant-salesforce-publisher.js';
import type { ValidateXForm } from './publication/odk-validate.js';
import { registerAdministratorSessionRoutes } from './tenant/administrator-routes.js';
import { registerAdministratorInvitationRoutes } from './tenant/administrator-invitation-routes.js';
import type {
  AdministratorInvitationConfiguration,
  AdministratorInvitationStore,
} from './tenant/administrator-invitation.js';
import { registerAdministratorProvisioningRoutes } from './tenant/administrator-provisioning-routes.js';
import type {
  AdministratorSessionConfiguration,
  AdministratorSessionStore,
} from './tenant/administrator-session.js';
import { AdministratorSessionError } from './tenant/administrator-session.js';
import type { AdministratorOidcIdentity } from './tenant/oidc-login.js';
import type { TenantConnectionSessionStore } from './tenant/salesforce-session.js';

export interface PublicationSurfaceDependencies {
  readonly administratorIdentity: AdministratorOidcIdentity;
  readonly sessionStore: Pick<
    AdministratorSessionStore,
    'issue' | 'authenticate' | 'revoke' | 'deprovision' | 'changeRole'
  >;
  readonly invitationStore: Pick<
    AdministratorInvitationStore,
    'accept' | 'issue' | 'revoke'
  >;
  readonly invitationConfiguration: AdministratorInvitationConfiguration;
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
    'administratorIdentity',
    'attemptStore',
    'connectionStore',
    'externalOrigin',
    'invitationConfiguration',
    'invitationStore',
    'publisherConfiguration',
    'sessionConfiguration',
    'sessionStore',
    'validateXForm',
  ];
  if (Object.keys(decoded).sort().join(',') !== keys.join(','))
    throw new Error('PUBLICATION_SURFACE_CONFIGURATION');
  if (
    typeof decoded.validateXForm !== 'function' ||
    typeof decoded.externalOrigin !== 'string'
  )
    throw new Error('PUBLICATION_SURFACE_CONFIGURATION');
  const identity = ownDataRecord(decoded.administratorIdentity);
  if (
    Object.keys(identity).sort().join(',') !==
      ['actorIdForSubject', 'verifyLoginRequest'].join(',') ||
    typeof identity.verifyLoginRequest !== 'function' ||
    typeof identity.actorIdForSubject !== 'function'
  )
    throw new Error('PUBLICATION_SURFACE_CONFIGURATION');
  for (const [store, methods] of [
    [
      decoded.sessionStore,
      ['issue', 'authenticate', 'deprovision', 'changeRole', 'revoke'],
    ],
    [decoded.invitationStore, ['accept', 'issue', 'revoke']],
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
  const sessionRoutesStore = Object.freeze({
    issue: dependencies.sessionStore.issue.bind(dependencies.sessionStore),
    authenticate: dependencies.sessionStore.authenticate.bind(
      dependencies.sessionStore,
    ),
    revoke: dependencies.sessionStore.revoke.bind(dependencies.sessionStore),
  });
  const lifecycleStore = Object.freeze({
    deprovision: dependencies.sessionStore.deprovision.bind(
      dependencies.sessionStore,
    ),
    changeRole: dependencies.sessionStore.changeRole.bind(
      dependencies.sessionStore,
    ),
  });
  const invitationRoutesStore = Object.freeze({
    issue: dependencies.invitationStore.issue.bind(
      dependencies.invitationStore,
    ),
    revoke: dependencies.invitationStore.revoke.bind(
      dependencies.invitationStore,
    ),
  });
  const invitationAcceptanceStore = Object.freeze({
    accept: dependencies.invitationStore.accept.bind(
      dependencies.invitationStore,
    ),
  });

  // Session issuance is registered first; every protected adapter receives only
  // the single live-session resolver constructed above.
  registerAdministratorSessionRoutes(app, {
    verifyLoginRequest: dependencies.administratorIdentity.verifyLoginRequest,
    sessionStore: sessionRoutesStore,
    invitationStore: invitationAcceptanceStore,
    sessionConfiguration: dependencies.sessionConfiguration,
    externalOrigin: dependencies.externalOrigin,
  });
  registerAdministratorProvisioningRoutes(app, {
    authenticateAdministrator,
    actorIdForSubject: dependencies.administratorIdentity.actorIdForSubject,
    sessionStore: lifecycleStore,
    externalOrigin: dependencies.externalOrigin,
  });
  registerAdministratorInvitationRoutes(app, {
    authenticateAdministrator,
    actorIdForSubject: dependencies.administratorIdentity.actorIdForSubject,
    invitationStore: invitationRoutesStore,
    invitationConfiguration: dependencies.invitationConfiguration,
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
  registerOperatorInterfaceRoutes(app);
}
