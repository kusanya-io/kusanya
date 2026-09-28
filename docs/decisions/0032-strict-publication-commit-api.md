# ADR 0032: Strict Salesforce publication commit API

- Status: Proposed; implementation awaiting independent verification
- Date: 2026-09-28
- Brief sections: C2, C3.11/.16, C4 publication audit, C8, C11 Phase 1
- Decision owner: Cobitech Solutions
- Extends: ADRs 0027 and 0031

## Context

ADRs 0027 and 0031 provide an atomic, user-mode Apex publication lifecycle that
accepts exact `ContentVersion` identifiers, but deliberately expose no remote
entry point. A later service publisher cannot invoke that internal method through
Salesforce REST. Exposing the lifecycle requires a boundary that does not weaken
its sharing, CRUD/FLS, exact-retry, rollback or non-disclosure properties.

This is only the commit edge. Artifact upload, stored-byte verification, tenant
OAuth selection, encrypted credential persistence and CLI composition remain
separate work. Combining them here would make authentication, storage, transport
and lifecycle failures impossible to review independently.

## Decision

### Expose one integration-only operation

`PublicationCommitResource` is a `global with sharing` Apex REST resource at
`/services/apexrest/v1/publications/commit`. It exposes one `@HttpPost` method and
calls `PublicationLifecycle.commitPublication` exactly once after local decoding.
The authenticated Salesforce user remains the lifecycle principal; the request
cannot supply a tenant, username, owner or publishing user.

The resource class and a new `Publish_Kusanya` custom permission are granted only
by `Kusanya_Integration`. Admin and Supervisor receive neither. The resource also
checks the custom permission before reading the request body, providing an
explicit fail-closed authorization boundary even if class access is broadened by
an unrelated profile later.

### Use a bounded, exact JSON envelope

The request must use `application/json`, optionally with exactly `charset=UTF-8`,
and its decoded body must not exceed 200,000 bytes. The top-level value is one
ordinary JSON object containing each of these fields exactly once and no others:

```json
{
  "schemaVersion": 1,
  "formVersionId": "a Salesforce Form Version ID",
  "publicationDigest": "a lowercase SHA-256 digest",
  "xformVersionId": "an exact XML ContentVersion ID",
  "xlsformVersionId": "an exact XLSX ContentVersion ID",
  "compileWarnings": null
}
```

`compileWarnings` may instead be a string. The streaming parser rejects duplicate,
missing and unknown fields, wrong JSON types, nested replacements, trailing input,
unsupported schema versions and malformed Salesforce identifiers. The lifecycle
continues to own semantic checks, including object types, digest spelling, warning
length, file ownership/extensions/latest state and publication consistency.

Successful responses are deterministic JSON containing schema version 1, the
`alreadyCommitted` flag and the accepted package digest. They do not repeat record
or file identifiers. Responses carry `Cache-Control: no-store`. Authorization,
method, media-type, size, request/lifecycle refusal and unexpected failures use
fixed codes with no supplied values, provider messages or exception details.

### Preserve the byte-attestation boundary

This endpoint neither uploads nor downloads a file and never reads `VersionData`.
It therefore does not close note 69's remaining obligation. A future authenticated
publisher must upload the exact ADR 0023 artifacts, read back the two selected
versions, compare those stored bytes with its local package, and only then invoke
this endpoint. `Publication_Digest__c` alone remains insufficient evidence.

## Alternatives considered

- Expose `PublicationLifecycle` directly with Aura or invocable annotations: these
  do not provide the intended service REST contract and broaden invocation paths.
- Accept a generic map and let Apex deserialize it: unknown and duplicate fields
  can be accepted silently, weakening the reviewed request contract.
- Put an OAuth token or tenant identifier in the body: the authenticated Salesforce
  session already selects the org and principal; caller-supplied routing would
  create a cross-tenant confusion boundary.
- Upload and attest artifacts in this resource: synchronous Apex cannot safely hash
  every accepted XLSX size and would duplicate the future service-side boundary.

## Consequences and verification

Hosted tests must run the entry point as an Integration principal and prove first
commit, exact zero-DML retry, deterministic responses, duplicate/unknown/missing
field refusal, type and schema refusal, trailing-data refusal, request/media/method
bounds, static non-disclosing lifecycle failure and denial before body decoding for
an ungranted principal. Static tests pin the exact route, single HTTP method,
permission-set scope, custom permission, body cap, parser choice and single
lifecycle call.

This unit changes Salesforce metadata and requires the protected scratch-org gate.
It adds no service endpoint, dependency, lockfile, workflow, harness change,
artifact transport, OAuth storage, reviewer/collector delivery, target write or
CLI. Note 34 advances through a callable refusing commit boundary but remains open
for tenant OAuth selection, encrypted credential persistence/rotation, restricted-
user target FLS proof and the composed publisher. Note 39 remains open. Note 69
remains partly open as described above. No C10 acceptance test or Phase 1 completion
claim is made.

## Revisit when

Composing the authenticated artifact publisher and CLI, versioning the endpoint,
adding tenant connection storage, or changing the publication lifecycle contract.
