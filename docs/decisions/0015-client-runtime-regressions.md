# ADR 0015: Client runtime regression probes

- Status: Accepted design decision; implementation awaiting independent verification
- Date: 2026-09-16
- Brief sections: C2, C3.6/.19, C4, C5, C11 Phase 1, C12
- Decision owner: Cobitech Solutions

## Context

After PRs #12 and #13 merged, Bill approved continuing the compiler/runtime unit.
Claude note 36 requires nested counted repeats to be exercised in Collect and
Enketo before a C10.2 or C10.3 claim. ODK Validate checks parsing, not interactive
repeat counts or saved-instance reload. The earlier plan named Enketo Core 7.2.5
from its old repository's release list; current packages live in the Enketo
monorepo. Neither version is a deployed Kusanya server choice.

Initial builder probes exposed a saved-instance ID regression when an unguarded
UUID calculation was reloaded. They did not exercise the later-discovered Collect
path where changing a nested repeat count clears a namespace-qualified metadata
node. Real Collect v2026.3.4 evidence recorded as finding 60 supersedes this ADR's
earlier qualified-metadata choice: two otherwise identical forms showed an empty
qualified `instanceID` and a populated conventional unprefixed `instanceID` after
the same nested count change.

An earlier Enketo Transformer 4.2.0 builder probe rejected unprefixed metadata
below `<data xmlns="">` with `Invalid XML`; the corrected bytes have not been
rerun in Enketo, so that contradiction must be resolved before any Enketo-based
claim, and notes 36 and 37 remain open on the Enketo side.

## Decision

### Separate source checks, engine probes and actual Collect evidence

Keep ordinary service unit tests dependency-free beyond the existing service
toolchain. Add small synthetic fixture builders shared with optional local
engine probes. Source tests assert exact count references, labelled wrapper
bindings, once-only placement, author-note exclusion and deterministic bytes.
They explicitly claim source structure, not execution in either client.

Use Enketo Core **9.0.1** with Transformer **4.2.0** for the browser probe,
superseding ADR 0014's planned Core 7.2.5 target. Pin an isolated optional
`scripts/runtime` package and lockfile, including Playwright Core **1.63.0** and
esbuild **0.28.2**. Run its package tooling with portable Node **22.23.2**, within
the upstream Node range, without changing the service's Node 24 runtime. Use
npm's committed lock despite upstream's Yarn preference, with install lifecycle
scripts disabled. Resolve the exact upstream Leaflet.draw commit through a
hash-locked HTTPS archive, not SSH authentication. Use the
real browser transformer and full Core `Form`/widget implementation in an
installed headless Chromium browser, not a mock of repeat evaluation. Record the
actual browser version with each result.

Use **JavaRosa 6.0.0**, the dependency pinned by Collect **v2026.3.4**, for a
separate JVM traversal and saved-instance probe. Pin JavaRosa and its four-JAR
runtime set by hashes: JavaRosa 6.0.0, kxml2 2.3.0, Joda-Time 2.10.13 and
slf4j-api 1.7.33. Require explicit absolute Java and javac paths. The older
JavaRosa 5.1.0 bundled in ODK Validate remains a separate parsing check.

An engine probe is not Collect's Android UI, offline storage, navigation or
submission behavior. Bill has now supplied separate BlueStacks/Collect v2026.3.4
evidence for nested count context, count reduction and finding 60. That approval
does not authorize further device access, installation, upgrade or data deletion.

### Preserve repeat-context structure

Keep the existing relative references inside repeated scopes, absolute references
to root-scope values, and fixed-count helper nodes beside their repeats. Every
body repeat retains a labelled group whose `ref` equals the repeat's `nodeset`.

This is grounded in the engines, not an assumption about generic XPath:

- Enketo evaluates the count using a repeat comment at the repeat's depth, which
  exists even when the instance count is zero. Its own nested-relative regression
  exercises different counts in two outer instances.
- JavaRosa resolves a relative count against the enclosing body's group binding,
  then contextualizes ancestor repeat indices during traversal. The matching
  wrapper binding is therefore significant; removing it can change the meaning.

Do not switch blindly to absolute paths or `indexed-repeat()`. The former can
depend on legacy repeat qualification, and JavaRosa parses `jr:count` as a node
reference rather than an unrestricted expression. Test the existing structure
with zero counts, independent outer instances, nested fixed helpers and a count
in a sibling section. Include a deliberately wrong relative path as a negative
control.

### Conventional metadata and stable instance IDs

Emit the conventional unprefixed `<meta><instanceID/></meta>` block with bind
nodeset `/data/meta/instanceID`, matching XLSForm/pyxform output. Do not emit
`orx:meta` or `orx:instanceID`: Collect can clear that qualified value when a
nested counted repeat changes during entry, leaving a finalized submission without
its deduplication identity. The root may retain the declared `orx` namespace for
other OpenRosa vocabulary; declaration does not qualify these instance nodes.

Use `once(concat('uuid:', uuid()))` for this generated metadata calculation.
Compilation remains deterministic: the client creates the UUID when the value is
empty and preserves it on draft reload. This is an explicit defensive contract,
not a claim that removing `once()` alone reproduces the old defect in JavaRosa.
This generated expression does not add
`once()` to the portable author-expression allowlist. Require separate new
instances to have different IDs, unchanged draft instances to retain theirs and a
nested count change to leave the ID nonempty. This does not define a future
edit-of-finalized-submission protocol.

