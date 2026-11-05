# ADR 0067: Privileged unlinked publication artifact cleanup

- Status: Approved implementation; awaits independent verification
- Date: 2026-11-05
- Brief sections: C8 security and operations; C11 Phase 1 operational completion
- Decision owner: Cobitech Solutions

## Context

The publication publisher records a `partial` attempt when it uploaded the exact
XForm and XLSForm Files but could not prove that the atomic Form Version commit
completed. ADR 0048 can later prove those exact ContentVersion identities are still
present and unlinked. Retention deliberately preserves this evidence and ADR 0066
refuses to publish again, but there has been no reviewed way to remove the orphaned
Salesforce Files.

Deleting two ContentDocuments through separate service requests is unsafe: one
request can succeed while the other fails, and a link or publication commit can race
the deletion. Cleanup must be an explicit privileged decision, use only the immutable
evidence already recorded by Kusanya, and leave an investigation state when the
transport cannot prove the result.

## Decision

Add `POST /api/admin/salesforce/publication-artifact-cleanups` on the existing
exact-origin, live-session and session-derived CSRF boundary. Only the closed
`administrator` role has `cleanup_publication_artifacts`; publisher and reviewer
roles may see history but cannot invoke cleanup. The request contains exactly one
opaque publication-attempt UUID. It has no tenant, org, Form Version, File ID,
status, force flag or retry selector.

Migration `0015_unlinked_publication_artifact_cleanup` adds
`tenant_publication_artifact_cleanups`. PostgreSQL derives and admits the source
only when the live administrator, tenant, exact org/origin/namespace tuple and
`partial/unlinked` publication attempt agree. The source attempt is never edited or
deleted. A cleanup records its requesting and resolving actors, request count,
timestamps and one of `started`, `succeeded`, `failed` or `indeterminate`.
Identity columns are immutable. A partial unique index permits only one live,
succeeded or indeterminate cleanup for a source. A failed cleanup may be attempted
again as a new audited row; a started or indeterminate cleanup is resumed; a
succeeded cleanup cannot be repeated. Database triggers independently enforce the
source state, live administrator role, transition shape and resolver authority.

The service loads the Form Version, package digest and both ContentVersion IDs only
from that admitted row. It creates one attempt-scoped tenant Salesforce session and
first calls the existing read-only inspector. Already-missing artifacts complete the
cleanup as succeeded. Committed, mixed, foreign, changed or linked evidence is a
fixed refusal. Exact unlinked evidence is sent once to a new namespaced Apex REST
resource. There is no automatic cleanup, scheduler path or ambient credential.

The Apex boundary performs the indivisible Salesforce mutation. It locks the owning
Form before the Form Version, requires Draft state and empty publication metadata,
and checks the two exact latest ContentVersions are distinct, owned by the calling
integration user, named for the recorded digest and have the expected XML/XLSX file
types. Salesforce automatically creates an inferred link from a privately uploaded
ContentDocument to its uploading User, so zero links is not a representable private
File state. A system-mode read therefore requires exactly one link per document:
the caller's inferred User-owner link with ShareType `I` and Visibility `AllUsers`.
It refuses a missing or duplicate owner link and every record, library, foreign or
otherwise differently shaped link, including one the caller could not see. The
filter is only by ContentDocumentId because Salesforce does not permit the needed
non-ID exclusions in ContentDocumentLink SOQL; discrimination is performed in Apex.
It then deletes both ContentDocuments with user-mode enforcement under one
savepoint; any failure rolls back both. The integration permission set grants only
this Apex class in addition to its existing scoped object/File access. No collector
receives a Salesforce user or licence.

An uncertain cleanup response is never treated as permission to delete or publish
again. The service immediately reuses the read-only inspector: both artifacts
missing means succeeded; exact unlinked or committed evidence means failed; any
other result remains indeterminate for human investigation. OAuth failure before a
Salesforce request leaves the durable cleanup started. Every later completion is
additive in request count and race-idempotent.

The operator projection adds only `artifactCleanupStatus` and
`artifactCleanupEligible`. The browser displays Clean files or Resume cleanup only
from that server-owned signal; PostgreSQL and Apex remain authoritative if the page
is stale. Successful File cleanup does not erase the source publication attempt or
its recorded ContentVersion identities. Those rows remain protected from ordinary
retention so the audit continues to explain what was removed.

## Alternatives considered

- Issue two ContentDocument DELETE requests from Node. Rejected because there is no
  atomic boundary across the pair and link checks can race the second request.
- Let a caller supply the two File IDs. Rejected because selector freedom would let
  the command target evidence outside its tenant-owned publication attempt.
- Delete every old unlinked attempt on the maintenance schedule. Rejected because
  destructive Salesforce work requires a named live administrator and uncertainty
  must not become scheduled authority.
- Let publishers clean artifacts because they can publish. Rejected because cleanup
  interprets historical evidence and permanently deletes Salesforce Files.
- Mark the source `artifacts_missing` after cleanup. Rejected because reconciliation
  describes observed publication evidence, while the separate cleanup ledger must
  preserve who deliberately caused the absence.
- Delete the source ledger after cleanup. Rejected because the durable evidence is
  the audit trail for the destructive operation and contains no File bodies or
  credentials.

## Consequences and verification

Unit tests cover the closed role matrix, exact HTTP request boundary, hardened
session object, namespace path, bounded response, orchestration outcomes, least-data
projection and operator command. Real PostgreSQL integration must prove resume,
terminal success, failed replacement, warm-pool concurrent admission, live actor
checks, immutable identity and direct forged SQL refusals. Apex tests must prove the
exact pair with only its two platform-required inferred owner links succeeds
atomically and every changed, foreign, additionally linked, non-Draft, published,
oversized or hostile request is refused without partial deletion. Foreign-artifact
survival is asserted as the owning user rather than through the integration user's
private-File visibility.

ADR 0070 additionally treats a `ContentDistribution` on either exact version as
an external share and refuses the whole pair. It pins the reachable missing-owner-
link branch. The deletion remains one `Database.delete` call with
`allOrNone=true`; the redundant savepoint and rollback branch was removed because
the single all-or-none DML statement is already the atomic boundary.

The same PostgreSQL evidence adds the note 150 tripwire: once a retry child exists,
the source projection must report `retryEligible: false`.

After independent verification this closes note 34's unlinked Salesforce File
cleanup strand. Privileged disconnect and rebind remains separate. This unit adds no
C10 claim, package or namespace change and does not complete Phase 1.

## Revisit when

Salesforce supports a stronger provider-owned transaction boundary, cleanup needs
four-eyes approval, retained cleanup ledgers gain their own policy, or operators need
case notes beyond the immutable outcome and actor evidence.
