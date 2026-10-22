# ADR 0048: Read-only publication reconciliation

- Status: Proposed; implementation awaiting independent verification
- Date: 2026-10-22
- Brief sections: C1.3a, C2, C3.5/.11/.16/.20, C5 publish, C8, C11 Phase 1
- Decision owner: Cobitech Solutions
- Extends: ADRs 0036, 0039, 0046 and 0047

## Context

ADR 0047 deliberately keeps uncertain attempts durable. A `started` attempt may
have stopped anywhere from before OAuth through after a successful remote commit;
it has no digest or artifact identity. A `partial` attempt proves that exact Files
were attested and records their digest and two ContentVersion IDs, but both commit
responses were uncertain. Treating either state as retry permission could publish
or upload twice. Treating either as a clean failure could conceal a committed form.

## Decision

Add an internal reconciler with no publisher, commit, upload, delete or HTTP route.
It accepts a live trusted administrator context and server-selected attempt UUID.
The PostgreSQL store rechecks actor, tenant, org, authorization origin and namespace
before returning only a `started` or `partial` row. `succeeded` and `failed` rows are
not reconcilable.

Migration `0007_publication_attempt_reconciliation` adds a separate, immutable
resolution state:

- `started` becomes `indeterminate` with zero Salesforce requests. Missing artifact
  identities mean no safe remote lookup can attribute a publication to this attempt.
- `partial` uses the exact stored Form Version, digest and two ContentVersion IDs in
  bounded GET requests. An exact Published or Superseded tuple is `committed`. An
  exact Draft with both recorded Files present is `unlinked`. An exact Draft with
  neither recorded version present is `artifacts_missing`.
- Mixed, mismatched, malformed, inaccessible or contradictory evidence refuses and
  leaves the attempt unresolved.

Reconciliation never changes the original publication `outcome`; it records what
was subsequently proven. A conditional update from null resolution makes the result
one-way. Two reconcilers may duplicate bounded GETs, but only one database transition
wins; the loser returns the immutable winning result. Re-running a resolved attempt
performs no OAuth or Salesforce request.

The partial path creates the same bound, attempt-scoped Salesforce session as
publication. Its remote capability is structurally limited to GET. It cannot reach
the Apex commit endpoint, Composite upload, ContentDocument deletion or the
publisher function. The Salesforce request count excludes the OAuth exchange under
the ADR 0047 definition.

## Consequences and verification

This unit classifies abandoned evidence but does not delete it. `unlinked` Files
remain private until a separately reviewed retention policy decides age, ownership,
link and deletion rules. `indeterminate` requires privileged operator investigation;
it is not permission to retry.

Independent verification should race two reconcilers, mutate every remote identity,
try a second tenant and actor, replay every resolution, feed terminal attempts, and
prove that only OAuth POST plus Salesforce GET requests are reachable. It should
inspect PostgreSQL constraints directly and prove that remote or storage failures
leave resolution null. No Salesforce metadata, permissions, sharing, workflow,
harness, package, namespace or dependency changes are made. No C10 acceptance test,
publish-ready state or Phase 1 completion is claimed.

Note 103 is answered in ADR 0006 and `docs/ci.md`: the Pacific Salesforce day
boundary is evidenced, the allocation reset is inferred, and
`DailyScratchOrgs.remaining` is unreliable. Changing the harness preflight remains a
separate trust-boundary unit. Note 34 remains open for deployment/external identity,
approved provisioning, disconnect/rebind, retention/deletion, privileged retry and
the publish CLI. Note 39 remains open.

## Revisit when

Adding retention/deletion, operator presentation, privileged retry, scheduled
reconciliation, deployment mounting or the publish CLI.
