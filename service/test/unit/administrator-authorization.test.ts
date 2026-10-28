import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  administratorHasCapability,
  administratorRoutePolicy,
} from '../../src/tenant/administrator-authorization.js';
import type {
  AdministratorRole,
  TrustedAdministratorContext,
} from '../../src/tenant/administrator-session.js';

function context(role: AdministratorRole): TrustedAdministratorContext {
  return Object.freeze({
    actorId: 'oidc:synthetic',
    tenantId: '10000000-0000-4000-8000-000000000001',
    expectedSalesforceOrgId: '00D000000000001EAA',
    authorizationOrigin: 'https://login.salesforce.com',
    namespacePrefix: '',
    role,
    csrfToken: 'c'.repeat(43),
  });
}

void test('one closed matrix authorizes every administrator route capability', () => {
  const expected = {
    administrator: [true, true, true, true],
    publisher: [false, false, true, true],
    reviewer: [false, false, false, true],
  } as const;
  const capabilities = [
    administratorRoutePolicy.administratorLifecycle,
    administratorRoutePolicy.salesforceAuthorization,
    administratorRoutePolicy.salesforcePublication,
    administratorRoutePolicy.publicationHistory,
  ] as const;
  for (const [role, decisions] of Object.entries(expected))
    assert.deepEqual(
      capabilities.map((capability) =>
        administratorHasCapability(
          context(role as AdministratorRole),
          capability,
        ),
      ),
      decisions,
    );
});
