# ADR 0041: Trusted administrator OAuth route contract

- Status: Proposed; implementation awaiting independent verification
- Date: 2026-10-19
- Brief sections: C1.3a, C2, C4 Tenant Connection, C8, C11 Phase 1
- Decision owner: Cobitech Solutions
- Extends: ADRs 0038, 0039 and 0040

## Context

ADR 0040 deliberately kept the Salesforce authorization protocol behind an internal
boundary. An HTTP adapter must not turn a tenant header, request body, query value or
Salesforce callback into trusted tenant selection. It must also stop login CSRF: an
attacker must not be able to start a grant in one browser and make another browser
complete it. The repository does not yet contain a concrete administrator identity
provider, session issuer or tenant-provisioning workflow, so mounting a partially
authenticated route in the running service would be unsafe.

The independent review of ADR 0040 also identified five bounded ambiguities: the
authorizing Salesforce user was discarded; org comparison preceded response
signature verification; response scope and token format were not checked; expired
state remained until the next start; and Salesforce provider errors include a human
description that the strict core callback must never ingest or reflect.

## Decision

### Require a server-verified principal before route registration

`registerTenantOAuthRoutes` requires an injected `authenticateAdministrator`
capability. It receives only the opaque `__Host-kusanya_admin_session` cookie, not
the Fastify request, and returns one strictly decoded context: actor, tenant UUID,
expected Salesforce org, authorization origin, namespace and CSRF token. The route
has no tenant/org input field and never reads tenant-selection headers. Forged
tenant or org headers therefore cannot affect the stored transaction even if present.

The start operation is a bodyless, queryless POST. It requires the exact configured
public HTTPS `Origin` and a constant-time match against the CSRF token belonging to
the verified session. Missing/invalid sessions return a fixed 401; origin, CSRF and
request-shape refusals reveal no context. The external origin must exactly own the
configured callback URL before routes can register.

This is a composition contract, not an identity provider. `main.ts` does not mount
these routes. A later unit must implement the session issuer/verifier and tenant
provisioning, wire deployment secrets, and then register the adapter. It may not
derive context from a reverse-proxy header unless that header has a separately
reviewed, cryptographically authenticated boundary.

### Bind the callback to the browser that initiated it

On start, the adapter derives an HMAC-SHA256 browser binding over the random OAuth
state using the existing deployment state secret under a distinct versioned domain.
Only that digest is placed in `__Host-kusanya_oauth_binding`, with `Secure`,
`HttpOnly`, `SameSite=Lax`, `Path=/` and the same maximum age as the transaction.
The state itself remains only in Salesforce's redirect URL and its SHA-256 digest
remains in PostgreSQL.

The callback requires the returned state and cookie digest to match in constant
time before the core consumes state or contacts Salesforce. ADR 0042 strengthens
the binding to cover the exact initiating administrator session and requires that
session to remain live at callback time. Logout, operator revocation or login-time
session replacement therefore prevents an outstanding grant from completing. The
binding cookie is expired on every callback response. Duplicate cookies, duplicate
query values, unrecognized keys, cross-browser or cross-session states and malformed
values fail closed.

Salesforce `error_description` is accepted only alongside a provider `error` at the
HTTP edge, shape-bounded, then discarded. It is never logged, reflected or forwarded
to the core. Success returns only `{ "status": "connected" }`; failures are fixed
generic bodies with `Cache-Control: no-store`.

### Tighten the signed grant and state lifecycle

The provider response signature is now authenticated before expected-org comparison,
so `TENANT_OAUTH_BINDING` describes a signed Salesforce identity rather than forged
response content. The exact requested `api refresh_token` scope is required;
`token_format`, when supplied, must be `jwt`. The validated `005` authorizing user ID
is returned as non-secret metadata for later audit composition.

Any user whom the Salesforce connected/external client app permits to authorize in
the expected org may grant the connection. This unit does not impose one preselected
Salesforce user, because the trusted service administrator and the integration user
need not be the same person. The later mounted workflow must durably audit both its
trusted actor and the returned Salesforce user ID.

Consuming a state now deletes a matching row even when expired, returning it only if
it was still live. Expiry therefore remains a refusal while also self-cleaning the
bounded transaction row.

## Consequences and verification

Unit tests prove that forged tenant/org headers cannot alter the authenticated
binding; missing authentication, cross-origin starts, wrong CSRF, nonempty requests,
duplicate cookies, hostile principal objects and cross-browser callbacks fail before
connection persistence. They pin all cookie attributes, provider-description
normalization, fixed response bodies and callback state consumption. Core tests prove
signature-before-binding, scope/token-format enforcement and authorizing-user return.
A PostgreSQL integration test proves an expired transaction is refused and deleted.

This advances note 34 through a reviewable HTTP adapter but does not close it. ADR
0042 supplies the internal session issuer and immutable provisioning store, but a
concrete identity verifier and approved provisioning operator, deployment secret
wiring, audit persistence, privileged disconnect/rebind, final publisher composition
and publish CLI remain. The adapter is intentionally absent from the running app and
OpenAPI until those mounting requirements are implemented. No live Salesforce grant,
metadata, package, scratch org, C10 acceptance test, publish-ready state or Phase 1
completion is claimed.

## Revisit when

The administrator identity provider and provisioning workflow are selected, the
routes are mounted, actor/Salesforce-user audits are persisted, privileged rebind or
disconnect is exposed, the public origin changes, or multiple concurrent grants per
tenant are required.
