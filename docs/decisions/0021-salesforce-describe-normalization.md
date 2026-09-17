# ADR 0021: Fresh Salesforce Describe normalization boundary

- Status: Accepted design decision; implementation awaiting independent verification
- Date: 2026-09-17
- Brief sections: C3.5/.7/.14/.15, C5 publish checks, C8 field-level security, C11 Phase 1
- Decision owner: Cobitech Solutions

## Context

ADRs 0019 and 0020 validate a caller-supplied normalized target schema, but do not
define how Salesforce REST Describe responses reach that boundary. Note 34 remains
open because a saved lexical target such as a relationship name must be rejected
using current integration-user metadata, and saved Match Status is untrusted.

Salesforce's REST
[sObject Describe](https://developer.salesforce.com/docs/platform/api-rest/guide/resources-sobject-describe.html)
resource supplies object, field, picklist, reference and record-type metadata.
This design assumes fields hidden from the authenticated user by field-level
security are absent from the returned field set. That assumption has not yet been
confirmed with a restricted integration user in a scratch org. OAuth, tenant token
encryption and publication storage are separate security boundaries and are not
ready to combine with normalization.

## Decision

Add a dependency-injected loader that accepts only target object API names and a
Describe function already bound to the tenant integration-user session. Every
invocation performs one request per distinct case-insensitive object name, with no
cache or conditional request. At most 100 object names are accepted. Names are
deduplicated and requested in canonical deterministic order, so repeated mappings
do not spend repeated API calls.

The adapter checks that each returned object name matches the requested identity
case-insensitively. It copies only the normalized properties needed by ADRs 0019
and 0020: object query/create/update access; field name, canonical type,
create/update access, nullability, external-ID and uniqueness flags, restricted
picklist values and reference targets; and record-type DeveloperName,
active and available flags. Salesforce wire type spellings are case-folded and
mapped to the canonical vocabulary; in particular, `int` becomes `integer`, while
unknown types still fail closed. Every returned field is currently marked readable
under the FLS-omission assumption above. An omitted mapped field therefore fails
downstream as missing. If a real-org probe disproves that assumption, this boundary
must gain an authoritative readability signal before publisher integration.

Salesforce adds unrelated properties to Describe responses across API versions, so
ordinary extra data properties are ignored. Proxies, accessors, symbols, exotic
records, sparse or extended arrays, unknown field types, duplicate names or values,
misplaced picklist/reference metadata, identity mismatches and configured size
bounds fail closed. The adapter never exposes object names, provider errors or
response values in diagnostics. Caller-owned names and responses are not mutated.

The adapter uses the same bounds as the normalized validator: 100 objects, 5,000
fields in aggregate, 2,000 picklist values per field and 10,000 in aggregate, 100
reference targets per field, 1,000 record types in aggregate and 500,000 normalized
text units. It returns its exact request count so later publication orchestration
can account for API use. These are publication metadata calls, not C10.15's
still-undecided ingestion API-call budget.

## Consequences and verification

Synthetic tests cover normalization, FLS omission, picklists, references, record
types, case-insensitive deduplication, deterministic fresh requests, input
immutability, request failures, identity mismatch, hostile structures, unknown
types, duplicate metadata and bounds. No customer Describe fixture or credential
is committed and no Salesforce call is made by the tests.

This unit does not derive target names from a validated mapping bundle, authenticate
to Salesforce, select an API version, store or refresh tokens, cache metadata,
validate record-type-specific picklists, run JavaRosa, create immutable artifacts
or expose CLI/API publication. The future publisher must own those steps and call
this adapter immediately before ADR 0019/0020 validation. Note 34 advances but
stays open until that refusing publisher and a real integration-user adapter are
reviewed together. A real scratch-org check with a restricted integration user must
also establish whether Describe omits FLS-inaccessible fields before relying on the
current `readable: true` normalization.

No dependency, Salesforce metadata, permission, workflow, route or persistence
change is included. Notes 36, 37 and 39 remain open; notes 42 and 45 remain
informational. No Enketo dependency is installed and no Collect device/emulator
decision is made. No C10 acceptance test or Phase 1 gate is claimed.

## Revisit when

Adding tenant OAuth, the concrete REST transport and API version, publication
orchestration, record-type-specific picklists, immutable artifact storage or CLI
publication.