The [ODK metadata specification](https://getodk.github.io/xforms-spec/#metadata)
describes the conventional metadata block and warns about recalculation on draft load;
[`once()`](https://getodk.github.io/xforms-spec/#fn:once) preserves an existing
nonempty value.

### Observe count reduction without inventing a data-loss policy

Test count reductions after entering distinct synthetic answers, but report each
engine's behavior separately. Enketo's count implementation removes trailing
instances. Collect/JavaRosa can retain already-created instances, as described in
[ODK's count-reduction guidance](https://docs.getodk.org/form-logic/#hiding-extra-repeats-when-the-repeat-count-is-reduced).
The compiler warning is `DYNAMIC_REPEAT_CLIENT_SPECIFIC` and must not imply that
both clients behave identically. No silent cross-client trimming or hiding policy is added.
Publication/ingestion cardinality rules need a later reviewed decision before
exact-count acceptance tests can be claimed.

### Local, bounded and separate from credentialed verification

Use synthetic fixtures only. Do not copy production seed records, initialize
Salesforce authentication, create scratch orgs or contact the service. Optional
browser/JVM probes are local processes with explicit executables, bounded runs
and output under ignored `work/runtime-*` directories. Browser form execution
must not use the operator's browser profile, serve a public endpoint or make
external network requests. Dependency acquisition is a separate explicit step;
probes do not install tools automatically.

The browser runner blocks page requests and disables background networking in
its fresh test profile; this is not an OS network sandbox. Its upstream optional
npm dependencies have five known advisories (two high, three moderate), recorded
in the licence/runtime runbooks. Preserve the upstream versions for this narrow
synthetic regression, not as permission to process customer XML or deploy Enketo.
Production selection requires a separate security review and remediation plan.
The optional jquery-touchswipe 1.6.19 dependency offers MIT or GPL-2.0 in its
published LICENSE; select MIT and retain its notice. Its legacy metadata requires
a version-specific licence-inventory entry rather than guessing from the lockfile.

No CI workflow, harness pin, Salesforce metadata/namespace, permissions, PKCE,
connected app or package changes are authorized. Development/staging remain on
Cobitech and production remains Azure. The local test harness is not a deployment
or a form-delivery product. It introduces no collector Salesforce identity or
licence requirement.

## Alternatives considered

- Keep relying on validator success: cannot detect repeat traversal or reload
  defects demonstrated by the probes.
- Replace the count paths before running the engines: discards source evidence
  that the existing wrappers and relative references are intentional.
- Run only isolated XPath expressions: omits transformation, initialization,
  repeat creation and serialized-instance restoration.
- Add Enketo to service dependencies or deploy its server now: expands runtime,
  hosting and security scope before the client contract is verified.
- Treat JavaRosa as proof of Collect UI behavior: conflates a shared engine with
  its Android host; the device check remains required.

## Consequences and verification

The [runtime runbook](../runtime-validation.md) separates source evidence, engine
results and the outstanding device check. Both tracked engine runners passed
locally; have Claude reproduce them through the normal PR process. Record
negative controls and the count-reduction differences, not just pass totals.
Retain author-only exclusion through compilation; future delivery serializers
still need their own tests.

No C10 acceptance test is claimed. Collect evidence answers the Collect side of
note 36 and confirms note 37, while both remain open for the corrected Enketo
bytes. Salesforce adapters, publication, target validation, XLSForm round trip,
print view, CLI publish, Task integration and submission mapping remain outside
this unit. All normal CI approval and independent-verification rules continue to
apply; this ADR grants no additional scratch allocation.

## Revisit when

Selecting deployed client/server versions, changing repeat wrappers or count
expressions, changing metadata/draft identity behavior, handling count reduction
at publication/ingestion, extending browser support, or claiming C10.2/.3/.13.

## Primary implementation references

- [Enketo Core 9.0.1 count context](https://github.com/enketo/enketo/blob/79c5fc01d741abfd5a4bf33da491ae74916af149/packages/enketo-core/src/js/repeat.js#L402)
  and [nested-relative regression](https://github.com/enketo/enketo/blob/79c5fc01d741abfd5a4bf33da491ae74916af149/packages/enketo-core/test/spec/repeat.spec.js#L603).
- [Transformer 4.2.0 browser API](https://github.com/enketo/enketo/blob/0cdf70f3d61069550199cfb66ee7950c4a49972d/packages/enketo-transformer/README.md#web).
- [Collect v2026.3.4 dependency pin](https://github.com/getodk/collect/blob/e5783385f5ae375d8e252d7c3ea6e22f7596f1cf/gradle/libs.versions.toml#L67).
- [JavaRosa 6.0.0 relative count parsing](https://github.com/getodk/javarosa/blob/f8262bbd3f09b4ff4bef673d22c9df0876fb38d7/src/main/java/org/javarosa/xform/parse/XFormParser.java#L1685)
  and [contextualized traversal](https://github.com/getodk/javarosa/blob/f8262bbd3f09b4ff4bef673d22c9df0876fb38d7/src/main/java/org/javarosa/form/api/FormEntryModel.java#L431).
