# Reviewer-only print view

This is a printable review of a supplied form definition and mapping snapshot.
It includes author annotations, hidden questions and compiled logic. It does not
collect answers, read Salesforce, execute mappings or approve publication.
[ADR 0016](decisions/0016-reviewer-print-view.md) records the decision.

## API and output

Import `renderPrintView` from `service/src/print/render.ts` in TypeScript, or
`service/dist/src/print/render.js` after building. Both arguments are required:

```ts
const result = renderPrintView(formInput, {
  schemaVersion: 1,
  mappings: [],
});

if (result.ok) {
  // result.html is reviewer-only; never send it as a collector form.
  // result.audience === 'reviewer-only'
  // result.validation === 'structural-only'
  // result.warnings contains the compiler's structural warnings.
} else {
  // result.diagnostics has structural codes/locations; there is no partial HTML.
}
```

`formInput` uses the existing [compiler contract](compiler.md). The mapping
argument must be an explicit schema-version-1 bundle, even when its array is
empty. This pure function performs no I/O and mutates neither input. No endpoint,
authorization contract or Salesforce adapter exposes it in this unit.

Compiler preparation is shared with `compileForm`. Unsupported expressions,
question options, malformed graphs and oversized XML still fail; print is not an
alternate path around compiler rejection. The public compiler result contract,
collector XML rendering and expected fixture hashes remain unchanged. Its
internal prepared graph carries author-only data and must not be serialized as a
collector response.

## Reading the document

The header identifies the form key, title, version and question/mapping counts.
Its compiled-XForm SHA-256 is computed from the same XML as `compileForm`. It
identifies bytes, not publication status or a digital signature.

Questions follow tree preorder: parent before children, with siblings ordered by
positive Order then binary name. Choices sort by Order then stored value.
Equivalent input record reordering preserves HTML bytes. Each question shows its
name/type, label, instance path, parent, repeat placement, Collector Hint,
required/read-only/control-omission status, default and supported appearance.
Hidden and calculate questions remain visible to reviewers.

The displayed local relevance, constraint, calculation and `jr:count` are the
prepared expressions used by the compiler. Generated numeric/regex constraints
and skip-rule conditions therefore remain visible. A parent's relevance appears
separately with that parent's path and evaluation context: a child with no local
condition can still inherit a parent's condition. No XPath or regex is evaluated
by the print renderer. Required/count behavior is described, not simulated.

Author Notes and `regexExample` appear in a separate author-only block, never as
Collector Hint. The ordinary collector XML, compiler diagnostics and warnings
continue excluding those annotation values. A visible `note` question remains
collector content; it is distinct from Author Notes. Do not distribute reviewer
HTML to collectors or respondents.

Answer-driven repeats retain the compiler warning code
`DYNAMIC_REPEAT_RETAINS_INSTANCES`. The print explanation states the observed
client difference: JavaRosa retains existing instances; the Enketo probe removes
trailing answered rows. It makes no promise of equivalent final counts or data
retention. Notes 36 and 37 remain open for actual Collect UI evidence and the
publication/ingestion cardinality decision. This unit claims no C10 acceptance
test, CLI publish capability or completed Phase 1 gate.

## Mapping snapshot

The mapping summary represents supplied configuration only. Every question-to-field
assignment is shown, including one question used by several mappings. Summaries
sort by Order then key; field rows sort by case-insensitive target field with
binary spelling as a tie-breaker.

| Supplied field                                     | Review meaning                                                                   |
| -------------------------------------------------- | -------------------------------------------------------------------------------- |
| `key`, optional `label`, `order`                   | Stable local identity, label and positive integral ordering.                     |
| `kind`                                             | `main`, `repeat` or `reference`.                                                 |
| `targetObject`                                     | Supplied target API-name spelling.                                               |
| `repeatQuestion`                                   | Required for `repeat`; must identify a repeat question.                          |
| `recordType`                                       | Optional record type DeveloperName; no lookup or validation against Salesforce.  |
| `parentMapping`, `parentLookupField`               | Paired parent link; referenced mapping must exist and the chain must be acyclic. |
| `matchingField`                                    | Required for `reference`, absent for other kinds.                                |
| `upsertExternalIdField`                            | Supplied upsert field; no external-ID or uniqueness proof.                       |
| `collectorField`, `submissionField`                | Supplied stamp fields; neither stamp is executed.                                |
| `fields[].targetField`                             | Target field; case-insensitive duplicates within one mapping are rejected.       |
| `fields[].sourceKind: 'question'`, `question`      | Known answerable question; no simultaneous `constantValue`.                      |
| `fields[].sourceKind: 'constant'`, `constantValue` | Explicit string or null; no simultaneous `question`.                             |
| `fields[].transform`                               | Optional named transform, shown without execution.                               |

