# ADR 0074: Revalidate and recover durable submission dispatch

- Status: Accepted
- Date: 2026-11-16
- Brief sections: C2, C7, C8, C10.5, C10.14, C11 Phase 2
- Decision owner: Cobitech Solutions

## Context

ADR 0073 made submission intake durable and tenant-scoped, but deliberately stopped
before Salesforce delivery. Its claim query joins the current tenant connection as
a scheduling filter while locking only relay rows. That narrow lock avoids coupling
queue throughput to administrator connection changes, but a claim can observe the
old snapshot while an uncommitted disconnect is waiting. Claim is therefore not an
authorization decision. A process can also die after moving a row to `dispatching`,
and without a lease that row would never be selected again.

The service already has an attempt-scoped Salesforce session boundary that selects
and locks the encrypted credential, verifies the immutable tenant/org/origin/
namespace tuple before decryption, bounds refresh independently of `fetch`, and
persists token rotation before exposing access. Dispatch must compose that boundary
rather than create another credential path.

## Decision

Add a tenant-batch dispatcher that always recovers expired work before selecting new
work. A claim now carries the server-owned Salesforce org, authorization origin and
namespace observed with the relay. After claim, the dispatcher passes that complete
tuple to `createBoundTenantSalesforceSession`. The session re-reads the connection
under its credential row lock and refuses absence or any tuple drift before token
decryption or delivery. The claim-time join remains a scheduling optimization only.
Credential-lock acquisition and refresh together have a local deadline, so a worker
blocked behind a disconnect cannot outlive its lease and later reach delivery.

`updated_at` is the lease clock, evaluated against PostgreSQL
`clock_timestamp()` rather than caller time. Before every claim, a bounded `FOR UPDATE SKIP
LOCKED` reaper moves expired `dispatching` rows back to `queued` with fixed
`DISPATCH_LEASE_EXPIRED` evidence and an immediate retry time. An expired attempt at
the ceiling becomes terminal `dead` while retaining its final fixed cause. The configured
lease must exceed the sum of the independently bounded OAuth refresh and delivery
deadlines by at least one second.

Every commit or failure transition includes the claimed attempt number. A stale
worker therefore cannot complete or fail a row after another worker has recovered
and reclaimed it. Missing, duplicate, extra or malformed batch outcomes retry the
whole claimed set under the existing instance-id idempotency rule. The local OAuth
and delivery timers stay referenced until their `finally` blocks clear them, so an
otherwise idle one-shot worker still releases the relay when the injected transport
ignores abort. The OAuth deadline also aborts the token exchange, so a late response
cannot persist rotation after the relay is requeued. Delivery returns only the
closed dispositions `committed`, `retry` and `dead`; external messages never become
stored failure codes. A retry requested on attempt 100 retains that final code and
is reported as terminal rather than promising another claim.

The dispatcher makes one delivery call for one tenant batch of at most 200. ADR
0075 supplies the raw-receipt transport but leaves mapping and scheduler composition
for later units, so this ADR does not set or claim the C10.15 API-call budget.

## Alternatives considered

- Restore broad row locks on tenant and connection joins. Rejected because queue
  scheduling is not the credential boundary and should not hold administrator
  lifecycle rows.
- Trust a successful claim for the later Salesforce call. Rejected because an
  uncommitted disconnect or rebind can win immediately after the claim snapshot.
- Requeue every `dispatching` row at startup. Rejected because another replica may
  still own live work; only an expired bounded lease is recoverable.
- Let workers settle by relay id alone. Rejected because a recovered stale worker
  could otherwise settle a newer attempt.
- Add a broker lease. Rejected because PostgreSQL already holds the durable state,
  lock ordering and clock required for this boundary.

## Consequences and verification

The dispatcher has no public route or scheduler, does not implement Salesforce
mapping, and cannot acknowledge an OpenRosa client. It claims no C10 acceptance
test. ADR 0075's transport preserves one Salesforce request for a size-bounded
prefix, Salesforce-side instance idempotency and per-row closed outcomes, but keeps
received rows retryable until mapping exists.

Unit tests prove the reaper runs before claim using the database clock, the complete claim tuple is checked
again while loading the credential, disconnect/rebind prevents OAuth and delivery,
the deadline does not depend on transport abort compliance, late token rotation is
discarded, attempt numbers fence state transitions, locally snapshotted claims cannot
be mutated by the store, overlapping recovery/claim counts once in `touched`, and
malformed outcomes cannot partially settle a batch. A real
PostgreSQL race leaves disconnect uncommitted while claim succeeds, then proves the
credential load blocks, observes the committed deletion, performs zero OAuth or
delivery calls and safely requeues the relay. Real PostgreSQL also proves a recovered
attempt cannot be settled by its stale worker.

The package-wide metadata ordering test closes note N by walking every metadata XML
file, not a named permission-set list. Direct relay deletion/retention remains the
declared ADR 0073 gap.

## Revisit when

The Apex ingestion resource and transport land, the scheduler is composed into the
runtime, measurements establish the C10.15 request budget, or production latency
requires a different lease and retry policy.
