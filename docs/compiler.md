# Portable XForm compiler

This is the bounded Phase 1 compiler, not the Phase 1 gate. It turns
an in-memory neutral definition into an XForm. It does not read Salesforce,
publish a form, serve an endpoint, run XPath or execute mappings. No C10 test is
claimed, including tests 10 and 12. Design decisions are in
[ADR 0014](decisions/0014-bounded-xform-compiler.md).

[ADR 0015](decisions/0015-client-runtime-regressions.md) adds optional real-engine
regressions and corrects metadata for client initialization/draft reload. See the
[runtime runbook](runtime-validation.md). Enketo/JavaRosa results are not an
actual Collect app result; note 36 remains open.

## API and quick check

`service/src/compiler/compile.ts` exports `compileForm(input: unknown)`.
`types.ts` defines the TypeScript contract. Results are discriminated by `ok`:

```typescript
type CompileResult =
  | {
      ok: true;
      validation: 'structural-only';
      xml: string;
      warnings: readonly Diagnostic[];
    }
  | { ok: false; diagnostics: readonly Diagnostic[] };
// Diagnostic = { code: string; location: string }
```

Expected validation failures return the first diagnostic and no partial XML.
Successful results explicitly say `validation: 'structural-only'`; callers must
not equate success with a publishable or runtime-verified form.
Locations identify input structure, such as `questions[2]`, never its supplied
name, label or contents. Unexpected implementation errors are not swallowed.
Warnings must be shown to the author and reviewed before future publication.

From `C:\Kusanya\codex\kusanya`, with the repository's Node 24 setup, run these
PowerShell commands. The single-quoted here-string avoids shell expansion and
does not write source files:

```powershell
npm.cmd --prefix service ci
npm.cmd --prefix service run build
@'
import { compileForm } from './service/dist/src/compiler/compile.js';
const result = compileForm({
  schemaVersion: 1,
  form: { key: 'synthetic_visit', title: 'Synthetic visit', version: 1 },
  questions: [{
    name: 'visit_time', order: 1, type: 'text', label: 'Visit time',
    hint: 'Use HH:MM', authorNotes: 'Reviewer-only instruction',
    regex: '^([01][0-9]|2[0-3]):[0-5][0-9]$',
    constraintMessage: 'Use a 24-hour time', required: true
  }],
  choiceLists: [],
  skipRules: []
});
if (!result.ok) {
  console.error(result.diagnostics);
  process.exitCode = 1;
} else {
  console.log(result.xml);
  console.error(result.warnings);
}
'@ | node --input-type=module
```

The hint appears in XML; Author Notes do not. This example demonstrates compilation
of a regex constraint, not execution in Collect or C10.12 equivalence.

## Input contract

The root contains exactly `schemaVersion: 1`, `form`, `questions`, `choiceLists`
and `skipRules`; arrays must be supplied even when empty. There must be at least
one question. The form has a portable `key`, nonblank `title` and positive integer
`version`. This is not a Salesforce export format or an XLSForm representation.

Questions identify their optional parent by question `name`, not an ID. Names
are unique across the whole form, at most 80 characters, and match
`[A-Za-z_][A-Za-z0-9_.-]*`. Names beginning with `xml` or `_ksny_` (case-insensitive)
and exact `data`, `meta`, `instanceID` are reserved. Parents must be sections or
repeats; cycles and missing parents fail. Positive integer Order is not unique:
ties sort by binary name. Label is required for visible controls except calculate.

Choice lists have a unique portable name and ordered choices with nonempty
labels/values. Values are at most 255 characters, unique within a list and contain
no whitespace. Select questions require a nonempty list; other types cannot name
one. Inline versus reusable Salesforce ownership belongs to the future adapter.

Unknown keys and wrong types fail instead of being ignored. Inputs are ordinary
JSON-shaped data: no proxies, getters, symbols, custom prototypes or sparse arrays.
There is no arbitrary source object serialization and no XML input parser.

## Supported rendering

