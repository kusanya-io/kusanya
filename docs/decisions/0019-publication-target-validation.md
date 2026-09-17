# ADR 0019: Publication target-schema validation boundary

- Status: Accepted design decision; implementation awaiting independent verification
- Date: 2026-09-17
- Brief sections: C3.5/.7/.15/.20, C4 mappings, C5 publish checks, C8 field-level security, C11 Phase 1
- Decision owner: Cobitech Solutions

## Context

ADR 0013 deliberately accepts portable Salesforce API identifiers without claiming
that they exist. Claude note 34 demonstrated the resulting boundary: a lexically
valid relationship name such as `Account__r` can be saved as a target object even
though it is not an object that the mapping engine can write. Saved Match Status
and Match Detail are author annotations and cannot authorize publication.

Publication must eventually read the current integration user's Salesforce
Describe results, validate every target, compile and validate collector artifacts,
store an immutable version and expose it through a CLI/API. Combining those steps
would make the first publisher too large to review safely.

## Decision

Add `validatePublicationTargets` as a pure service function. It accepts a bounded
form definition, portable mapping bundle and normalized target-schema snapshot.
The caller must obtain that snapshot freshly as the tenant integration user. This
unit performs no Salesforce call and cannot attest to snapshot identity or age.

The normalized snapshot contains object API name and query/create/update access;
field API name, read/create/update access, external-ID and uniqueness flags, and
lookup targets; and active/available record-type DeveloperNames. Its strict
decoder accepts only ordinary data records and arrays, refuses accessors, proxies,
sparse or extended arrays, unknown keys, case-insensitive duplicate names and
invalid identifiers, and bounds objects, fields, record types, references and
aggregate text. Diagnostics contain stable codes and structural locations only.

Validation resolves API names case-insensitively without rewriting the authored
spelling. Main and repeat mappings require object create access. A read-only
reference mapping requires query access; a reference that supplies writes or an
upsert external ID additionally requires object create and update access. Manual
assignments and trusted collector/submission stamps require field create access.
Reference matching fields require read access; non-unique matching produces a
warning because ingestion must still fail clearly on zero or multiple matches.

An upsert field must be readable, createable, updateable, an external ID and
unique. Parent lookup fields must be createable and reference the parent mapping's
target object. Configured record types must be active and available. Collector and
submission stamp fields cannot collide with manual assignments or one another.
The validator always recomputes these results and never accepts Match Status.

Compiler warnings are preserved. Success is labelled
`validation: target-schema-only`, not publish-ready. Input order and API-name case
do not affect the result, and caller-owned input is not mutated.

## Consequences and verification

Unit tests cover a reference-plus-child graph, record types, stamps, external IDs,
parent lookup targets, object/field access, missing `Account__r`, non-unique match
warnings, collisions, hostile shapes, bounds, case handling, deterministic results
and input immutability. Tests use synthetic snapshots, never customer schema.

This advances C3.5/.7/.15/.20 and the C5/C8 publication checks, and answers note
34 only at the pure validation boundary. Note 34 remains carried until a reviewed
Salesforce adapter obtains a fresh Describe snapshot and the publisher refuses on
these diagnostics. Picklist values, field/transform datatype compatibility,
polymorphic lookup policy, record-type namespace ambiguity, snapshot acquisition,
authorization, JavaRosa validation, immutable storage, lifecycle changes and CLI
publication remain open. No C10 test or Phase 1 completion is claimed.

No Salesforce metadata, permission set, workflow, harness, namespace, delivery
route or dependency changes. No Enketo dependency is installed and no Collect
device/emulator decision is made. Notes 24, 25, 27-31, 34-37 and 39 remain carried;
note 42 remains informational.

## Revisit when

Adding the integration-user Describe adapter, datatype/picklist matching, actual
publish authorization and storage, CLI/API publication, polymorphic relationships,
or a cache policy for schema snapshots.
