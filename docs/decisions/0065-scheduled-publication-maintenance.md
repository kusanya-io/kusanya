# ADR 0065: Scheduled publication reconciliation and retention

- Status: Approved implementation; awaits independent verification
- Date: 2026-11-04
- Brief sections: C8 security and operations; C11 Phase 1 operational completion
- Decision owner: Cobitech Solutions

## Context

ADRs 0047 and 0048 record uncertain publication attempts and provide a read-only,
one-way reconciler. ADR 0056 provides database-enforced retention, but only when a
live full administrator requests a batch. An interrupted publication could therefore
remain unresolved indefinitely, and old safe terminal rows depended on repeated
manual action. Note 34 keeps scheduled reconciliation and retention open.

The scheduler must not turn uncertainty into permission to publish again. It must not
delete the unlinked Salesforce Files whose identifiers are the only evidence needed
by the future cleanup workflow. Multiple service replicas must not multiply OAuth or
Salesforce requests, and scheduled retention must not be falsely attributed to a
human administrator.

## Decision

The service starts one in-process maintenance timer after it begins listening and
runs one pass immediately. Every replica may own a timer, but a fixed PostgreSQL
session advisory lock permits only one pass across the deployment. A losing replica
does no candidate read, credential access, Salesforce request or retention write.
Grace, interval, run deadline and batch size are required bounded deployment
settings. The default deployment example uses a 15-minute stale threshold, hourly
interval, ten-minute run deadline and at most 25 reconciliation candidates.

Candidate selection is server-owned and cross-tenant. No HTTP route, tenant selector,
attempt selector, cutoff or retry flag is added. It selects at most the configured
maximum of unresolved `started` or `partial` attempts older than the grace period,
oldest first. A stale `started` row becomes `indeterminate` locally with zero
credential or Salesforce access. A stale `partial` row uses the existing encrypted
tenant connection and exact immutable org/origin/namespace tuple, obtains one
attempt-scoped access token, and calls only the bounded GET inspector from ADR 0048.
It may record only `committed`, `unlinked` or `artifacts_missing`. Inspection failure
leaves the row unresolved and makes the pass report failure; it never retries the
publication, uploads, commits or deletes in Salesforce.

After reconciliation, the same globally locked pass applies one retention batch of
at most 100 rows. PostgreSQL retains the ADR 0056 age and state guard. Only old
`succeeded`, `failed`, `partial/committed` and `partial/artifacts_missing` rows are
eligible. `started`, unresolved, `indeterminate`, `unlinked` and young rows remain
protected by the trigger even if application selection regresses.

Migration 0013 distinguishes the authority honestly. Existing and interactive
retention audits have `execution_source = administrator` and a same-tenant actor.
Scheduled deletion has `execution_source = scheduled` and a null actor. A CHECK
constraint permits exactly those two shapes, while the retained trigger writes the
audit before deletion in the same transaction. The scheduler uses the service's
existing database and encrypted tenant-connection identity; it introduces no new
Salesforce credential, collector identity or Salesforce licence.

For rolling deployment compatibility, an older service binary that supplies the
already-validated retention actor but not the new mode is interpreted as
`administrator`. A null actor never receives that fallback; machine retention must
set `scheduled` explicitly and therefore cannot inherit administrator authority.

The timer never overlaps itself. Shutdown clears the timer and asks the current
bounded pass to finish before closing the pool, subject to the service's existing
ten-second hard shutdown deadline. A failed or deadline-deferred pass emits only the
fixed text `Publication maintenance failed`; no tenant, attempt, provider, credential
or driver value is logged. The next ordinary interval may inspect the still-unresolved
row again, but it cannot repeat a publication operation.

## Alternatives considered

- Run one timer per tenant. Rejected because tenant-controlled schedules increase
  state and make cross-replica serialization harder without improving isolation.
- Use a queue row or lease per attempt. Deferred because one deployment-wide
  advisory lock and bounded batches already prevent concurrent work. A durable lease
  is warranted only when maintenance must be horizontally partitioned.
- Attribute scheduled deletion to an arbitrary active administrator. Rejected as a
  dishonest audit and because maintenance must continue when no administrator is
  online.
- Reuse the administrator retention HTTP route from a synthetic session. Rejected:
  it would create a second session/CSRF credential path and confuse machine action
  with human authority.
- Automatically retry an unresolved publication. Rejected. Reconciliation observes
  and records; it never treats uncertainty as authorization to mutate Salesforce.
- Delete `unlinked` attempts or their Files on the same schedule. Rejected because
  those identifiers are protected evidence for a separately reviewed cleanup unit.

## Consequences and verification

Unit tests drive stale started and partial rows, exact read-only Salesforce methods,
inspection refusal, lock contention, scheduler overlap, fixed failure signalling,
bounded candidate selection and scheduled retention transaction ordering. PostgreSQL
integration verifies migration 0013, retains the interactive actor audit shape,
creates a scheduled null-actor audit, deletes a safe row in another tenant and keeps
every protected state.

This closes note 34's scheduled reconciliation and retention strand after independent
verification. It does not add privileged publication retry, unlinked Salesforce File
cleanup, disconnect/rebind, a new credential path or a C10 acceptance claim. Note 147
is answered by making the two workflow-test patterns include their trailing commas,
so multiplying either bound no longer satisfies the asserted source text.

## Revisit when

Maintenance must be sharded across workers, audit retention is defined, a metrics
backend is added, unlinked Files are cleaned, or a privileged retry workflow is
approved.