| Definition                               | Generated representation                                      |
| ---------------------------------------- | ------------------------------------------------------------- |
| Section                                  | Nested instance nodes and group control                       |
| Repeat                                   | Template node and repeat control, according to the mode below |
| Text / text long / barcode               | String or barcode bind; multiline for text long               |
| Integer / decimal                        | Numeric bind; optional bounds and supported defaults          |
| Select one / multiple                    | Select control with stable inline item order                  |
| Date / time / datetime                   | Corresponding typed input                                     |
| Geopoint / geotrace / geoshape           | Corresponding typed input                                     |
| Photo / signature / audio / video / file | Binary upload with media type; signature appearance           |
| Calculate                                | Read-only string bind with calculation; no body control       |
| Reference                                | Read-only string input; no Task lookup or prefill retrieval   |
| Note                                     | Read-only collector-facing input; not Author Notes            |

Required, read-only, hidden, default, calculation, relevance, constraint, regex,
numeric minimum/maximum and constraint message are supported where meaningful.
Hidden removes the control, not the instance node; it is not confidentiality or
authorization. Required hidden/read-only/reference values need a nonempty default
or a calculation. Defaults cannot coexist with a calculation.

Generated record metadata uses `orx:meta/orx:instanceID` in the OpenRosa namespace,
not the unnamespaced question tree. Its qualified bind calculates
`once(concat('uuid:', uuid()))`: a client assigns a fresh ID to a new record and
retains a nonempty ID when reopening a draft. Compilation itself remains
deterministic. This does not define editing an already-submitted record, and does
not add `once()` to the authored-expression grammar.

Nonempty defaults are supported for text-like, numeric and select types. Numeric
defaults must satisfy authored bounds; select values must exist (multi-select uses
distinct space-separated tokens). Nonempty date/media/spatial defaults are not
yet supported. Containers cannot be empty or carry leaf-only validation/default
options. Notes cannot carry answers, defaults, calculations or constraints.

Only these explicit appearances are accepted: `multiline` for text long,
`signature` for signature, `minimal` for selects and `field-list` for a section
whose immediate children are non-containers. The separate `samePage` flag is not
implemented. Labels and hints are literal text, not markup.

`authorNotes` and `regexExample` are author-only: neither enters XML or diagnostic
values. All future collector delivery must continue using an explicit allowlist,
not serialize the neutral input directly (Claude note 27).

## Repeat modes and reference scope

- `fixed`: `repeatCount` is a whole value from 1 through 1,000. The compiler emits
  a read-only sibling helper and a count-bound repeat with add/remove disabled.
  An optional `repeatMax` cannot be below the fixed count.
- `from_answer`: `repeatSourceQuestion` names an integer in scalar scope, outside
  the repeat's subtree. The source gains a constraint from 0 through `repeatMax`,
  defaulting to 1,000; explicit maxima above 1,000 and contradictory source
  defaults/bounds fail. No fixed count is accepted in this mode.
- `open`: no count/source/max is accepted. The client controls repeat instances;
  this unit does not implement an open-repeat maximum.

A source inside its own counted repeat is rejected, including through nested
sections (note 28). Root and enclosing-repeat values can be read from descendants;
same-repeat references retain the current instance using relative paths. Sibling
or deeper-repeat values cannot be used as scalars. There is no aggregation or
implicit first-instance selection. A once-only question remains outside the
repeat; referencing it does not duplicate it.