The accepted C4 transform names are `none`, `picklist_match`,
`multi_select_join`, `lookup_by_external_id`, `date_only`, `boolean_yes_no`,
`number`, `text_truncate`, `geopoint_lat`, `geopoint_lng`, `geopoint_accuracy`
and `file_url`. A missing transform is displayed as `none`; this is a review
presentation, not execution/defaulting of a mapping pipeline.

Constants preserve supplied spelling. Null is labelled a blank constant, `""`
an empty-string constant, while whitespace, `"0"` and `"false"` remain literal
strings. JavaScript numeric/boolean constants are not part of this snapshot
contract. Explicit source discrimination avoids silently treating falsy values
as absent sources.

This is an in-memory snapshot contract, not a Salesforce storage round trip.
Salesforce trims persisted text as recorded in ADR 0013; a future reader must
supply the actual stored value. Showing a supplied empty or whitespace string
does not claim it survives Salesforce field normalization.

Target names follow the existing lexical contract: standard, customer and foreign
namespace spellings remain intact, and `Account__r` is lexically accepted. That
does not establish an object, relationship or field through Describe. The
Salesforce project namespace remains empty; the renderer adds no owned prefix.

The decoder checks shape, lexical names, references, duplicates and parent
cycles. It does not validate schema existence, CRUD/FLS, field types, record
types, picklist matches, mapping answer scopes, transform compatibility or actual
record writes. Saved match-status flags and other unknown properties are refused.
A supplied summary is never proof of publication eligibility.

## Escaping, browser behavior and limits

Every supplied string is escaped as text. Authored labels cannot create HTML,
scripts, styles, images or links. Local anchors are generated from fixed numeric
question/mapping indexes, not authored URLs. The only CSS is the fixed style
block. An early meta Content Security Policy permits that block's exact SHA-256
hash and denies scripts, default resource fetching, base URLs, forms and objects.
There is no `unsafe-inline` allowance or external stylesheet/font request.

