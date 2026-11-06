# ADR 0071: Record Phase 1 gate readiness and guard document-wide deliveries

- Status: Proposed; implementation and readiness record await independent review
- Date: 2026-11-06
- Decider: Bill Owiti
- Brief sections: C8, C10.10, C10.12, C11 Phase 1

## Context

Independent review of ADR 0070 found that the cleanup guard queried public
`ContentDistribution` rows by the two caller-supplied `ContentVersion` identifiers.
Deleting either `ContentDocument` also deletes its older versions and their public
deliveries. A caller that supplied the latest version while an older version carried
the delivery could therefore pass that check. The mounted service cannot currently
construct that request because its durable ledger records the upload-time version
and cleanup additionally requires that version to remain latest, but the Apex
boundary is intentionally defensive against an incorrect caller. This is note 159.

Phase 1's implementation and acceptance evidence have also outgrown the historical
per-unit roadmap text. C10.10 and C10.12 were independently reproduced, while the
data model, compiler, XLSForm interchange, print delivery and publish CLI are all on
accepted main. The builder still cannot claim the phase gate: `ksny` is registered
but its Dev Hub link remains blocked by Salesforce's locked Namespace Registry
connected-app setting, and ADR 0008 requires a namespaced suite before the next
phase gate.

## Decision

Make public-delivery refusal a property of the documents being destroyed rather
than the versions named by the caller. `PublicationArtifactCleanup` continues to
derive two distinct document identifiers from user-mode reads of the exact latest
versions. `PublicationArtifactGuard` queries `ContentDistribution.ContentDocumentId`
for that derived set and refuses the all-or-none deletion if any version of either
document has a delivery. No public delivery is revoked automatically.

Add a real Apex regression that creates a delivery on version one, creates a second
latest version of the same document, supplies that latest version to the cleanup
boundary and proves that both documents and the delivery survive. The former
version-scoped query must fail this test by deleting the documents.

Reconcile the roadmap and ADR 0060 with the verifier's accepted C10.10 and C10.12
evidence. Treat the repository as ready to request a Phase 1 gate only after all of
the following are true:

1. Salesforce Support or an approved supported flow links the registered `ksny`
   namespace to the intended Dev Hub.
2. The applicable exact-head suite passes in a namespaced scratch org under the
   ordinary protected-run and independent-verifier controls.
3. Claude runs C10.10 and C10.12 at the gate and records the Phase 1 verdict.

Until then the project namespace remains empty and this unit claims neither a
namespaced behavior nor a Phase 1 pass.

## Alternatives considered

- Keep the version-scoped check because the mounted service cannot reach the
  demonstrated request. Rejected because the Apex boundary exists to re-derive
  cleanup safety and already has both document identifiers.
- Query every version and then its deliveries. Rejected because
  `ContentDistribution.ContentDocumentId` expresses the deletion scope directly
  with one bounded query.
- Delete the older public delivery and continue. Rejected because cleanup authority
  covers only proven private orphan artifacts, not revoking an external share.
- Request the Phase 1 gate without the namespace link. Rejected because it would
  contradict ADR 0008 and turn synthetic prefix fixtures into a namespaced claim.

## Consequences and verification

Cleanup becomes strictly narrower. The route, request shape, permissions, package,
namespace, workflow, trusted harness, service and database are unchanged. No
collector receives a Salesforce identity or licence.

Independent review must deploy the exact head, run the full Apex suite and exercise
the older-version delivery regression. The expected control begins from 110 tests
and 2077 of 2176 executable lines (95.45 percent); the exact new figure must be
measured rather than predicted. Note 159 closes only after that evidence passes.

C10.10 and C10.12 are recorded as previously satisfied evidence, not re-claimed by
this hardening unit. Notes 136, 137 and 140 remain informational. The namespace link
and namespaced suite are an explicit Phase 1 gate blocker, so this record is not a
gate request.

## Revisit when

Salesforce changes Content Delivery document semantics, the namespace link becomes
available, or a supported packaging decision changes the gate sequence.
