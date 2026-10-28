/** Closed role-to-capability policy for every administrator HTTP route. */
import type {
  AdministratorRole,
  TrustedAdministratorContext,
} from './administrator-session.js';

export type AdministratorCapability =
  | 'manage_administrators'
  | 'manage_publication_retention'
  | 'authorize_salesforce'
  | 'publish'
  | 'view_publication_history';

const roleCapabilities = Object.freeze({
  administrator: Object.freeze([
    'manage_administrators',
    'manage_publication_retention',
    'authorize_salesforce',
    'publish',
    'view_publication_history',
  ]),
  publisher: Object.freeze(['publish', 'view_publication_history']),
  reviewer: Object.freeze(['view_publication_history']),
} satisfies Record<AdministratorRole, readonly AdministratorCapability[]>);

/** Authorize only the live role already decoded from PostgreSQL. */
export function administratorHasCapability(
  context: TrustedAdministratorContext,
  capability: AdministratorCapability,
): boolean {
  return (
    roleCapabilities[context.role] as readonly AdministratorCapability[]
  ).includes(capability);
}

export const administratorRoutePolicy = Object.freeze({
  administratorLifecycle: 'manage_administrators',
  publicationRetention: 'manage_publication_retention',
  salesforceAuthorization: 'authorize_salesforce',
  salesforcePublication: 'publish',
  publicationHistory: 'view_publication_history',
} as const satisfies Record<string, AdministratorCapability>);
