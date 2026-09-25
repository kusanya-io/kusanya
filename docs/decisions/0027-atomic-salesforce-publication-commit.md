# ADR 0027: Atomic Salesforce publication commit

- Status: Proposed; implementation awaiting independent verification
- Date: 2026-09-24
- Brief sections: C2, C3.11, C3.16, C4 artifacts and audit, C8, C11 Phase 1
- Decision owner: Cobitech Solutions

ADR 0031 supersedes this ADR's artifact-identity details: the commit now accepts
and stores exact `ContentVersion` IDs, derives the `ContentDocument` IDs used for
links, and protects the pinned versions, documents and links from deletion. This
ADR's warning that the commit does not hash the file bodies remains in force.

## Context

ADRs 0022 through 0024 produce and validate a content-addressed publication
package, and ADR 0026 reads one portable definition snapshot from Salesforce.
None of those boundaries durably records publication. The existing Form Version
artifact fields are plain text, statuses can be edited independently, and later
definition edits can make the Salesforce source disagree with the reviewed files.

The service cannot atomically upload Salesforce Files and update custom records:
file upload is a separate API operation. This unit therefore needs a narrow
Salesforce commit boundary for files already uploaded by the same integration
principal. It must fail closed without turning an untrusted caller's digest or
ContentDocument ID into proof that validation occurred.

## Decision

### Commit one validated candidate in one Salesforce transaction

`PublicationLifecycle.commitPublication` is an internal `with sharing` Apex method. It
accepts one Draft Form Version ID, the lowercase SHA-256 digest of the exact
canonical ADR 0023 package, distinct XForm XML and XLSForm XLSX ContentDocument
IDs, and the already-reviewed warning text. The caller must have completed the
ADR 0022/0024 validation and uploaded the exact package artifacts before calling
this method; a future authenticated publisher composition will own that sequence.

After a minimal identity read, the method locks the Form first and then all its
Form Versions in a consistent order. Its reads and writes use user mode. Both files must exist in the caller's visible
scope, have the expected extension and have been created by that caller. The
version must have no existing artifact links or publication metadata. A first
publication requires a Draft Form with either no current pointer or a pointer to
that same Draft version. A later publication requires exactly one current
Published version consistent with the Form pointer.

Under one savepoint, the method:

1. links exactly the two supplied ContentDocuments to the target version;
2. marks the previous Published version Superseded, when present;
3. records the two file IDs, package digest, warning text, one shared compilation
   and publication timestamp, and the publishing user on the target version;
4. marks the target Published; and
5. marks the Form Published and advances Current Version to the target.

Every DML operation is all-or-none and user-mode. Any platform, sharing, CRUD,
FLS, trigger or consistency failure rolls back to the savepoint and produces only
`PUBLICATION_COMMIT_REFUSED`. Provider messages, object names and supplied values
are not returned.

The digest binds the committed metadata to the canonical package identity; Apex
does not re-read or hash file bodies because a valid XLSX may exceed the synchronous
Apex heap. Consequently this internal method is not independently callable proof
that the linked bytes match the digest. The later external publisher must remain
the reviewed composition that validates, uploads, verifies upload identities and
then calls this boundary. No endpoint or permission-set class access is added now.

### Make exact retries idempotent

If the target is already the Form's sole current Published version, an exact retry
with the same digest, file IDs, warning text and publishing principal returns
success without DML and reports `alreadyCommitted=true`. The stored compilation
and publication timestamps must be equal and the version must have exactly those
two links. A changed digest, file order, warning, principal, link set or lifecycle
state refuses. Superseded versions cannot be republished.

### Freeze the published definition graph

Private transaction state inside `PublicationLifecycle` authorizes only the exact
Form and Form Version values prepared by the commit. Triggers reject direct edits
to publication metadata and status transitions. Draft Forms retain the earlier
authoring behavior of selecting a Draft current version, but Published Forms cannot
change status or current pointer outside the committer. Published and Superseded
Form Versions cannot be edited or deleted.

`PublishedDefinitionGuard` also rejects insert, update and delete operations that
reach a non-Draft version through Question, Skip Rule, Mapping or Field Mapping.
Choice and Choice List mutations are rejected when an inline owner or any shared
list consumer belongs to a non-Draft version. Form deletion is rejected if any
owned version is Published or Superseded. Integrity reads deliberately run in
system mode so hidden definitions cannot bypass immutability; they expose no data
and perform no DML.

The guard protects every version-owned source record. Form-level authoring fields
remain editable because they are shared by all versions rather than copied into a
version. The committed XLSX embeds the canonical authoring snapshot, while the
digest identifies the full upstream package; a later reread of Form fields is not
historical publication evidence. Exact reconstruction of the full package also
requires the later storage boundary to retain its target snapshot/package bytes.
Revisiting this modelling tradeoff requires versioned Form settings, not a trigger
that would make future titles and settings permanently uneditable.

The committed Files remain ordinary Salesforce ContentDocuments; retention,
replacement and deletion policy
for those files belongs to the later delivery/storage unit. The digest and exact
retry checks refuse inconsistent pointers but do not grant a collector access.

## Alternatives considered

- Let the service update fields independently: permits partial publication and
  races between two versions.
- Trust status or saved Match Status: neither proves fresh target validation or
  artifact identity.
- Re-download and hash file bodies in synchronous Apex: an accepted XLSX can exceed
  the Apex heap, so this cannot cover the existing package bound safely.
- Expose REST/Aura now: authentication, tenant binding, OAuth selection and token
  storage are unresolved portions of note 34.
- Make all definition objects read-only in metadata: authors still need mutable
  Draft versions, and shared Choice Lists require relationship-aware protection.

## Consequences and verification

Hosted tests use synthetic users and Files to prove first publication, replacement,
the previous-version transition, exact no-DML retry, static mismatch refusals and
rollback for a read-only principal. They exercise direct edits and deletes across
the complete definition graph, shared choices, Form and Form Version lifecycle
fields, while confirming Draft definitions remain editable and deletable.

This unit adds `Form_Version__c.Publication_Digest__c`, a non-unique Text(64) whose
write boundary accepts only canonical lowercase SHA-256. It is readable by all
three Kusanya permission sets and editable only where the other publication fields
are editable. It changes no workflow, harness, policy script,
dependency, OAuth, target Describe or namespace boundary.

This is durable publication state, not an externally callable publisher. Note 34
therefore remains open for tenant OAuth selection, encrypted credential storage
and rotation, restricted-user target-object FLS proof, and the authenticated
refusing composition. Note 39 remains open because no reviewer delivery route is
added. Notes 36 and 37 remain untouched. No C10 acceptance test or Phase 1 gate is
claimed.

## Revisit when

Adding the authenticated CLI/service publisher, upload verification, artifact
retention or delivery, revision rollback, submitted-version retention, portable
cross-org identities, or namespaced package execution.