Meta CSP is a browser defense for this document, not server authentication,
tenant authorization or an operating-system network sandbox. It does not supply
frame protection: meta policies do not support `frame-ancestors`. A future hosted
route needs a separate delivery design. The policy precedes styles and body
content because meta policy cannot protect content processed earlier.
[W3C CSP meta delivery](https://www.w3.org/TR/CSP3/#meta-element)

Static `@media print` rules adapt screen content for printing, and `@page` requests
A4 with 15 mm margins. The CSS includes text wrapping, repeating table headers
and page-break hints. Browser pagination and print settings can differ; inspect
the actual browser output before treating it as print QA.
[MDN printing guidance](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Media_queries/Printing)

| Bound                                       | Initial limit                                                   |
| ------------------------------------------- | --------------------------------------------------------------- |
| Form questions / ancestor depth             | 500 / 32                                                        |
| Choice lists / total choices / skip rules   | 500 / 5,000 / 2,000                                             |
| Accumulated form string code units          | 1,000,000                                                       |
| Mapping summaries / total field assignments | 100 / 2,000                                                     |
| Mapping keys and question references        | 80 code units each                                              |
| Mapping labels and target API tokens        | 255 code units each                                             |
| Constant strings                            | 32,768 code units each                                          |
| Accumulated mapping string code units       | 500,000, including enumeration values                           |
| Compiler XML                                | Existing preflight estimate and final 2,000,000 code-unit limit |
| Reviewer HTML                               | 4,000,000 code units, including escaping expansion              |

These are implementation limits, not Salesforce/client limits. Normal compiler
text/name/expression restrictions still apply. The decoders reject proxies,
accessors, exotic prototypes, symbols, sparse/extended arrays, unknown fields and
malformed text. Mapping order is a positive safe integer no greater than
1,000,000,000,000. Structural diagnostics avoid echoing supplied values; unexpected
programmer errors still throw. There is no partial preview on validation failure.

## Local synthetic export

From the repository root with the existing Node 24 toolchain and dependencies:

```powershell
npm.cmd --prefix service run build
node scripts/export-print-fixture.mjs
```

The exporter uses `reviewerFixture()` and `largeReviewerFixture()` from
`service/test/fixtures/print.ts`. It creates a unique ignored work directory
containing synthetic HTML, the supplied input snapshots and a hash manifest. It
uses no external tools, installation, production data, org authentication or
network request. Use the paths printed by the command to inspect the artifacts;
rerunning creates a separate directory.

The small fixture includes once-only fields, answer-driven and fixed repeats,
choices, a skip condition, regex guidance, author annotations, repeated mapping
assignments and explicit constants. The large fixture has 144 synthetic question
nodes for layout/ordering inspection. It is not the real acceptance fixture.

Optional visual QA may open these local HTML files in an already installed
browser and use its Print command. Inspect first/last questions, long text,
choice/field tables, annotations, inherited context and page boundaries. Record
browser version, artifact hashes and the settings used. No browser, Enketo,
Collect, Java or device installation is authorized or required by these commands.
Browser inspection is separate from source-test evidence.

## Verification and note 38

After building, the focused source checks are:

```powershell
node --test service/dist/test/unit/print-render.test.js service/dist/test/unit/print-mappings.test.js
node --test scripts/runtime-isolation.test.mjs
```

`print-render.test.ts` covers prepared logic/context, author-only exclusion,
ordinary XML hash identity, deterministic ordering, no input mutation, mapping
visibility, escaped text, generated anchors, CSP/style hashing, unsupported input
and HTML expansion limits. `print-mappings.test.ts` covers C4 fields/transforms,
explicit constants, references/cycles, lexical names, hostile structures and
resource limits. The ordinary compiler suite must still pass after the shared
preparation refactor; existing runtime fixture hashes remain the reference:

- `nested.xml`: `2c3d69141face5e0acae2a637e7024ae61a6b37c8a0db65b38fdd62af6bcc652`
- `section.xml`: `f4fd514a1aa9737e131c6261598cbce960bf7352c1a6e24209dec207bc1d1117`

The root note-38 test checks actual root/service manifests and lockfiles against
the optional probe package and its direct dependencies. Its cases include npm
aliases, file/link/workspace references, workspace globs, install/build/test
scripts, literal workflow paths, root/CI test discovery, Docker copy/context
boundaries and host-artifact exclusions. It uses a positive repository baseline,
a benign control and isolated in-memory mutations. It does not run npm installs
or optional probes.

This is a source tripwire, not a security boundary. It does not follow arbitrary
shell evaluation/import graphs or ban shared transitive libraries. Exact command
and copy-source checks can flag safe future changes; review those changes and
update the tripwire's controls deliberately. The test is discovered by existing
commands, without root/service manifest or lock changes, CI/workflow changes,
harness changes, pin changes or Salesforce metadata changes.

### Builder evidence, 2026-09-16

Executed from the builder checkout; these are local results, not Claude's verdict:

```powershell
node --test scripts/*.test.mjs
& 'C:\Program Files\Git\bin\bash.exe' --noprofile --norc -c 'node --test scripts/*.test.mjs'
npm.cmd --prefix service test
npm.cmd --prefix service run lint
npm.cmd --prefix service run typecheck
node scripts/export-print-fixture.mjs
node scripts/check-compiler-odk.mjs work/odk-validate/ODK-Validate-v1.20.0.jar 'C:\Program Files\Zulu\zulu-21\bin\java.exe'
```

- Root: 252/252 in PowerShell and Git Bash, including 85 isolation-tripwire cases.
- Service: 112/112, with lint and typecheck passing. Four pre-refactor compiler
  fixture XML hashes remain exact; the runtime fixture hashes above also pass.
- ODK Validate 1.20.0: four valid fixtures accepted, two negative controls rejected.
  The already downloaded validator's expected SHA-256 was checked before use.
- Export: `work/print-view-LwcKeP/manifest.json`. SHA-256:
  `review.html` = `448513eff69b87771b5278800099a5d01198865e3dec4d6293e2cd1289b5615a`;
  `large.html` = `9e5902ad543d93f20b813eeb8ff536dd056a55a21e71a3e0532938903875a93f`.
- Installed Chrome 153.0.8010.47: both 11-node and 144-node synthetic documents
  checked at desktop, 375 px narrow-screen and print-media widths. No horizontal
  clipping or active/fetchable authored elements; hostile markup remained text;
  altered CSS without a matching CSP hash was blocked. The isolated temporary
  browser profile recorded zero fixture resource requests. No package was installed;
  the builder used already-present Playwright Core only, not the Enketo probe.
- The small fixture's A4/15 mm PDF was rendered to nine page images using Windows'
  built-in PDF renderer (no additional installation). Every page was inspected for
  clipping, table wrapping, author annotations and pagination. Local QA artifacts:
  `work/print-view-qa-DW5w81/`, including `report.json`, `review.pdf` and `pages/`.
  PDF SHA-256: `7a0eb198ff69273bf5a25f47f6a978c82f3f885a512a889c9551c2e41d37cd6d`.
  PDF bytes include browser-generated metadata and are not the deterministic API
  contract; HTML is. The 144-node fixture received DOM/layout checks, not a complete
  page-by-page PDF inspection.

The ignored artifact paths are builder-local evidence, not committed inputs or
portable verifier dependencies; rerun the exporter and browser checks independently.
No Salesforce org was created, no optional Enketo install was performed, and no
Collect/device test, container test or C10 acceptance result is claimed here.
Hosted CI and Claude's independent review remain separate pending evidence.
