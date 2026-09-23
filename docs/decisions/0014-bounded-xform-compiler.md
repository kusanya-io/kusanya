# ADR 0014: Bounded portable XForm compiler

- Status: Accepted design decision; implementation awaiting independent verification
- Date: 2026-09-16
- Brief sections: C2, C3.6/.19, C4, C5, C11 Phase 1, C12
- Decision owner: Cobitech Solutions

## Context

Bill approved the next Phase 1 compiler/validation unit after PRs #10 and #11
merged. Definitions now store question trees, choices, skip rules and mappings,
but successful storage does not establish executable form semantics. Claude notes
27 and 28 require an explicit collector-field allowlist and compile-time rejection
of repeat counts sourced inside their own repeat and non-answerable skip sources.
The complete Phase 1 gate still needs XLSForm round trips, print view, CLI publish
and C10 tests 10 and 12.

## Decision

### Pure compiler before Salesforce or publishing integration

Implement `compileForm(unknown)` in the existing TypeScript service, with no new
runtime or npm dependency. It accepts a versioned, bounded, neutral JSON-shaped
definition and returns either XML plus warnings, or structural diagnostics without
partial XML. Success carries `validation: 'structural-only'`, not a publishable
artifact verdict. It performs no I/O, persistence, Salesforce reads, authentication,
publication or expression evaluation. No HTTP endpoint exposes it in this unit.

Names are portable authoring identifiers, not record IDs or Salesforce API names.
The existing external namespace resolver remains the future Salesforce adapter's
boundary; this compiler has no namespace configuration because it names no
Salesforce object, field or REST path. The Salesforce project namespace stays
empty. No Salesforce metadata, permission, CI, harness pin, package or security
setting is changed. Cross-owner reads under ADR 0011 are still deferred.

Use explicit property/type checks and resource limits rather than accepting
arbitrary JavaScript objects: reject unknown fields, proxies, accessors, exotic
prototypes and sparse/extended arrays. Reject invalid XML text before rendering.
The API expects data, not executable objects. Diagnostic locations are structural
indexes, not echoed names or values. Unexpected programmer errors still throw;
this is not an HTTP error-handling contract or a tenant authorization boundary.

### Allowlisted rendering and stable output

