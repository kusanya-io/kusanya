# ADR 0056: Audited publication-attempt retention

- Status: Proposed; implementation awaiting independent verification
- Date: 2026-10-28
- Brief sections: C1.3a, C2, C5 publish, C8, C11 Phase 1
- Decision owner: Bill Owiti / Cobitech Solutions
- Extends: ADRs 0047, 0048, 0049, 0052 and 0054

## Context

Publication attempts deliberately retain evidence when PostgreSQL and Salesforce
cannot share one transaction. Operators can now see that evidence, but nothing can
remove old terminal rows. An arbitrary attempt ID or caller-selected cutoff would
turn deletion into a cross-tenant oracle and could erase the exact rows needed for
reconciliation. Deleting a row without a surviving audit would also make the
operation itself unaccountable.

The seven operator statuses do not have equivalent retention safety. `started`,
unresolved and `indeterminate` rows preserve uncertainty. A reconciled `unlinked`
row preserves the identities of private Salesforce Files that still exist. Those
four classes must survive until a separately reviewed investigation or artifact
cleanup workflow changes their state. Completed success and rejection, confirmed
commit, and confirmed missing artifacts contain no unresolved remote action.

## Decision

### The database owns eligibility and age

Migration `0011_publication_attempt_retention` adds a bounded tenant policy,
`publication_attempt_retention_days`. It defaults to 90 days and accepts only 30
through 3650. No HTTP request can supply a tenant, attempt ID, cutoff, age or status.
The mounted operation asks PostgreSQL to apply the current tenant policy to at most
100 oldest eligible rows.

Age begins at the terminal evidence timestamp: `completed_at` for `succeeded` and
`failed`, and `reconciled_at` for a safe reconciled `partial` attempt. The database
trigger permits only:

- `succeeded` or `failed` with no reconciliation state;
- `partial` reconciled as `committed`; or
- `partial` reconciled as `artifacts_missing`.

It refuses `started`, unresolved `partial`, `indeterminate`, `unlinked`, missing
terminal timestamps and rows younger than the stored policy. The selection query
applies the same rules for bounded work, but the trigger is the authority and
rechecks each row under its delete lock.

### Every deletion creates a surviving audit atomically

The store opens one transaction, sets the live actor as transaction-local context,
and performs one bounded delete. The trigger rechecks that actor is still an active
`administrator` in the row's tenant. Before each delete it inserts a surviving
audit containing tenant, attempt UUID, actor, terminal outcome/resolution,
terminal timestamp, applied retention days and deletion time. The audit deliberately
has no foreign key back to the deleted attempt, so it survives the deletion. A
unique tenant/attempt key prevents duplicate deletion evidence. If any row or audit
fails, PostgreSQL rolls back every delete and audit in the batch.
As with ADRs 0045 and 0054, append-only audit behaviour is a Kusanya write-path
guarantee, not tamper evidence against a privileged database owner.

The HTTP operation is
`POST /api/admin/publication-attempts/retention`. It requires the exact configured
origin, a live opaque session, session-derived CSRF and the dedicated
`manage_publication_retention` capability. Only the closed `administrator` role has
that capability. Publishers and reviewers are denied before storage. The request
must have an empty query and no body; its only response data is a count from zero to
100 under `Cache-Control: no-store`.

## Alternatives considered

- Delete one caller-supplied attempt. Rejected because existence becomes observable
  and the caller can target evidence the state machine still needs.
- Accept retention days or a cutoff in the request. Rejected because retention is
  policy, not per-call authority; the database stores and enforces it.
- Delete `unlinked` rows after 90 days. Rejected because their stored ContentVersion
  identities are the evidence a future safe artifact-cleanup workflow requires.
- Let publishers manage retention because they can publish. Rejected because
  deleting audit evidence is a distinct destructive capability.
- Require two administrators to approve each batch. Deferred: the current role
  model has no approval object or second-person workflow. A dedicated capability,
  live-role recheck, fixed policy, bounded batch and atomic audit provide the narrow
  authority for Phase 1. A future compliance deployment may add four-eyes approval
  without widening this request contract.
- Run retention on a schedule now. Rejected because scheduled execution requires a
  separate service identity and operational policy. This unit keeps a reviewed,
  administrator-initiated boundary; scheduling remains a note 34 strand.

## Consequences and verification

Retention cannot destroy evidence that may justify investigation, retry or remote
artifact cleanup. A tenant can remove only its own old, safely terminal rows, and
the actor cannot widen selection through request data. Repeated calls remove at
most 100 rows until none remain. Audit rows intentionally grow and need their own
future compliance retention decision; this ADR does not permit deleting them.

Unit tests attack origin, session, CSRF, lower roles, queries, bodies, forged tenant
headers, storage errors, transaction ordering, result bounds and missing
capabilities. PostgreSQL tests exercise every safe and protected state, a young
terminal row, a second tenant, trigger refusal, surviving audits and a forced audit
collision that rolls back the complete batch. They also verify the 90-day policy is
the value recorded by the database.

This closes note 34's publication-attempt retention/deletion strand. It does not
delete Salesforce Files, schedule reconciliation or retention, grant privileged
retry, disconnect/rebind a tenant, add the publish CLI, or install ODK Validate in
the service runtime image. Note 39 remains open. No C10 acceptance test,
publish-ready state or Phase 1 completion is claimed.

## Revisit when

Adding scheduled retention, unlinked-file cleanup, audit retention, four-eyes
approval, privileged retry, disconnect/rebind or a compliance-specific policy UI.
