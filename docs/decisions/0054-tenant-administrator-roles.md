# ADR 0054: Tenant administrator roles and live re-scoping

- Status: Proposed; implementation awaiting independent verification
- Date: 2026-10-28
- Brief sections: C1.3a, C2, C5, C8, C11 Phase 1
- Decision owner: Bill Owiti / Cobitech Solutions
- Extends: ADRs 0042, 0043, 0044, 0047, 0050, 0052 and 0053

## Context

ADRs 0052 and 0053 provide one-shot bootstrap, peer enrolment and peer
deprovisioning, but every active binding has unrestricted administrator authority.
That makes a person who only reviews publication history able to enrol and remove
operators, reconnect Salesforce and publish forms. It also means reducing authority
would require deprovisioning and creating a new identity, which conflicts with the
immutable actor-to-tenant binding and its audit history.

Bill approved a closed three-role model. Role authority must come from the live
PostgreSQL binding on every request, never from a browser field, token claim, header,
query parameter or cached session value. A role change must therefore affect an
already issued session immediately without replacing its cookie.

## Decision

### Use one closed capability matrix

Every active binding has exactly one of these roles:

| Role            | Administrator lifecycle | Salesforce authorization | Publish | Publication history |
| --------------- | ----------------------- | ------------------------ | ------- | ------------------- |
| `administrator` | yes                     | yes                      | yes     | yes                 |
| `publisher`     | no                      | no                       | yes     | yes                 |
| `reviewer`      | no                      | no                       | no      | yes                 |

Login, CSRF bootstrap and logout remain available to every active role. The static
operator shell is not authority; each API request still resolves the opaque session
against the live binding and enforces the capability assigned to that route. The
OAuth start and callback both require `administrator`, so demotion during an OAuth
round trip prevents completion before credential exchange. Publication accepts
`administrator` or `publisher`. Attempt presentation accepts all three roles.

`administratorHasCapability` is the only role-to-capability mapping. Request bodies
may select a target role only on administrator lifecycle operations. They cannot
select the performing role or tenant, and lower roles cannot invoke any enrolment,
deprovisioning or role-change operation.

### Audit enrolment and role change atomically

Migration `0009_administrator_roles` adds a non-null `role` column with a closed
database check. It backfills every pre-existing active or inactive binding as
`administrator`, preserving the authority it had before this migration, then leaves
no column default that could silently elevate a future insert. New bootstrap bindings
are explicitly administrators; peer enrolment requires the requested role.

`tenant_administrator_role_audits` records the tenant, performing actor, target
actor, action, previous role, new role and database timestamp. Enrolment records a
null previous role and `enrol`; an actual role transition records `change` and both
distinct roles. The state write and audit write share one PostgreSQL statement and
transaction. As with the existing audit tables, append-only is a Kusanya write-path
property, not tamper evidence against a privileged database role.

`PATCH /api/admin/administrators` changes one peer's role. The route requires exact
origin, a live session, session-derived CSRF and `administrator` authority before it
parses the bounded `{subject, role}` body. The configured issuer derives the target
actor. Self-change, no-op, absent, inactive, cross-tenant and unauthorized changes
share the fixed unavailable response.

### Prevent tenant lockout under concurrency

Enrolment, role change and deprovisioning take the same per-tenant advisory lock.
Role change and deprovisioning then lock all active tenant bindings in deterministic
actor order. Only a live `administrator` may perform either operation. Demoting or
removing an administrator requires another active administrator to remain.
Concurrent reciprocal demotions therefore have at most one winner. Self-role change
stays forbidden so a single full administrator cannot remove their own recovery
authority.

The one-shot bootstrap command cannot recover an existing tenant. Deployment and
customer onboarding guidance must enrol a second full administrator promptly. This
answers note 113 operationally without adding an unauthenticated recovery path.

## Alternatives considered

- Put the role in the OIDC token or session cookie. Rejected because an old token or
  cookie would retain stale authority after demotion and the identity provider does
  not own Kusanya tenant authorization.
- Accept a role header per request. Rejected because it gives untrusted input direct
  control over authorization.
- Give publishers Salesforce authorization. Rejected because connecting or replacing
  the tenant credential is a tenant-administration operation, not publication.
- Let operators change their own roles. Rejected because it permits self-elevation
  and makes last-administrator protection ambiguous.
- Delete and re-enrol an actor to change authority. Rejected because bindings are
  immutable tombstones and the operation would fragment identity and audit history.

## Consequences and verification

Role changes immediately re-scope existing sessions because authentication selects
the current role from PostgreSQL on every request. The UI can enrol a subject at a
chosen role or change a peer role, but it stores no role authority in browser state.
OpenAPI documents the closed role values and the PATCH lifecycle operation without
exposing actor, tenant, org, origin or namespace selectors.

Unit tests cover the complete matrix, lower-role lifecycle denial, publisher publish
access, reviewer history-only access, OAuth denial at both boundaries, hostile role
input, generic failures and atomic SQL shape. PostgreSQL 17 integration tests cover
migration backfill without a persistent default, checked role values, enrol/change audits, immediate re-scoping
of an existing session, and concurrent reciprocal demotion retaining one full
administrator.

Note 34 advances through the role model but remains open for invitations,
retention/deletion, scheduled reconciliation, privileged retry, disconnect/rebind,
the publish CLI and runtime validator assets. Note 39 remains open. Notes 75, 80,
81, 82, 84, 86, 104, 105, 113 and 114 are informational. No C10 acceptance test,
publish-ready state or Phase 1 completion is claimed.

## Revisit when

Kusanya adds invitations, tenant suspension, supervised self-removal, emergency
recovery, custom roles or database-role enforcement for tamper-evident audits.
