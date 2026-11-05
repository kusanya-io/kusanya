# ADR 0068: Privileged Salesforce disconnect and rebind

- Status: Approved implementation; awaits independent verification
- Date: 2026-11-05
- Brief sections: C8 security and operations; C11 Phase 1 operational completion
- Decision owner: Cobitech Solutions

## Context

Kusanya binds each tenant to one Salesforce org, authorization origin and namespace
and stores one encrypted refresh token for that tuple. Earlier decisions deliberately
made the tuple immutable: an OAuth callback may refresh a credential for the same
org but cannot silently move a tenant to another org. Note 34 therefore retained one
explicit operational gap after publication retry and File cleanup: a privileged,
audited way to disconnect a credential and deliberately select a new tuple.

A connection cannot be removed safely while publication state is unresolved. A
`started` attempt may still be using the credential, a `partial` attempt may still
represent an uncertain commit, and `partial/unlinked` evidence must be cleaned before
the old org becomes unreachable. The lifecycle also has to serialize with new
publication and cleanup admission rather than relying on a same-statement snapshot.

## Decision

Add two administrator-only, exact-origin, live-session and session-derived-CSRF
commands:

- `POST /api/admin/salesforce/connection/disconnect` has no body, query, tenant, org,
  credential or force selector. It derives the current tuple from the live session.
- `POST /api/admin/salesforce/connection/rebind` accepts exactly the new normalized
  Salesforce org ID, Salesforce authorization origin and namespace prefix. It accepts
  no tenant, actor, credential, instance URL or current tuple.

Publisher and reviewer roles have no `manage_salesforce_connection` capability.
Both commands return an empty no-store success and fixed, secret-free refusals. The
route receives a frozen store exposing only `disconnect` and `rebind`; it cannot
publish, reconcile, clean artifacts, read credentials or start OAuth.

Migration `0016_privileged_salesforce_disconnect_rebind` adds a checked
`salesforce_connection_state` to the tenant row. Existing rows are backfilled from
the presence of an encrypted connection; new tenants begin disconnected. Successful
OAuth authorization marks the matching tuple connected in the same transaction as
the credential and authorization audit. The authorization audit foreign key moves
from the deletable connection to the durable tenant so prior signed `005` identities
survive a disconnect.

Disconnect first locks the exact tenant row through a live administrator binding.
It then refuses while any publication is `started`, any partial publication is
unresolved or indeterminate, any `partial/unlinked` publication lacks a successful
artifact cleanup, or any cleanup is started or indeterminate. Otherwise one
transaction deletes the encrypted connection and any pending OAuth transaction,
marks the tenant disconnected and appends a lifecycle audit containing the old tuple
and credential version. It never deletes publication, cleanup or authorization
history.

Rebind is a separate transaction and is possible only while disconnected and while
no connection row exists. It locks the same tenant row, deletes stale pending OAuth
state, changes the expected tuple and appends an audit carrying both old and new
identities. It does not create a credential or mark the tenant connected. The
ordinary one-time OAuth flow must subsequently authorize the new org. The existing
unique org constraint independently refuses moving two tenants onto one org.

New database triggers lock the tenant row before admitting a publication attempt or
artifact cleanup. Publication attempts require the current tenant/org tuple but may
still record the existing fixed not-connected failure after a disconnect; they can
no longer cross the disconnect check unseen. Destructive File cleanup additionally
requires connected state. This makes admission and disconnect mutually serial: an
admitted active attempt makes disconnect ineligible, while a completed disconnect
makes cleanup impossible and leaves later publication selector-free and credentialless.
OAuth authorization takes the tenant lock before touching the connection row,
preserving one lock order and preventing authorization/disconnect deadlocks.

`tenant_salesforce_connection_lifecycle_audits` records the actor, action, old tuple,
old credential version for disconnect, new tuple for rebind and database timestamp.
Closed checks make the two event shapes distinct. Its tenant/actor foreign key keeps
the performer inside the tenant. As with the other lifecycle ledgers, append-only is
a Kusanya write-path property, not tamper evidence against a privileged database
owner.

## Alternatives considered

- Let a new OAuth callback overwrite the org. Rejected because a callback is not an
  explicit destructive operational decision and would strand old-org evidence.
- Combine disconnect, rebind and OAuth into one request. Rejected because Salesforce
  authorization is a browser round trip and cannot be atomic with a local tuple
  change; the disconnected intermediate state is explicit and recoverable.
- Accept a `force` flag. Rejected because a caller must not override unresolved
  publication or File-cleanup evidence.
- Delete historical publication or authorization rows during disconnect. Rejected
  because those rows explain what was attempted and which Salesforce principal
  authorized each credential version.
- Rely only on service checks for publication races. Rejected because a second
  replica or later caller could otherwise insert between the check and deletion.

## Consequences and verification

Unit tests cover the closed capability matrix, selector-free disconnect, exact
rebind body, hostile object shapes, hardened logging, fixed errors, transaction
ordering and lifecycle blocker clauses. Real PostgreSQL integration must prove that
authorization activates the tuple, active and unresolved publication blocks
disconnect, safe terminal evidence permits it, authorization history survives,
disconnected tenants record a fixed failed publication without Salesforce I/O,
rebind is administrator-only and single-step,
and authorization of the new tuple reconnects without rewriting old audits. It must
also exercise the database triggers and lock ordering on warm distinct connections.

This closes note 34's final privileged disconnect/rebind strand after independent
verification. It adds no collector Salesforce user or licence, no package or
namespace change and no C10 or Phase 1 gate claim. Notes 136, 137 and 140 remain
open. Note 150 remains a presentation-depth item. Note 152's possible
`ContentDistribution` survivor and note 153's unreachable File-cleanup branches are
recorded operational gaps outside this credential lifecycle. The first live firing
of the ADR 0006 unexpected-exception classifier is still owed.

## Revisit when

Four-eyes approval is required, one tenant may intentionally span several Salesforce
orgs, credentials move to an external secret manager, audit tables gain database-role
write denial, or reconnect must preserve a bounded grace period for old-org reads.
