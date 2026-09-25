# ADR 0031: Immutable Salesforce publication artifacts

- Status: Proposed; implementation awaiting independent verification
- Date: 2026-09-25
- Brief sections: C2, C3.11/.16, C4 artifacts and audit, C8, C11 Phase 1
- Decision owner: Cobitech Solutions
- Extends: ADR 0027; owns note 69

## Context

ADR 0027 atomically records a package digest and links two caller-owned Salesforce
Files, but stores only their `ContentDocument` IDs. A document is a mutable series:
another `ContentVersion` can become latest without changing that ID, and deletion
or unlinking can remove the published artifact. The commit also never reads or
hashes file bodies, so its package digest is not proof that any uploaded bytes
matched the reviewed package.

The storage boundary must make the selected bytes stable before an authenticated
publisher or delivery route can rely on them. It must not silently turn the
existing digest into byte attestation that ADR 0027 never performed.

## Decision

### Pin exact versions while retaining document links

`PublicationLifecycle.commitPublication` now accepts distinct XForm and XLSForm
`ContentVersion` IDs. For an initial commit, both versions must be visible in user
mode, owned by the publishing principal, latest in their respective distinct
documents, and have the exact `xml` and `xlsx` extensions. The lifecycle derives
their `ContentDocument` IDs and creates the same two record links as ADR 0027.

`Form_Version__c.XForm__c` and `XLSForm__c` continue to store the document IDs used
for Salesforce Files linkage. New lifecycle-owned `XForm_Version__c` and
`XLSForm_Version__c` fields store the immutable version IDs. Both identities are
part of trigger authorization, publication metadata immutability and exact retry
matching. Admin and Integration can write the new fields only through the guarded
commit; Supervisor receives read-only field access.

A later version may be added to either document. It does not change the stored
version ID or the bytes addressed by it. Consequently an exact retry still accepts
the original pinned version after it is no longer latest. A first commit refuses a
non-latest version so a caller cannot publish a stale selection accidentally.

### Prevent loss of committed artifacts

Small before-delete triggers on `ContentVersion` and `ContentDocument`, plus a
before-delete trigger on `ContentDocumentLink`, call one system-reading,
no-DML guard. The guard rejects deletion of a pinned version, deletion of its
parent document, or removal of either required link. It uses static errors and
does not reveal file, publication or caller-supplied identities. Unreferenced
files and links remain governed by ordinary Salesforce behavior.

System-mode relationship reads are intentional. File visibility must not let a
principal bypass retention of a publication record it cannot see. The existing
published Form Version deletion guard ensures references cannot be removed first.

### Keep byte attestation outside this boundary

Neither ADR 0027 nor this unit hashes `VersionData`, and `Publication_Digest__c`
remains the digest of the canonical ADR 0023 package supplied by the caller. The
new version IDs prevent later drift and the triggers prevent loss; they do not
prove that the bytes initially uploaded under those IDs matched that package.

The future authenticated publisher must upload the exact package artifacts,
download or otherwise verify the exact stored versions against the locally held
bytes, and only then call the lifecycle commit. No delivery or ingestion code may
infer initial byte integrity from the digest alone. Note 69 is therefore owned
here: its mutable-identity and deletion risks are resolved, while its byte-
attestation warning remains an explicit requirement for that publisher.

## Alternatives considered

- Continue storing only document IDs: a newer version silently changes what a
  latest-version download returns.
- Replace the existing document fields with version IDs: loses the explicit link
  identity and creates an ambiguous migration for already committed records.
- Prohibit every new document version: unnecessary once the exact immutable
  version is pinned and would interfere with unrelated Salesforce Files use.
- Hash `VersionData` in synchronous Apex: accepted artifacts can exceed the Apex
  heap, and it would duplicate the future service publisher's byte boundary.
- Add an upload endpoint or delivery route now: combines OAuth, transport,
  authorization, caching and storage into a unit too large for safe review.

## Consequences and verification

Hosted Apex tests must prove initial commit and replacement, exact no-DML retry,
wrong object/extension/owner and non-latest refusal, distinct documents, stable
old-version bytes after a newer version is added, and refusal of pinned version,
document and link deletion. They must also prove an unpinned document remains
deletable. Existing publication rollback, access and definition-immutability tests
remain in force.

This unit changes Salesforce metadata and therefore needs the ordinary protected
scratch-org gate. It changes no dependency, lockfile, workflow, harness pin,
OAuth selection, credential storage, artifact upload, reviewer/collector delivery,
CLI or target-object write. Note 34 remains open for the authenticated refusing
publisher and its connection requirements. Note 39 remains open for gated,
uncached reviewer delivery. No C10 acceptance test or Phase 1 completion is claimed.

## Revisit when

Composing the authenticated publisher, verifying uploaded bytes, adding artifact
delivery or retention expiry, migrating any pre-release publication data, or
supporting an external immutable blob store.