Every answer-driven repeat returns warning `DYNAMIC_REPEAT_RETAINS_INSTANCES`.
Reducing the count does not delete prior instances in native ODK behavior. No
automatic trimming, extra-instance hiding or server-side exact-count check is
implemented here. Keep this warning visible; do not claim C10.2 or C10.3 from
`jr:count` alone. See [ODK's count-reduction guidance](https://docs.getodk.org/form-logic/#hiding-extra-repeats-when-the-repeat-count-is-reduced).

This warning describes ODK/JavaRosa, not equivalent behavior in every client:
the Enketo 9.0.1 probe removes trailing **answered** instances when their count
decreases. A future publication/ingestion policy must address this data-loss and
cardinality difference; the compiler is not publish-ready.

For Claude note 36, the optional engine probes exercise nested `../member_count`
and `../_ksny_count_checks`, section-crossing `../../settings/member_limit`, and
root-absolute counts. The existing paths are retained. Each repeat's labelled
wrapper has `ref` equal to its `nodeset`; JavaRosa's relative count resolution
depends on that context. Tests cover separate outer instances, zero counts,
draft reload and intentionally incorrect paths. **Actual Collect app execution
is still outstanding**, so these results do not close note 36 or claim C10.2/.3.

## Expression grammar

Calculation, relevance and constraint use a parsed subset, not arbitrary XPath.
Question references may be `${question_name}`, `.`, `/data/section/question`,
`./child` or one or more `../` segments followed by a path. Every path must resolve
to a known answerable node and pass repeat-scope checks. Bare names are not
question references. Sections, repeats and notes are not answerable sources.

Literals are single- or double-quoted strings and decimal numbers (no exponent
notation). XPath has no backslash string escapes; use the other quote delimiter
or `concat` when needed. Parentheses and unary minus are supported. Binary
operators, from low to high precedence, are:

1. `or`
2. `and`
3. `=`, `!=`
4. `<`, `<=`, `>`, `>=`
5. `+`, `-`
6. `*`, `div`, `mod`

Supported functions and argument counts are:

| Functions                                                                                                      | Arguments                                          |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `true`, `false`, `today`, `now`                                                                                | 0                                                  |
| `not`, `boolean`, `string`, `number`, `string-length`, `date`, `decimal-date-time`                             | 1                                                  |
| `normalize-space`                                                                                              | 0 or 1; omitted argument becomes the current node  |
| `selected`, `regex`, `contains`, `starts-with`, `ends-with`, `substring-before`, `substring-after`, `coalesce` | 2                                                  |
| `substr`                                                                                                       | 2 or 3; ODK's zero-based function, not `substring` |
| `round`                                                                                                        | 1 or 2                                             |
| `if`                                                                                                           | 3                                                  |
| `concat`                                                                                                       | 1 or more, within the token limit                  |

Everything else fails explicitly, including `instance()`, predicates, unions,
arbitrary axes, namespaces/extensions, JavaScript and collection aggregation.
Expressions are compiled, not run. Regex strings are quoted into constraints,
not executed or fully validated by Node. Runtime type correctness and evaluation
behavior still require artifact validation and client tests.

Calculation, relevance, skip and count dependencies are checked for cycles,
including inheritance from parent relevance/counts. Self-referential calculation
or relevance is rejected; self-value constraints are allowed. This is a
conservative subset of the [ODK expression specification](https://getodk.github.io/xforms-spec/#xpath-functions),
not full XPath support.

## Skip rule contract

All rules for one target must share `join` (`all`/`any`) and `action`
(`show`/`hide`). Conditions combine with AND/OR, then hide negates the whole
combined condition. Authored relevance is ANDed with the generated result.
Rules cannot source themselves, sections, repeats or notes.

| Operator                    | Source and operand contract                                                   |
| --------------------------- | ----------------------------------------------------------------------------- |
| `answered`                  | Any answerable source; no Value or Value To                                   |
| `is`, `is_not`              | Text-like, numeric or select-one; one nonempty Value; select value must exist |
| `less_than`, `greater_than` | Integer/decimal; one numeric Value                                            |
| `in_range`                  | Integer/decimal; inclusive Value to Value To, lower not above upper           |
| `contains`                  | Text-like substring or select-multiple token membership; one nonempty Value   |

All comparisons other than `answered` additionally require a nonempty source.
Consequently a blank value does not satisfy `is_not`. For hide rules, a false
condition leaves the target visible. Multi-select membership uses `selected`, so
`a` does not match choice `aa`. Operands are quoted as data, never parsed as code.
Numeric range comparisons preserve the supplied decimal spelling and compare
bounds without floating-point rounding.

## Limits and unsupported options

| Resource                                              | Initial limit                                                  |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| Questions / choice lists / total choices / skip rules | 500 / 500 / 5,000 / 2,000                                      |
| Question ancestors                                    | 32                                                             |
| Form/question/list identifiers                        | 80 characters                                                  |
| Most text fields / accumulated input strings          | 32,768 / 1,000,000 UTF-16 code units                           |
| Choice values and skip operands                       | 255 code units                                                 |
| Expression source / tokens / parser nesting           | 4,096 code units / 512 / 32                                    |
| Compiled expression                                   | 32,768 code units                                              |
| Expanded XML                                          | Conservative 2,000,000-unit preflight, plus final length check |
| Fixed/from-answer repeat ceiling                      | 1,000                                                          |

Integer defaults and bounds are signed 32-bit: -2,147,483,648 through
2,147,483,647. Numeric defaults, numeric bounds and numeric skip operands accept
plain decimal notation with up to 12 integer and six fractional digits. Numeric
range ordering uses scaled integers. These checks do not turn arbitrary XPath
arithmetic or client decimal values into a fixed-precision service.

Configured `end`, `validationScript`, `prefillSource`, `samePage`,
`repeatAsTable`, `cascadeLevel`, `requireLivePhoto`, `mediaMaxSeconds`, nonempty
choice Filter Value and defined Score fail explicitly. Unsupported appearances,
defaults and open-repeat limits also fail. Omitted/false options retain their
default meaning; author-only Notes/Regex Example are intentionally omitted, not
unimplemented collector behavior. No translation, external itemset, mapping
execution, Salesforce target validation, form snapshot or publication is present.

## Verification and optional offline ODK probe

Normal service tests exercise synthetic compiler definitions only:

```powershell
npm.cmd --prefix service test
npm.cmd --prefix service run lint
npm.cmd --prefix service run typecheck
```

The optional probe uses the official
[ODK Validate v1.20.0 asset](https://github.com/getodk/validate/releases/tag/v1.20.0),
whose release build uses JavaRosa 5.1.0. Download only into ignored `work/`.
From the repository root:

```powershell
New-Item -ItemType Directory -Force -Path work/odk-validate
gh release download v1.20.0 --repo getodk/validate --pattern ODK-Validate-v1.20.0.jar --dir work/odk-validate
Get-FileHash work/odk-validate/ODK-Validate-v1.20.0.jar -Algorithm SHA256
npm.cmd --prefix service run build
node scripts/check-compiler-odk.mjs work/odk-validate/ODK-Validate-v1.20.0.jar 'C:\Program Files\Zulu\zulu-21\bin\java.exe'
```

Use your actual absolute Java 21 executable path; the script refuses a relative
Java path. Expected SHA-256 is
`92756ea4aed195355a07e5572f025f0921a31282387a870ae63e1f5cdf37e0c3`.
The script verifies this digest before executing the JAR. Do not bypass the hash
check or substitute an unreviewed artifact. An already-downloaded matching JAR
can be reused; the probe itself requires no network or Salesforce authentication.

It compiles the synthetic `mixed`, `nested`, `scalars` and `quoted` fixtures,
requires all four to validate, then requires malformed `<not-an-xform/>` and an
unsupported XPath function in otherwise well-formed XML to fail. Each Java
process has a 256 MiB heap limit, 60-second timeout and 1 MiB captured-output limit.
The process gets a reduced environment, not inherited Salesforce/GitHub secret
variables. Generated XML and logs remain in a new ignored `work/compiler-odk-*`
directory. No JAR or generated probe artifact belongs in the source tree.

Validator success only establishes acceptance of those generated definitions by
that pinned validator. It does not exercise Collect/Enketo UI, runtime edits,
device features, authorization, submissions or C10. ADR 0015 supersedes the
earlier planned Enketo Core 7.2.5 target with Core 9.0.1 and Transformer 4.2.0
for an isolated browser-engine probe. A separate JavaRosa 6.0.0 probe uses the
engine pinned by [Collect v2026.3.4](https://github.com/getodk/collect/releases/tag/v2026.3.4),
without claiming Android app execution. Results and limitations are in the
runtime runbook. Enketo server selection and a fresh security/dependency review
remain required before deployment; the optional tooling has known upstream
dependency advisories. No container, CI, scratch-org or hosting change is included.
