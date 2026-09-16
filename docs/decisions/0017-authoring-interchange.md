# ADR 0017: Portable authoring bundles and consistency-checked XLSForm tables

- Status: Accepted design decision; implementation awaiting independent verification
- Date: 2026-09-16
- Brief sections: C2 service compiler boundary, C3.12/.19, C5 import/export, C11 Phase 1
- Decision owner: Cobitech Solutions

## Context

Phase 1 needs lossless form interchange before importing definitions into a new
org or publishing from the CLI. The compiler and reviewer print unit already
validate a portable definition and mapping snapshot. No binary spreadsheet
dependency or Salesforce reader/writer is present. `seed/xlsform/` contains only
its placeholder, so no claim about the real migration workbooks is possible.

Compiled expressions alone cannot preserve authoring intent: skip rules combine
with authored relevance, and regex/bounds/count constraints combine with authored
constraints. XLSForm's standard columns also do not represent Kusanya's complete
mapping configuration, separate author notes or every optional-property distinction.

## Decision

### A bounded authoring bundle first

Use a versioned envelope with `kind: 'kusanya-authoring'`, `schemaVersion: 1`,
`definition` and `mappings`. Reuse the current compiler preparation, final XML
length check and mapping-summary decoder. A successful bundle remains
`validation: 'structural-only'` and `audience: 'authoring-only'`.

This is the supported compiler definition plus the supplied mapping configuration,
not all C4 records. It excludes org identities, storage/publication state, Files,
Tasks, submissions, credentials and access grants as schema fields. It does not
Describe-check customer targets or execute mappings. Free text is still arbitrary
author content, not automatically non-sensitive data.

Canonical JSON uses binary object-key ordering and semantic record order:
question-tree preorder, lists by name, choices by Order/value, rules by complete
canonical value, mappings by Order/key and assignments by case-folded target name
with exact spelling retained. Arrays of definition records are not authoring order
when explicit Order/tree fields determine their meaning. Preserve raw XPath,
skip-rule records, unused choice lists, annotations, explicit false/empty values,
null constants and literal numeric/boolean strings. Do not trim or Unicode-normalize
text. Numeric negative zero becomes zero; neither the compiler nor JSON gives it
a separate form meaning.

At the JSON text boundary, reject a numeric token when conversion to the service's
JavaScript number changes its exact decimal value, including nonzero underflow.
Equivalent notation such as `1.00e0` and `1` is accepted. Compare normalized decimal
significand/exponent strings against the number's canonical spelling; do not use
floating-point equality to detect an already-rounded input or construct unbounded
big integers. Existing numeric range/precision validation still applies afterward.

Inputs must be bounded plain data. Reject proxies, accessors, symbols, sparse or
extended arrays, cycles, unsupported prototypes, undefined/nonfinite values and
unknown fields without invoking supplied code. The text importer rejects duplicate
decoded JSON keys rather than accepting last-key-wins input. Diagnostics contain
structural codes/locations, not supplied values or parser error excerpts.

After canonicalizing, validate again and return warnings in canonical question-index
order. Warning locations are indices in the returned definition, not the original
record array. Failed input diagnostics retain the existing structural validation
contract. Canonicalization does not promise identical invalid-input diagnostics
under arbitrary record reordering.

### Consistency-checked table profile, not a generic workbook importer

Add a pure `kusanya-xlsform-profile` version 1 with four named tables: `survey`,
`choices`, `settings`, and `kusanya_source`. Every cell is a literal string.
The first three use recognizable XLSForm columns and group/repeat rows. The source
table carries the canonical authoring JSON in indexed chunks, without splitting
surrogate pairs. Chunks avoid requiring a whole form to fit in one future Excel cell.

On import, strictly validate the tables and source, regenerate the complete profile,
and compare every cell. A changed visible cell, dropped column, missing row or
contradictory source is refused. Never silently ignore the user's edited projection
or choose one of two conflicting definitions. There is no stored hash that can
substitute for validation.

This consistency check is not a signature or authenticity guarantee. An author may
change the source and regenerate a matching profile. The supported editing path is
to edit the authoring definition and re-export, not edit only a derived cell. Generic
edited XLSForm import needs a separately reviewed translation/precedence design.

The projection uses prepared relevance/constraints/calculations, preserving their
context. Fixed repeat counts are literal; answer-driven counts refer to their source,
not to an omitted compiler helper. Original types and details remain in source.
Settings explicitly request root `data` and no whitespace collapsing. Standard
column/type conventions follow [XLSForm](https://xlsform.org/en/), not a proprietary
replacement for that specification.

The table projection is **not proven deployable through another XLSForm converter**.
In particular, XLSForm can interpret `${name}` in labels and expressions in defaults,
whereas the current compiler treats labels/defaults as literals. Nested expression
context, hidden binds, repeat wrappers and generated metadata also need converter
comparison before any external equivalence claim. Our round-trip proof imports the
preserved source into Kusanya and compares its compiled XML; it does not bypass
these future interoperability tests.

### Resource and delivery boundaries

Bound JSON text, object depth/nodes/string data, tables, cells and total text before
returning output; exact limits are in the runbook. Oversized inputs fail, rather
than truncating cells or discarding fields. Table cells have a conservative 32,767
UTF-16-unit ceiling. No ZIP/XML spreadsheet parser, formula evaluator, CSV writer,
network call, filesystem input or dependency is introduced into the service.

A future binary adapter must write string cells explicitly, never interpret leading
`=`, `+`, `-` or `@` as formulas, and independently bound ZIP expansion/XML parsing.
It must reject unsupported workbook features and cannot rely on cached formula values.
That adapter will have its own dependency/security and real-workbook tests.

Authoring exports intentionally contain Author Notes/Regex Example. Like reviewer
HTML, they are not collector payloads. Any delivery route requires authorization
and a separately reviewed security design; returning an audience label is not access
control. No route, Salesforce write, scratch org, CI or namespace change is included.

## Consequences and verification

The [interchange runbook](../interchange.md) documents the API and synthetic local
round-trip checker. Tests compare canonical source and exact compiled XML, preserve
mapping and annotation values, mutate projections and exercise malformed JSON,
executable objects, namespace fixtures and resource limits. Source files and test
fixtures are synthetic; production seed records are not exported into artifacts.

This advances C3.12/C5 but does not complete them. Binary `.xlsx` handling, general
XLSForm import, complete C4 bundle coverage, Salesforce persistence and C10.10's
fresh-org round trip remain open. C10.12, publication, CLI publish, the actual
Collect UI and notes 36/37's client-count policy also remain open. No C10 acceptance
test or phase gate is claimed. No additional optional runtime-tool installation is
authorized by this decision.

## Revisit when

Adding the binary adapter, general table editing, model/schema versions, migrations,
Salesforce import/export, hosted authoring delivery, or any third-party converter,
client, publication or C10.10 claim.
