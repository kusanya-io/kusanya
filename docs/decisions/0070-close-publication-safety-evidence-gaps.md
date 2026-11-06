# ADR 0070: Close publication safety evidence gaps

- Status: Accepted
- Date: 2026-11-06
- Decider: Bill Owiti
- Brief sections: C4, C8, C11

## Context

Independent review left five small but related publication notes. The operator
projection's single-use retry rule was enforced below the presentation layer but
needed a direct tripwire (note 150). File cleanup did not see public
`ContentDistribution` deliveries, its reachable missing-owner-link refusal lacked
an Apex test and its rollback branch duplicated the all-or-none delete contract
(notes 152 and 153). PostgreSQL cleanup admission trusted the denormalised
`salesforce_connection_state` flag without also deriving a live credential, while
disconnect carried an impossible `partial`/`indeterminate` predicate (notes 154
and 155).

## Decision

Close the five notes as one bounded hardening unit without widening any authority.

- Keep retry admission unchanged. Pin the operator projection's `NOT EXISTS`
  child rule and prove through real PostgreSQL that a source with a retry child is
  reported as ineligible.
- Treat a public Content Delivery as an external share. The initial implementation
  checked the two exact `ContentVersion` identifiers before deletion. Independent
  review then demonstrated that a delivery can remain on an older version of the
  same document, so ADR 0071 strengthens the guard to derive and check both complete
  `ContentDocument` identities. The existing link-shape check remains.
- Pin the reachable zero-owner-link refusal in Apex. Remove the redundant inner
  savepoint and rollback branch: one `Database.delete` call with `allOrNone=true`
  is the atomic boundary, and the outer fixed-error handler remains authoritative.
- Add migration `0017_artifact_cleanup_credential_guard`. It replaces the cleanup
  admission function so `connected` must be corroborated by a live
  `tenant_connections` row matching the tenant's complete Salesforce tuple. The
  tenant row remains locked, serialising admission with disconnect.
- Remove the impossible `partial`/`indeterminate` disconnect clause. The database
  reconciliation-shape constraint cannot represent it; the valid `started` and
  unresolved or unlinked `partial` blockers remain unchanged.

## Alternatives considered

- Leave `ContentDistribution` as an operational caveat. Rejected because the
  object is queryable in the same system-mode Apex boundary and deletion would
  invalidate a live public delivery.
- Delete the public delivery along with the File. Rejected because cleanup is
  authorised only for the two exact orphan artifacts, not for an external share
  deliberately created later.
- Couple the state flag and credential with a new table constraint. Rejected
  because a cross-table invariant cannot be expressed as a PostgreSQL `CHECK`;
  deriving it in the already-serialised admission trigger is direct and local.
- Keep the savepoint as defensive code. Rejected because the sole mutation is one
  all-or-none DML statement; the extra branch was unreachable and obscured the
  platform guarantee doing the work.

## Consequences and verification

No collector receives a Salesforce licence or identity. No route, permission set,
package, namespace, workflow or trusted harness changes. File cleanup becomes
strictly narrower. Existing applied migration checksums remain untouched.

Service tests must prove the real-PostgreSQL child-retry projection, credential-row
cleanup guard, valid connected path and impossible-predicate removal. Apex tests
must prove a missing inferred owner link and a public delivery each refuse the
whole pair while the ordinary exact private pair still deletes atomically. The
Apex claims require independent deployment and a protected exact-head run; local
source conversion is not compilation evidence.

This unit closes notes 150 and 152 through 155. Note 159 records the later
document-wide delivery residual and ADR 0071 closes it. Notes 136, 137 and 140
remain informational. It makes no C10, package, namespace, Phase 1 or phase-gate
claim.

## Revisit when

Salesforce changes Content Delivery ownership semantics, cleanup needs to revoke
shares rather than refuse them, or connection state is replaced by a database
model that makes cross-table lifecycle consistency declarative.
