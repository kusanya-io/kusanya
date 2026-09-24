# ADR 0029: Submitted repeat cardinality

- Status: Proposed; implementation awaiting independent verification
- Date: 2026-09-24
- Brief sections: C3.6, C3.19, C5, C7, C9, C10.2/.3 foundation, C11 Phase 1
- Decision owner: Cobitech Solutions

## Context

The ADR 0015 runtime matrix established a real client difference after a dynamic
repeat count is reduced below the number of already-answered instances. Enketo
removes the trailing instances. ODK Collect v2026.3.4 retains and submits them.
Both behaviors are valid client behavior, so compilation cannot make their final
payload cardinality identical.

The product brief requires the HWWS child-record count to match the collector's
stated count. Treating every submitted repeat node as a record would violate that
rule for Collect, while trusting the physical nodes for Enketo would make the same
answers channel-dependent. Silently selecting a rule only inside a future mapper
would also let published packages drift from the ingestion behavior they were
reviewed against.

## Decision

### The submitted count is authoritative

For a `from_answer` repeat, Kusanya processes the first `N` repeat instances in
document order within each enclosing repeat context, where `N` is the exact
submitted value of that repeat's configured count-source question. Instances
beyond `N` are excluded from normalized Answers and mapped child records. This
makes the effective cardinality identical to Enketo while handling the extra
instances Collect can retain.

The count must be one canonical nonnegative base-10 integer (`0` or a nonzero
digit followed by digits) no greater than the published repeat maximum, or 1,000
when no maximum is configured. Missing, duplicate, blank, signed, padded, decimal,
out-of-range or ambiguous counts fail closed. Fewer physical repeat instances than
the submitted count also fail closed; Kusanya never invents missing instances.
The rule applies independently in every enclosing repeat instance. Fixed and open
repeats are unchanged by this policy.

The raw XML and media remain the immutable audit/reprocessing source. Cardinality
normalization returns a detached tree plus structural exclusion counts; it does
not mutate or replace the raw submission. Exclusion is deliberate ingestion
semantics, not deletion of the received evidence.

### Normalize only after bounded parsing and definition validation

Add a pure service boundary over an already-parsed submission tree. It validates
the portable definition through the existing compiler preparation, strictly
decodes ordinary data records and arrays without invoking accessors or proxies,
checks known-question placement, and bounds depth, node count and text. Unknown
parsed nodes remain present, consistent with the future ingestion requirement to
retain unknown answers with a warning. Known nodes cannot move to a different
definition scope.

The normalizer is deterministic, input-preserving and deeply freezes success
results. Diagnostics contain only codes and structural input locations. It does
not parse XML, create Answer records, evaluate mapping transforms, write target
records, acknowledge a submission or enforce retention; those remain later
ingestion units.

### Pin the rule in every publication package

The content-addressed publication package advances to schema version 2 and adds:

```json
{ "submissionPolicy": { "dynamicRepeatCardinality": "submitted-count-v1" } }
```

The marker is part of the canonical package bytes and digest. A future ingestion
adapter must select the implementation from the stored package and refuse unknown
policy versions rather than applying its current default. No production package
exists that requires a version-1 migration.

The compiler diagnostic code remains `DYNAMIC_REPEAT_CLIENT_SPECIFIC`, because
the clients still retain different raw rows. Its reviewer text now states the
authoritative-count rule, trailing-instance exclusion and raw-payload retention.

## Alternatives considered

- Process every physical repeat node: makes Collect create more child records than
  the submitted count while Enketo does not.
- Reject every Collect payload with retained trailing rows: fails a valid client
  sequence that can no longer expose those hidden rows for correction.
- Trust the count but silently trim inside the mapper: gives no reviewed,
  content-addressed policy to the later ingestion boundary.
- Prohibit count reduction or all dynamic repeats: is not enforceable consistently
  in both supported clients and discards a required product capability.

## Consequences and verification

Unit tests cover per-parent and root-scoped counts, nested dynamic repeats, zero,
surplus and deficit rows, malformed counts, fixed-repeat preservation, excluded
outer branches, unknown leaf and group nodes (including canonical metadata),
immutability, determinism, hostile shapes and resource bounds.
Publication-package tests require schema version 2 and the exact policy marker.

This decision answers note 37 at the policy and pure-normalization boundary after
independent verification. It is only a foundation for C10.2 and C10.3: neither
acceptance test is claimed until raw XML parsing, durable submission storage,
Answer creation and transactional mapping enforce this package-pinned rule.

No workflow, dependency, lockfile, Salesforce metadata, Enketo tooling or Android
device change is part of this unit. Notes 34, 39 and 69 and the carried operational
notes remain open or informational as previously recorded.

## Revisit when

Implementing XML parsing and Answer creation, versioning another cardinality rule,
changing the repeat maximum, supporting edits to finalized submissions, or
changing raw-submission retention.
