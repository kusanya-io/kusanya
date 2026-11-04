# ADR 0066: Privileged publication retry

- Status: Approved implementation; awaits independent verification
- Date: 2026-11-05
- Brief sections: C8 security and operations; C11 Phase 1 operational completion
- Decision owner: Cobitech Solutions

## Context

ADRs 0047 and 0048 preserve every publication attempt and distinguish known
terminal failure from outcomes that require human judgement. ADR 0065 observes
stale attempts but deliberately never publishes. Operators still have no reviewed
way to retry the two states where evidence proves that retry cannot duplicate an
unknown commit: a terminal `failed` attempt with no reconciliation status, and a
`partial` attempt reconciled as `artifacts_missing`.

Retry must not turn `started`, unresolved, `indeterminate`, `committed`, `unlinked`
or succeeded evidence into permission to write. It must also preserve the source
record and make concurrent or repeated operator actions single-use.

## Decision

Add `POST /api/admin/salesforce/publication-retries` on the existing exact-origin,
live-session and session-derived CSRF boundary. Only the closed `administrator`
role has the new `retry_publication` capability. Publishers retain ordinary publish
authority but cannot create audited retry lineage. The request contains exactly one
opaque attempt UUID and no tenant, org, Form Version, status or force flag.

Migration `0014_privileged_publication_retry` adds the nullable
`retry_of_publication_attempt_id` self-reference. A retry is a new durable
`started` attempt; the source is never updated. A unique constraint allows at most
one direct retry child per source, while a same-tenant composite foreign key and a
database trigger require:

- a live same-tenant administrator binding;
- the identical Form Version as the source;
- either `failed` with no reconciliation status or `partial/artifacts_missing`;
- a new `started` row with no completion or reconciliation state.

The link is immutable. A retry child that later reaches an eligible state may be
the source of a later retry, producing an explicit chain rather than overwriting
history. Concurrent requests race on the unique source constraint, so exactly one
can create a child. The HTTP response deliberately makes ineligible, already-used
and cross-tenant sources the same fixed conflict.

After admission, retry uses the same attempt-scoped tenant connection, publisher,
partial recorder and completion state machine as ordinary publication. There is no
automatic retry, ambient credential, alternate publisher or new Salesforce
identity. The route recompiles and revalidates the source Form Version as it exists
at the time of the administrator action. It does not promise byte replay: failed
attempts intentionally retain no package digest, and an `artifacts_missing` source
proves remote absence rather than preserving an executable package. The new child
records the digest and evidence produced by this evaluation.

The operator history adds only `retryOfAttemptId` and `retryEligible`.
`retryEligible` is true only for a live administrator, an allowed source state and
no existing child. Publisher and reviewer history remains readable but never marks
a row retryable. The browser creates the command only from that signal; PostgreSQL
remains authoritative if the page is stale.

Retention never selects a source while a retry child references it. The foreign key
would refuse that delete anyway; excluding it in both interactive and scheduled
selectors keeps a mixed batch from being wedged. Once a terminal child is itself
eligible for retention and has no child, it may be deleted first; its source may be
selected by a later bounded batch. Every ordinary age, state and audit rule remains.

## Alternatives considered

- Retry unresolved or indeterminate attempts after an operator clicks through a
  warning. Rejected: uncertainty is not proof that Salesforce did not commit.
- Retry `partial/unlinked`. Rejected: those exact immutable artifacts exist but are
  not linked; retry could create a second artifact pair instead of cleaning them.
- Let publishers invoke retry because they can ordinarily publish. Rejected:
  interpreting prior evidence is a privileged operational decision and needs an
  explicit administrator actor and lineage.
- Mutate the source back to `started`. Rejected because it erases outcome,
  reconciliation and actor history and makes concurrency ambiguous.
- Automatically retry known failures. Rejected because configuration or definition
  correction and an explicit human decision are required.
- Store and replay the original package bytes in PostgreSQL. Rejected as a new
  sensitive/large artifact store and incompatible with the existing least-data
  attempt ledger. Content addressing remains on the newly evaluated attempt.

## Consequences and verification

Unit tests cover role, exact request boundaries, fixed conflict responses, shared
success/partial semantics, least-data presentation and retention selection. Real
PostgreSQL integration must prove every accepted and refused source state, two
concurrent requests yielding one child, direct forged SQL refusal, immutable links,
and safe retention ordering. Mutations must show that removing role, state,
single-use or child-retention guards makes a repository test fail.

Independent verification closes note 34's privileged publication-retry strand.
This unit does not clean unlinked Salesforce Files, disconnect or rebind a tenant,
change Salesforce metadata or permissions, add a C10 claim, or complete Phase 1.
It creates no collector Salesforce user or licence.

## Revisit when

Exact historical-byte replay is required, four-eyes retry approval is mandated,
retry chains need a policy limit, or the operator workflow gains case-management
state beyond the immutable attempt ledger.
