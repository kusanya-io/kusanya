# ADR 0060: Portable validation for authored JavaScript rules

- Status: Proposed; implementation awaiting independent verification
- Date: 2026-10-29
- Brief sections: C1.2, C4, C10.12, C11 Phase 1
- Decision owner: Cobitech Solutions

## Context

Question definitions retain `Validation_Script` for migration compatibility with
TaroWorks dynamic validation. Brief C4 places JavaScript execution in phase 2 and
requires every such rule to have an XPath constraint or to produce a builder
warning. Brief C10.12 separately requires a time entered as text, a regular
expression and a JavaScript validation to compile to an XForm whose constraint
enforces the same rule in stock ODK Collect.

The first compiler rejected every nonempty validation script. That was safe but
made the C10.12 source shape unpublishable even when its portable regex already
expressed the rule. Executing or translating arbitrary author JavaScript in the
service would create a code-execution boundary and cannot prove semantic
equivalence to XPath.

C10.11, not C10.12, is the later Phase 5 test that converts the seven supplied
TaroWorks forms and publishes them from the CLI. A real CI workload identity is
therefore not part of C10.12. Earlier ADR 0057/0058 and roadmap wording that joined
those requirements is corrected by this decision.

## Decision

Treat `validationScript` as opaque authoring source:

- bound and structurally decode it with the rest of the definition;
- never parse, evaluate, interpolate, serialize or log its contents;
- compile only the ordinary `constraint`, `regex`, minimum and maximum fields;
- return `VALIDATION_SCRIPT_NOT_EXECUTED` for every nonempty script; and
- additionally return `VALIDATION_SCRIPT_WITHOUT_PORTABLE_RULE` when the complete
  compiled bind has no constraint at all. Authored XPath, regex, numeric bounds and
  repeat-source bounds each suppress that second warning.

Sections, repeats and notes may not carry a script and still fail through their
existing container/note option guards. Other question types receive the warning
behavior above. Empty strings retain their existing omitted meaning.

The synthetic C10.12 fixture defines one shared HH:MM pattern and uses it in both
the authored JavaScript text and the portable regex. The compiler therefore does
not infer equivalence: the fixture authors one rule twice, while only the regex is
allowed into the XForm. Its reviewed XML SHA-256 is
`7e629c7ece2eeb9f75f42535837db62c0c5fe12be1cad52f9d1989cb099b975d`.

## Alternatives considered

- Continue rejecting scripts: safe, but refuses the exact accepted source shape
  even when a portable rule is present.
- Translate a JavaScript subset into XPath: creates two expression languages and
  an equivalence claim that a bounded translator cannot make safely.
- Execute JavaScript during compilation or on the phone: violates the phase
  boundary and introduces executable author input. Kusanya does neither.
- Silently discard the script: collectors would receive weaker validation without
  an author-visible signal.
- Refuse scripts that lack a portable rule: safer than a warning, but conflicts
  with C4's explicit builder-warning behavior and prevents preserving phase-2
  authoring intent in draft/interchange data.

## Consequences and verification

The service tests pin both warning states, structural locations, script exclusion,
container/note refusal, deterministic XML bytes and a genuine regex constraint.
The shared authoring and XLSForm round trips retain the opaque source only in their
authoring payload; it never appears in collector XML or compiler diagnostics.

The exact fixture passes the hash-pinned ODK Validate 1.20.0 probe, including its
invalid-XPath and malformed-form negative controls. That proves parsing only.
The builder loaded the exact reviewed XML in stock ODK Collect v2026.3.5 on
2026-10-29. The UI refused blank, `24:00` and `09:60`, with the authored constraint
message on the two invalid values, and accepted `00:00`, `09:30` and `23:59`.
Nothing was finalized or submitted. The run was synthetic and offline: no tenant,
Salesforce org, credential, Task or submission endpoint. C10.12 remains subject to
independent exact-head reproduction before it passes.

ADR 0014 originally targeted v2026.3.4. The existing approved emulator now reports
v2026.3.5, which ODK released as the latest stable bug-fix build on 2026-09-28;
v2026.4.0 remains a prerelease. This decision advances the stock-Collect validation
target to v2026.3.5 and records the exact installed package version before testing.

This decision does not add JavaScript execution, establish arbitrary script/XPath
equivalence, complete C10.10 or C10.11, select a production workload identity, or
complete the Phase 1 gate by itself.

## Revisit when

Phase 2 proposes a sandboxed validation runtime, the portable constraint model
changes, Collect changes its regex semantics, or an authoring UI can prove a
stronger rule-equivalence contract than the explicit shared fixture used here.
