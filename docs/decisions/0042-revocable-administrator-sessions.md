# ADR 0042: Revocable administrator sessions and immutable provisioning

- Status: Accepted; verified in PR #77 and refined by ADRs 0043-0044
- Date: 2026-10-19
- Brief sections: C1.3a, C2, C4 Tenant Connection, C8, C11 Phase 1
- Decision owner: Cobitech Solutions
- Extends: ADRs 0038, 0040 and 0041

## Context

ADR 0041 defines an unmounted OAuth route adapter but deliberately injects its
administrator-session verifier. A concrete verifier must not accept a tenant header,
turn an attacker-selected pre-login cookie into an authenticated session, or cache a
revoked assertion. The same actor must not silently move between tenants or expected
Salesforce orgs. Independent review also raised note 95: logout or revocation between
OAuth start and callback did not prevent the outstanding grant from completing.

This unit still does not choose an external administrator identity provider. It
defines the internal issuer boundary that a future reviewed login verifier may call
with a stable, trusted actor identifier, and the provisioning boundary an approved
operator must populate outside public request input.

## Decision

### Provision one immutable binding per trusted actor

ADR 0043 normalizes the provisioning model after independent review.
`tenant_administrator_tenants` owns exactly one normalized Salesforce `00D` org,
Salesforce authorization origin and namespace prefix per tenant UUID, while
`tenant_administrator_bindings` maps a bounded internal actor identifier only to that
tenant. `AdministratorSessionStore.provision` is idempotent only when both mappings
are identical. An attempted tenant, org, origin or namespace change returns the fixed
`ADMINISTRATOR_SESSION_CONFLICT`; it never updates stored context.

The actor identifier must come from a future cryptographically verified identity
mapping, never a request header, cookie body, query or Salesforce callback. This API
does not provide a public provisioning route or a rebind mechanism. A future rebind
must be an explicit privileged and audited operation, not an upsert side effect.

### Rotate to a new opaque session after every successful login

The issuer accepts no caller-proposed session identifier. It generates 32 random
bytes and returns their 43-character base64url encoding only to its trusted caller.
PostgreSQL stores only the SHA-256 digest. A unique actor constraint permits one
active session per provisioned actor; issuing a new session atomically replaces the
prior digest and expiry. A fixed or stolen pre-login cookie is therefore never
upgraded across the authentication boundary.

CSRF is a versioned HMAC-SHA256 derived from the opaque session under a separate
32-byte deployment secret. It is returned with the session but is not persisted.
Session configuration accepts only canonical base64 for exactly 32 bytes and a TTL
from 5 minutes through 8 hours. The future HTTP composition must set the opaque value
in a `Secure`, `HttpOnly`, `SameSite=Lax`, host-only cookie and must supply the derived
CSRF only to same-origin application code through a reviewed mechanism.

### Check live database state on every authenticated request

Authentication hashes the presented opaque value and performs a live PostgreSQL
lookup; it does not use a self-contained JWT or cache. Logout deletes the matching
digest, operator/security revocation deletes the actor's sole session, and both take
effect on the next request across replicas. Matching expired rows are deleted while
returning no principal. Errors are fixed codes and neither tokens nor database
details are reflected.

The returned frozen context is reconstructed by joining the actor to the immutable
tenant provisioning row and
contains the actor, tenant, org, authorization origin, namespace and session-derived
CSRF token. Tenant identity never comes from the request.

### Require the initiating session through OAuth completion

ADR 0041's browser binding now authenticates both the one-time OAuth state and the
exact opaque administrator session under the existing state secret. The callback
must present that session and the verifier must still resolve it before state is
consumed or Salesforce is contacted. Revocation makes the callback return a fixed
authentication refusal; replacement by a later login produces a binding mismatch.
This closes note 95 at the adapter boundary while retaining `SameSite=Lax` compatibility
for the top-level Salesforce redirect.

## Consequences and verification

Unit tests cover normalization, exact idempotency, immutable-binding conflicts,
fresh issuance, digest-only persistence, deterministic CSRF derivation, atomic
replacement, fixation resistance, expiry cleanup, immediate session and actor
revocation, hostile inputs and fixed secret-free failures. Route tests prove that a
different valid session and a revoked initiating session cannot consume OAuth state
or contact Salesforce. A PostgreSQL integration test applies the migration twice,
inspects raw rows for token absence, races two issuances to one active digest, and
measures replacement, conflict, expiry and revocation against the real database.

This advances note 34 but does not close it. ADR 0045 adds the atomic audit tying the
trusted actor to Salesforce's validated `005` user. ADR 0050 later supplies OIDC
identity, stable actor mapping and deployment wiring. Approved self-service
provisioning, privileged disconnect/rebind and the publish CLI remain. ADR 0044 adds
the secure cookie/login/logout adapter and closes note 94 with a runtime hardened-host
registration check; ADR 0050 later mounts the publication surface and updates
OpenAPI. No live Salesforce grant, C10 acceptance test, publish-ready state or Phase
1 completion was claimed by this decision.

## Revisit when

The external administrator identity provider is selected, actor provisioning or
rebind is exposed, session-secret rotation is operationalized, concurrent sessions
per actor are required, the routes are mounted, or the trusted-actor/Salesforce-user
audit is persisted.
