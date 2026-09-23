# ADR 0016: Reviewer-only print view

- Status: Accepted; renderer verified in PR #16, delivery requirements remain open
- Date: 2026-09-16
- Brief sections: C2, C3.14/.19, C4 mapping annotations, C5 print view, C11 Phase 1, C13 tooling isolation
- Decision owner: Cobitech Solutions

## Context

Reviewers need a printable definition that connects each question's labels,
choices and compiled logic with its supplied mapping configuration. Author Notes
and regex examples belong in that review, but must remain absent from collector
XForm XML. The compiler already validates a bounded definition and prepares the
expressions and repeat contexts used by its XML renderer. Reimplementing that
logic for a preview would risk showing reviewers different semantics.

Claude note 38 also requests a regression tripwire keeping optional client probes
out of normal root/service dependencies and execution paths. Notes 36 and 37
remain open: this print unit does not supply actual Collect UI evidence or resolve
the client-specific count-reduction and publication/ingestion policy.

## Decision

### Pure renderer sharing compiler preparation

Add `renderPrintView(formInput, mappingInput)` as a pure in-process function in
`service/src/print/render.ts`. Both inputs are required snapshots. Success returns
HTML, warnings, `audience: 'reviewer-only'` and `validation: 'structural-only'`;
failure returns structural diagnostics without partial HTML. It performs no I/O,
authentication, publication, mapping execution or runtime expression evaluation.
No HTTP endpoint or Salesforce adapter is added.

Extract the compiler's existing preparation into the internal `prepareForm`
function. Both renderers consume its graph, compiled relevance, constraints,
calculations, counts and warnings. The internal graph contains author-only data
and must never become a collector response. `compileForm` keeps its public result
contract and explicit collector XML allowlist. XML bytes and existing fixture
hashes must remain unchanged by this refactor.

Print questions in stable tree preorder, sorting siblings by Order then binary
name. Choices retain Order/value ordering. Mapping summaries sort by Order/key,
and field assignments by target name. Equivalent input record reorderings produce
the same HTML, without mutating either input. Display inherited relevance with
the ancestor path and its original evaluation context; do not rewrite a parent's
relative expression as though it were evaluated on the child.

Show hidden and calculated questions as reviewable definitions. Keep Collector
Hint separate from visibly marked Author Notes and `regexExample`. The latter is
an annotation, not a regex test. The print header includes the SHA-256 of the
ordinary compiler XML, for byte identity only, not a signature or approval.

The print renderer retains the compiler's unsupported-input rejection and XML
output limits. There is no permissive preview for forms the compiler rejects.
The `DYNAMIC_REPEAT_CLIENT_SPECIFIC` warning gains explanatory print
text: JavaRosa retains instances while the Enketo probe removes trailing answered
rows. This does not assert equivalent final counts or data retention, close notes
36/37, or implement a publication/ingestion rule.

### Supplied mapping summaries, not write instructions

Use an explicit versioned mapping bundle with an explicit empty-list option.
Represent all C4 configuration categories: mapping kind and order, target object,
repeat source, record type, parent mapping and lookup field, reference matching,
external-ID upsert field, collector/submission stamps, question or constant field
sources, and the C4 transform names. Preserve every assignment when one question
feeds several mappings. Show null, empty-string, whitespace, `"0"` and `"false"`
constants distinctly rather than collapsing them through truthiness.

Validate only the summary's bounded shape, lexical names, known answerable
question/repeat references, paired parent references, duplicates and parent
cycles. Do not accept saved match-status flags as evidence. The accepted lexical
spelling `Account__r` does not prove a valid target object, relationship or field.
No Describe, CRUD/FLS, target existence/type, record-type, picklist, answer-scope
or transform-compatibility validation is claimed. Preserve customer and foreign
namespace spelling; the Salesforce project namespace remains empty.

### Static, bounded HTML

Escape all supplied text. Labels cannot provide HTML, CSS, links or resource URLs.
All links are generated local `q-N` or `m-N` anchors. Use fixed CSS with an exact
SHA-256 style hash in an early meta CSP; deny scripts, default resource fetching,
base URLs, forms and objects. The renderer emits no interactive form or external
resources. Meta CSP does not authenticate a reviewer or provide framing
protection; `frame-ancestors` is unsupported in a meta policy. Any future hosted
delivery needs its own authorization and response-header design.
[W3C CSP meta delivery](https://www.w3.org/TR/CSP3/#meta-element)

Use ordinary browser printing with static `@media print` and `@page` rules,
including wrapping, table headers and page-break hints. A browser's final
pagination still needs visual inspection.
[MDN printing guidance](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Media_queries/Printing)

Retain the compiler input limits, separately bound mappings to 100 entries,
2,000 field assignments and 500,000 accumulated string code units, and cap HTML
at 4,000,000 code units. Reject executable objects, unsupported properties,
malformed text and oversized output with structural diagnostics.

### Optional probe isolation tripwire

Add only `scripts/runtime-isolation.test.mjs` to the root test suite already
discovered by the unchanged root command and CI. It inspects the runtime package's
direct dependency inventory against root/service manifests and locks, including
aliases, local links and workspace globs. It also checks literal lifecycle,
build/test and workflow paths, root test discovery, service container copy/context
boundaries, and host-artifact exclusions. Positive controls and isolated
in-memory mutations exercise those checks without installs or probe execution.

This is a source regression tripwire, not a security boundary. It does not follow
arbitrary imports or shell evaluation, prohibit all shared transitive libraries,
or sandbox execution. Conservative command and Docker source checks may flag a
safe future change; review and update the checked patterns with matching controls
rather than interpreting a failure as proof of compromise. No manifest, lockfile,
workflow, harness, immutable pin or Salesforce metadata changes accompany it.

## Consequences and verification

Claude note 39 is a requirement for the first delivery unit, not implemented by
the renderer: `audience: 'reviewer-only'` must gate delivery. Require reviewer
authorization, never a collector/public route; send `Cache-Control: no-store`
with no shared cache, CSP as an actual response header, and
`X-Content-Type-Options: nosniff`. Test that a collector-scoped principal cannot
fetch the reviewer document. A label or meta CSP is not an authorization boundary.
This follow-up does not close note 39 or add a route.

The [print-view runbook](../print-view.md) defines API use, synthetic local export,
test commands and the builder evidence record. Existing dependencies suffice.
The exporter writes synthetic HTML, input snapshots and hashes into a unique
ignored work directory. Optional browser inspection uses an already installed
browser and authorizes no Enketo/Collect installation or device setup.

The reviewer view contains author-only information and is unsuitable for
collector distribution. Publication, CLI publish, live Salesforce reads/writes,
Task integration, XLSForm round trips and complete C10/Phase 1 acceptance remain
separate work. Neither a rendered document nor a passing source tripwire closes
those gates. Independent verification remains required.

## Revisit when

Adding hosted reviewer delivery, changing collector serialization, accepting new
compiler options or mapping semantics, changing print/browser support, changing
normal package or container commands, or closing the outstanding runtime and
publication/cardinality decisions.
