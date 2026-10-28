# ADR 0052: Tenant-bound operator access and keyset pagination

- Status: Proposed; implementation awaiting independent verification
- Date: 2026-10-27
- Brief sections: C1.3a, C2, C5, C8, C11 Phase 1
- Decision owner: Bill Owiti / Cobitech Solutions
- Extends: ADRs 0042, 0043, 0049 and 0050

## Context

The mounted administrator APIs can issue and revoke sessions, publish one Form
Version and present the newest 100 publication attempts. They do not yet provide an
operator interface, a safe way for an existing tenant administrator to enrol another
identity, or a way to continue past the first attempt page. Accepting a tenant, org,
namespace or actor from those new requests would bypass the immutable provisioning
tuple established by ADR 0043.

Bill approved one boundary-sized unit covering the browser shell, same-tenant actor
enrolment and bounded pagination. For this unit, self-service provisioning means a
live tenant administrator enrolling another subject from the already configured
OIDC issuer into that same immutable tenant. It does not mean first-tenant bootstrap,
role elevation, cross-tenant administration, disconnect or rebind.

## Decision

### Derive the actor and copy the live tenant tuple

`POST /api/admin/administrators` accepts exactly one field, `subject`. The actor ID
is derived by the same immutable OIDC identity capability that verifies login: the
configured issuer and supplied subject are hashed through the existing stable mapper.
The request cannot supply an actor ID, tenant UUID, Salesforce org, authorization
origin or namespace.

The adapter checks the exact configured HTTPS origin, authenticates the opaque
host-only session, validates its session-derived CSRF token, and only then parses the
query and body. It calls the existing serializable `AdministratorSessionStore`
provisioning operation with the live session's complete tenant tuple. Existing
actor-to-tenant bindings remain immutable; a subject already bound elsewhere returns
the same fixed unavailable response as any storage refusal, exposing no actor or
tenant detail and never identifying the other tenant. A caller can still distinguish
successful enrolment from the generic unavailable outcome; the route does not claim
to hide that one outcome bit. Initial bootstrap stays an audited
operator/deployment concern outside this route.

### Paginate with an untrusted, non-authoritative cursor

The publication-attempt view remains one tenant-scoped, SELECT-only query with a hard
limit of 100. A continuation cursor is canonical base64url over the last row's exact
PostgreSQL microsecond timestamp, a NUL delimiter and its UUID. The cursor grants no
authority: every page repeats the complete actor/tenant/org/origin/namespace join
from the live session. Keyset comparison on `(created_at, publication_attempt_id)`
avoids duplicate or skipped rows when timestamps are equal. Malformed, repeated or
additional query parameters fail closed.

The response still contains only the six ADR 0049 summary fields plus an opaque
nullable `nextCursor`; it never returns tenant identity, cursor components,
credentials, provider data, digests, ContentVersion IDs, failure codes or request
counts.

### Serve a static shell over the existing APIs

`GET /admin` serves one self-contained HTML document with no tenant data, token or
configuration embedded and no external asset request. The browser keeps the
short-lived Kusanya API access token only long enough to send the redacted login
request, clears its input immediately, and keeps the returned CSRF value only in
memory. All data and mutations still cross the existing same-origin APIs.

The document renders server data only with `textContent`, stores nothing in browser
storage and uses a real CSP response header whose hashes pin its single inline style
and script. `default-src 'none'`, `connect-src 'self'`, `form-action 'self'` and
`frame-ancestors 'none'` accompany no-store, nosniff, same-origin opener/resource,
no-referrer and restrictive permissions headers. The interface has no reconciliation,
retry, retention, deletion, disconnect or rebind control.

## Alternatives considered

- Accept tenant and actor identifiers from the enrolment request. Rejected because
  they are authorization selectors and would bypass the live immutable context.
- Let a new subject create its own tenant. Rejected because no trusted source yet
  establishes the initial org/origin/namespace tuple or grants bootstrap authority.
- Use offset pagination. Rejected because concurrent inserts can duplicate or skip
  rows and large offsets make the bounded operator path increasingly expensive.
- Put tenant data or identity-provider configuration into server-rendered HTML.
  Rejected to keep the static shell non-authoritative and least-data.
- Add a browser framework or persist tokens in storage. Rejected because this small
  surface needs neither dependency and persistence would enlarge the credential and
  supply-chain boundary.

## Consequences and verification

An already provisioned administrator can now reach the mounted product surface,
enrol a peer in the same tenant, publish a Form Version and page through attempt
history. Initial bootstrap still requires a separately reviewed mechanism, and an
operator must know the new identity's exact OIDC subject. All enrolled administrators
currently have the same tenant-administrator authority; this unit introduces no role
model.

Unit tests exercise origin/session/CSRF ordering, hostile request shapes, generic
conflicts, identity derivation, composition reachability, CSP hashes, DOM sinks,
in-memory credentials and cursor validation. PostgreSQL tests cross the HTTP/store
seam to prove a foreign binding cannot move tenants and that a new actor receives
only the live tenant tuple. A second database probe pages more than 100 rows across
equal-time ordering without duplication or cross-tenant disclosure.

The unit does not change `salesforce/`, `.github/` or `scripts/`. Its hosted check is
therefore expected to be the first live ADR 0051 Salesforce-identical exemption: the
policy and gate must pass, the Apex job must be intentionally skipped, and no
protected approval or scratch org may be used. That is negative-control evidence,
not Apex, C10, phase-gate or namespaced evidence.

Note 34 advances through operator presentation, bounded pagination and same-tenant
enrolment but remains open for initial bootstrap, retention/deletion, scheduled
reconciliation, privileged retry, disconnect/rebind and the publish CLI. Note 39 is
unchanged. No C10 acceptance test, publish-ready state or Phase 1 completion is
claimed.

## Revisit when

Kusanya introduces roles, tenant invitations, an audited initial-bootstrap authority,
privileged connection lifecycle operations, a full OIDC browser redirect client, or
attempt-list filters whose stable ordering cannot fit this cursor contract.
