# ADR 0035: Bounded Salesforce publication artifact attestation

- Status: Proposed; implementation awaiting independent verification
- Date: 2026-10-09
- Brief sections: C2, C3.11/.16, C5 publish, C8, C11 Phase 1
- Decision owner: Cobitech Solutions
- Extends: ADRs 0023, 0031 and 0032; owns note 69's remaining obligation

## Context

Salesforce now pins immutable `ContentVersion` identifiers and exposes a strict
commit API, but neither boundary proves that the initially uploaded bytes equal the
canonical package. Note 69 therefore forbids treating `Publication_Digest__c` as
byte attestation. The future publisher needs a bounded storage operation whose
successful result is usable by the commit API without trusting upload success.

Tenant OAuth selection, encrypted credential storage and CLI composition remain
separate decisions. This unit consumes only a trusted instance origin and a fresh
short-lived token capability.

## Decision

Add `attestSalesforcePublicationArtifacts`, one attempt-scoped service operation.
It first verifies the exact package SHA-256, schema, audience, component hashes and
canonical XLSX base64 locally. Invalid or hostile package/configuration shapes spend
zero Salesforce requests.

The operation pins REST API 64.0 and creates exactly two new `ContentVersion`
records through one sObject Collections request with `allOrNone: true`. Titles and
paths derive only from the package digest; the paths end in `.xml` and `.xlsx`.
The package's eight-million-character bound keeps this JSON/base64 request below
Salesforce's 37.5 MB non-multipart base64 allowance.

After upload, it retrieves both records' `ContentDocumentId`, `IsLatest` and
`FileExtension`, then downloads each exact version's `VersionData` through the two
binary endpoints. Version IDs are returned only when both downloads equal the
locally held bytes byte-for-byte. Once both document identities are known, a
mismatch or later refusal deletes both newly created documents on a best-effort
basis; cleanup failure has its own static code. An upload whose response is lost,
or whose response cannot be decoded far enough to recover identities, can still
leave unlinked files because Salesforce offers no idempotency key for
`ContentVersion`; the composed publisher must record and reconcile that
operationally rather than pretending the network outcome is known.

Every request obtains a fresh bounded token, disables ambient credentials and
caching, refuses redirects, and shares one overall deadline. JSON provider responses
are limited to 64 KiB. Binary responses cannot exceed the corresponding local
artifact length. Results expose only static codes and request counts, never tokens,
origins, provider bodies, titles, digests or identifiers on failure.

## Consequences and verification

Unit tests prove the exact four-request success sequence, all-or-none body, fresh
tokens, exact paths and byte readback, zero-I/O local refusal, hostile-object and
digest refusal, malformed provider refusal, shared deadlines, mismatch cleanup,
cleanup failure classification, immutability and non-disclosure. Independent review
must also probe the operation against real scratch-org Files and confirm ownership,
extensions, distinct documents, exact downloaded bytes and deletion after a forced
mismatch.

On successful independent verification, note 69's initial-byte-attestation
obligation is answered at the durable-storage boundary. A later publisher must use
this successful result immediately before ADR 0032 commit; it cannot substitute raw
version IDs. Note 34 remains open for tenant connection, restricted-user target FLS
and full publisher/CLI composition. Note 39 remains open for gated delivery.

This unit adds no credential persistence, tenant routing, definition request,
Describe request, compile orchestration, commit call, delivery route, ingestion,
workflow, harness, dependency, lockfile or Salesforce metadata. It claims no C10
test, publish-ready state or Phase 1 completion.

## Revisit when

Composing the authenticated publisher, adding retry reconciliation for uncertain
upload outcomes, changing artifact limits, or supporting an external blob store.
