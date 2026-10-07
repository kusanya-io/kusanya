# ADR 0034: Strict Salesforce definition snapshot API

- Status: Proposed; implementation awaiting independent verification
- Date: 2026-10-07
- Brief sections: C2, C3.16, C4 sharing and permissions, C8, C11 Phase 1
- Decision owner: Cobitech Solutions
- Extends: ADR 0026; complements ADR 0032

## Context

ADR 0026 provides a deterministic, user-mode Apex reader that translates one
Salesforce Form Version into the portable definition and mapping bundle consumed by
the publication pipeline. It is intentionally internal. ADR 0032 exposes the other
end of publication through a strict integration-only commit API. The service and
Phase 1 publish CLI still have no reviewed way to load the definition they must
compile.

This unit exposes only that read edge. Artifact upload and stored-byte attestation,
fresh target Describe, compilation, commit composition, tenant OAuth selection,
credential persistence and the CLI remain separate boundaries so their failure and
authorization modes can be reviewed independently.

## Decision

### Expose one integration-only definition operation

`DefinitionSnapshotResource` is a `global with sharing` Apex REST resource at
`/services/apexrest/v1/publications/definition`. It exposes one `@HttpPost` method.
The method requires the existing `Publish_Kusanya` custom permission before it
reads the request body, and Apex class access is added only to
`Kusanya_Integration`. Admin and Supervisor receive neither class access nor the
custom permission.

The authenticated Salesforce principal remains the read principal. The request
cannot select a tenant, user, owner or credential. The resource delegates exactly
once to `DefinitionSnapshotReader.readVersion`, whose with-sharing, user-mode
queries, cross-owner definition grants, relationship translation, row bounds and
static refusal remain authoritative.

### Use one strict bounded request

The request uses `application/json`, optionally with exactly `charset=UTF-8`, and
is capped at 2,048 bytes. Its top-level object contains exactly these fields once
and no others:

```json
{
  "schemaVersion": 1,
  "formVersionId": "a Salesforce Form Version ID"
}
```

A streaming parser rejects duplicate, missing and unknown fields, wrong JSON
types, nested replacements, unsupported schema versions, trailing input and
malformed Salesforce identifiers. Empty and malformed input produces only a
static refusal without echoing supplied values or provider messages.

### Return only the portable snapshot

Success serializes the exact ADR 0026 envelope: schema version 1, portable form
definition and portable mapping bundle. Salesforce IDs are used only to select the
version and resolve relationships inside the reader; they do not enter the
response. Repeated reads of unchanged source records produce identical response
bytes. Responses are capped at 5,000,000 bytes and carry `Cache-Control: no-store`
and JSON UTF-8 content type.

Authorization, method, media-type, request-size, decoding, reader and unexpected
failures use fixed codes. They do not return record identities, supplied names,
definition values, provider messages or exception details.

## Consequences and verification

Hosted tests must call the resource as an Integration principal against a
definition owned by another user and prove deterministic portable output, no DML,
the reader's fixed query budget and absence of Salesforce relationship IDs. They
must also prove strict decoding, exact request bounds, wrong-identity and reader
refusal, media and method refusal, and denial of both ordinary and Supervisor
principals before body access. Static tests pin the route, single method, request
and response caps, streaming parser, single reader call, non-disclosure contract
and exact permission-set scope.

This unit changes Salesforce metadata and requires the protected scratch-org gate.
It adds no workflow, harness, pin, policy-script, dependency, lockfile, service
transport, OAuth storage, tenant routing, Describe request, compiler invocation,
artifact upload, stored-byte attestation, commit call, delivery route or CLI. Note
34 advances through the reviewed external definition-read edge but remains open
for tenant connection, restricted-user target FLS and publisher composition. Note
69 remains partly open, and note 39 remains open. No C10, publish-ready or Phase 1
completion claim is made.

## Revisit when

Composing the authenticated publisher, versioning the endpoint, changing snapshot
bounds, persisting portable cross-org keys or exposing definitions to reviewers or
collectors.
