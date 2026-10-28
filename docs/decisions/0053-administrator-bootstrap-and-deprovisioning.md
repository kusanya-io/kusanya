# ADR 0053: Administrator bootstrap and deprovisioning lifecycle

- Status: Proposed; implementation awaiting independent verification
- Date: 2026-10-27
- Brief sections: C1.3a, C2, C5, C8, C11 Phase 1
- Decision owner: Bill Owiti / Cobitech Solutions
- Extends: ADRs 0042, 0043, 0045, 0050 and 0052

## Context

ADR 0052 lets an existing administrator enrol another subject into the same immutable
tenant, but a new installation still needs direct database work to create its first
administrator. Enrolment is also permanent: there is no supported way to remove a
compromised or departing actor. Since every enrolled actor currently has full tenant
administrator authority, removal is a security control rather than an operator
convenience.

Bootstrap has no live tenant session from which to derive authority. Making it a
public or administrator HTTP route would either be circular or introduce a second
unauthenticated authority. Deprovisioning does have a live-session authority, but it
must not delete the immutable actor-to-tenant identity and thereby permit silent
rebinding to another tenant.

## Decision

### Bootstrap only from the server command line

The first administrator is created by `npm run bootstrap-administrator` after the
checksum-pinned migrations have run. The command reads one bounded JSON document
from standard input, never from HTTP or process arguments. It requires the database
configuration and `ADMIN_OIDC_ISSUER`, derives the actor with the same
issuer-plus-subject mapper as login and accepts the initial tenant UUID, normalized
Salesforce org ID, authorization origin and namespace tuple only at this explicit
server-operator boundary.

One PostgreSQL statement takes ordered tenant and actor advisory locks, refuses if
the tenant already has any administrator or the actor has any binding, inserts or
confirms the immutable tenant tuple, creates the first active binding and appends a
`bootstrap` lifecycle audit. Repetition and concurrent first-actor attempts have one
winner and a fixed refusal. No input document, subject, actor, tenant or database
detail is printed on failure.

### Deactivate; never delete or rebind

`DELETE /api/admin/administrators` accepts exactly the same single `subject` field
as enrolment. Exact origin, live opaque session and session-derived CSRF are checked
before the body is parsed. The configured OIDC issuer derives the target actor; the
performing actor and tenant come only from the live session.

Migration `0008_administrator_lifecycle` adds an active/deprovisioned state to the
binding and an append-only-by-write-path lifecycle audit. A deprovisioned binding is
retained as an inactive tombstone. Login, session issuance and session resolution
require an active binding, while ordinary enrolment refuses inactive bindings. A
removed actor therefore cannot regain access through an old cookie, be silently
re-enrolled or be rebound to another tenant.

Deprovisioning locks every active binding for the tenant in deterministic order,
then atomically verifies that the performer and target are active in the same
tenant, refuses self-removal, requires more than one active administrator, marks the
target inactive, deletes every target session and appends a `deprovision` audit.
Concurrent removals cannot orphan the tenant. Missing, inactive, self, last-admin,
cross-tenant and storage refusals share the fixed HTTP response `503 Provisioning
unavailable`, so the route discloses no target or tenant detail.

The lifecycle audit is append-only through Kusanya's write paths. As with ADR 0045,
this unit does not claim tamper evidence against a privileged database role.

### Keep the documentation boundary executable

The OpenAPI least-data assertions move to a repository-root test, where
`docs/openapi.yaml` is available without widening the service Docker build context.
It fixes the attempt summary at six fields and seven statuses, refuses sensitive
publication columns and requires both enrolment and deprovisioning operations. The
publication query decoder also documents why it accepts Fastify's null-prototype
query objects while still copying only own data descriptors.

## Alternatives considered

- Expose bootstrap over HTTP with a deployment token. Rejected because it creates a
  new remote credential and replay surface before a tenant authority exists.
- Delete administrator bindings. Rejected because the actor could then be rebound to
  another tenant and existing audit/publication foreign keys would lose identity.
- Let an administrator remove themselves. Rejected because accidental lockout has
  no safe self-service recovery and bootstrap is intentionally one-time.
- Permit removal of the last administrator and rely on the bootstrap command.
  Rejected because replay is forbidden; it would orphan the tenant.
- Return distinct absent, self, last-admin and cross-tenant errors. Rejected because
  those distinctions disclose lifecycle and identity state without improving the
  safe operator action.

## Consequences and verification

Deployments gain a reviewed, one-shot path to the first administrator, and active
tenant administrators gain an immediate revocation path for peers. The operator
interface uses the existing subject field for enrolment or removal and stores no
new browser state. This unit originally shipped a single-role model in which every
active binding had full administrator authority; ADR 0054 supersedes that part with
the closed administrator/publisher/reviewer model.

Unit tests cover bounded bootstrap parsing, issuer-derived identities, replay,
origin/session/CSRF ordering, request selectors, generic refusals, self-removal,
composition and OpenAPI least-data drift. PostgreSQL 17 tests prove concurrent
bootstrap has one winner, concurrent cross-removal leaves exactly one active
administrator, removal revokes the target session immediately, inactive bindings
cannot log in or be rebound, and bootstrap/deprovision audits commit with their
state changes.

Note 109 is narrowed in ADR 0052: the route hides the other tenant and all details,
but a caller comparing successful enrolment with the generic refusal can learn one
outcome bit. Notes 110, 111 and 112 are answered by this lifecycle, the root OpenAPI
tripwire and the query-decoder comment respectively. Note 34 advances through
bootstrap and deprovisioning; ADR 0054 later closes the role-model strand. Its
remaining current strands are invitations, attempt retention/deletion, scheduled
reconciliation, privileged retry, disconnect/rebind, the publish CLI and ODK Validate
assets in the service runtime image.
Note 39 remains open. No C10 acceptance test, publish-ready state or Phase 1
completion is claimed.

## Revisit when

Kusanya adds roles, invitations, supervised self-removal, tenant suspension,
disconnect/rebind or database-role enforcement for tamper-evident lifecycle audits.