Render the primary instance, typed binds and controls according to the
[ODK XForms specification](https://getodk.github.io/xforms-spec/). Construct XML
from validated fields, escaping text and attribute values; never interpolate raw
XML or serialize the whole input. Include collector labels and hints, never
`authorNotes` or `regexExample`. These author-only fields can remain in the neutral
definition, but cannot enter XML, warnings or error text. A visible `note` question
is distinct from Author Notes and remains collector content.

Sort siblings by positive Order then binary name, choices by Order then value,
and generated skip conditions by their compiled text. Emit fixed whitespace and
attribute order, with no compilation timestamp, random value or source record ID.
The instance-ID calculation is a stable expression evaluated by the future client,
not a compiler-generated UUID. Equivalent record reordering preserves XML bytes;
diagnostic indexes intentionally still refer to the caller's input ordering.
Do not mutate the input. This deterministic foundation is not an XLSForm round-trip
implementation or a C10.10 claim.

### Bounded expressions and scalar repeat scopes

Parse a deliberately small XPath subset with a tokenizer and precedence parser.
Never use `eval`, JavaScript execution or unrestricted expression pass-through.
The grammar, function arities and limits are documented in [the compiler
contract](../compiler.md). Recognize explicit question references and resolve
them against the current graph. Reject missing or non-answerable references,
unrecognized functions, external instances, predicates, arbitrary axes, extensions
and aggregations instead of approximating their meaning.

Scalar references may access a once-only value, an enclosing repeat's current
instance, or the same repeat instance. Root values compile to absolute paths;
repeated values compile to relative paths that retain current-instance context.
Reject references into sibling or deeper repeats without an aggregation contract.
Do not clone a once-only question into each repeat: placement follows the actual
tree, addressing C3.6 structurally. Mapping execution and its answer scopes are
not implemented here.

Detect calculation/relevance/skip/count dependency cycles, including inherited
parent relevance and repeat-count dependencies. Constraints can refer to their
own value and do not add recalculation edges. This conservative policy rejects
some expressions a more advanced engine might permit; add support through a
reviewed extension with runtime tests, not by removing guards.

The compiler does not run user expressions or regular expressions. Regex strings
become quoted arguments to `regex`; syntax acceptance by this parser is not proof
of expression type correctness, regex validity, runtime cost or full engine
equivalence. Future publication must validate the complete artifact using the
chosen runtime/validator before release.

### Repeat and skip behavior

Require an explicit repeat mode. Fixed counts are positive whole values up to
1,000 and use a read-only helper next to the repeat; nested helpers retain their
enclosing instance. Answer-driven counts require an integer question outside the
repeat's own subtree and within scalar reference scope. Constrain that source to
0 through the explicit Repeat Max, or 1,000 if absent. Reject conflicting defaults
or bounds. Open repeats have no generated count; configured open-repeat limits
are unsupported rather than silently omitted.

Fixed and answer-driven repeats use `jr:count` with `jr:noAddRemove`. This does
not mean an answer-driven count shrinks existing data. ODK documents that reducing
a count retains previously created instances. Each answer-driven repeat therefore
emits `DYNAMIC_REPEAT_CLIENT_SPECIFIC`. We do not add silent deletion or claim
exact final submission counts. Hiding/removing surplus answers and validating
ingested counts need a later unit and real client tests before C10.2/C10.3.
This specification-driven limitation is explicit despite the brief's eventual
exact-count requirement. [ODK repeat-count behavior](https://docs.getodk.org/form-logic/#hiding-extra-repeats-when-the-repeat-count-is-reduced)

Skip rules for one target must agree on Join and Action. Build all/any conditions,
then invert the whole group for hide; combine with authored relevance using AND.
Every non-`answered` comparison first requires a nonempty source, including
`is_not`, so blank does not become an accidental positive match. Multi-select
membership uses `selected`, not substring matching. Validate operator/source
compatibility, choice membership and ordered numeric ranges. Reject self sources,
non-answerable sources, contradictory rule policies and invalid scalar scopes.

### Limits and unsupported features

Bound input to 500 questions, 500 choice lists with 5,000 total choices, 2,000 skip
rules, 32 ancestors and one million accumulated string code units. Most text fields
allow 32,768 code units; names and expression limits are tighter. Bound expanded
output conservatively before rendering, then enforce two million output code
units. Reusing a list across many controls therefore cannot multiply a small input
into unchecked XML. These are initial implementation limits, not Salesforce or
ODK platform limits; clients must report them clearly.

Numeric defaults and bounds for integers use the signed 32-bit range. Numeric
defaults/bounds and skip operands use plain decimal notation with at most 12
integer and six fractional digits; no exponent notation or silent rounding.
Numeric skip range ordering uses scaled integers to preserve the authored decimal
comparison. General runtime XPath arithmetic is not a fixed-point engine.

Unsupported configured features fail compilation: `end`, JavaScript validation,
prefill sources, cascade filters/scores, same-page flag, repeat-as-table flag,
live-photo enforcement, media duration limits, unsupported appearances/defaults
and open-repeat maxima. False/unset options retain their default meaning. The
explicit `field-list` appearance is allowed only on sections whose immediate
children are non-containers. Existing drafts may store unsupported options; this
unit does not promise that every saved definition compiles. In particular,
rejecting JavaScript does not complete C10.12.

### Validation tooling and planned runtime matrix

Use the official [ODK Validate 1.20.0 release](https://github.com/getodk/validate/releases/tag/v1.20.0)
as an optional local, offline probe, pinned by SHA-256
`92756ea4aed195355a07e5572f025f0921a31282387a870ae63e1f5cdf37e0c3`.
Its [release build](https://github.com/getodk/validate/blob/v1.20.0/build.gradle)
uses JavaRosa 5.1.0. Run it with an explicitly selected Java 21 executable,
bounded heap/time/output, a reduced child environment and synthetic fixtures only.
No JAR is committed, no package dependency is added, and no CI workflow changes.
The probe refuses a different JAR hash and requires malformed-form and invalid-XPath
negative controls to fail as well as four valid fixtures to pass.

For later runtime compatibility work, plan to test
[ODK Collect v2026.3.4](https://github.com/getodk/collect/releases/tag/v2026.3.4) and
[Enketo Core 7.2.5](https://github.com/enketo/enketo-core/releases/tag/7.2.5).
These are test-matrix targets, not a deployed/approved Enketo
server selection, installed dependencies, or a compatibility/security claim.
Recheck supported versions and choose the Enketo server before deployment.
The older JavaRosa bundled by this validator does not stand in for either client.
Development/staging remain Cobitech and production remains Azure.

## Alternatives considered

- Direct Salesforce reads in the compiler: combines authorization, namespace,
  transport and validation work; postpone to a dedicated reviewed adapter.
- Pass raw XPath or XML through: cannot enforce portable reference scopes or
  deterministic safe serialization. Explicit support is preferable to hidden loss.
- Implement all C4 options at once: exceeds this reviewable first compiler unit.
- Treat validator success as client compatibility: does not test UI behavior,
  dynamic repeat edits, offline collection or submission semantics.
- Silently trim repeats when counts decrease: risks data loss and contradicts
  the documented native behavior without a reviewed lifecycle contract.

## Consequences and verification

Synthetic tests cover deterministic rendering, text escaping, Author Notes
exclusion, scalar scopes, nested counts, skip semantics, cycles, unsupported
features, numeric precision and resource limits. The offline probe validates
mixed, nested, scalar/media and hostile-looking quoted-text fixtures, and rejects
malformed non-XForm input and an unsupported XPath function.
These are local compiler checks, not Salesforce integration, end-to-end collection
or independent verifier evidence. Normal PR review and the existing CI approval
process still apply; no extra scratch org is authorized by this ADR.

No C10 acceptance test is claimed. XLSForm import/export, lossless constants,
full publish validation, print view, CLI publishing, Salesforce adapters, target
Describe/CRUD/FLS checks, tenant delivery, mapping/ingestion and client runtime
tests remain outstanding. Author-only exclusion must also be preserved in every
future delivery path; this compiler cannot protect a separate serializer.

## Revisit when

Adding an adapter or publication endpoint, implementing unsupported C4 semantics,
requiring more expressive XPath/aggregation, extending numeric or form-size limits,
selecting deployed client/server versions, handling repeat-count reductions or
claiming any Phase 1 acceptance test.
