# Authoring interchange

This unit provides a lossless **supported-authoring snapshot**, a
consistency-checked XLSForm-style table profile and a strict binary `.xlsx` adapter.
It does not import arbitrary edited workbooks, read/write Salesforce or publish
forms. No C10 acceptance test is claimed. See
[ADR 0017](decisions/0017-authoring-interchange.md) and
[ADR 0018](decisions/0018-strict-xlsx-adapter.md).

## JSON bundle API

After building the service, import from `service/dist/src/interchange/bundle.js`:

```js
import {
  exportAuthoringBundle,
  importAuthoringBundle,
} from './service/dist/src/interchange/bundle.js';

const exported = exportAuthoringBundle(formInput, mappingInput);
if (exported.ok) {
  const restored = importAuthoringBundle(exported.json);
  // Success includes bundle, canonical json, warnings,
  // audience: 'authoring-only', validation: 'structural-only'.
  // No I/O or Salesforce change has happened.
}
```

The source imports use the corresponding `.ts` files. Both export inputs are
required: the existing [compiler definition](compiler.md) and an explicit
[mapping snapshot](print-view.md#mapping-snapshot), including an empty mapping
list when appropriate. The envelope is exactly:

```text
{
  schemaVersion: 1,
  kind: 'kusanya-authoring',
  definition: FormDefinition,
  mappings: PrintMappingBundle
}
```

The importer takes JSON **text**, not a file path, URL or arbitrary object. Both
APIs validate using the existing compiler and mapping checks, including the full
XML length gate. On expected failure they return `ok: false` and diagnostics only,
never partial output. An `ok: true` result is not permission, schema, publication
or runtime validation.

Only the current compiler-supported definition is represented: form key/title/
version, questions, choice lists and skip rules, plus supplied mappings. Other C4
Form metadata, version lifecycle, Previous Version Question links, folders, Files,
match-status records and Tasks are not part of this format. Unknown fields are
rejected rather than dropped. Customer object/field names retain their exact
spelling; no Salesforce namespace or org identity is inferred.

## Canonical form and losslessness

Object keys use deterministic binary ordering. Questions follow tree preorder
and retain their explicit Order values; choices use Order/value ordering; choice
lists use name order. Skip rules sort by complete canonical record value. Mapping
records use Order/key, and fields sort by case-folded target name with exact
spelling as a tie-breaker. Equivalent record reorderings therefore export the same
JSON. This does not preserve the physical order of input arrays when it is not
semantic.

Authored expressions, skip rules, unused choice lists, whitespace and Unicode
spelling survive. Author Notes and regex examples remain separate from Collector
Hint. Explicit false, empty strings, null constants and string `"0"`/`"false"`
remain distinct. Numeric `-0` canonicalizes to `0`; authored string `"-0"` is not
changed. Numeric strings are not coerced into numbers. Returned data is detached
from the inputs; neither input is mutated.

JSON numeric tokens must retain their exact decimal value when converted to the
canonical JavaScript-number spelling. Equivalent notation such as `1.00e0` is
accepted, but nonzero underflow and silent decimal rounding are rejected before
compiler validation. This does not add arbitrary-precision arithmetic: normal
compiler number limits still apply, and the object API receives already-created
JavaScript numbers. JSON text is strict (no comments, trailing commas or leading BOM).

Successful warnings are recomputed against the canonical definition, so their
question indices refer to the returned bundle. They are not indices into the
caller's original record order. Unsupported compiler options still fail; there
is no relaxed interchange-only compilation path.

The JSON parser refuses duplicate decoded keys (including escaped spellings),
malformed JSON and prototype-related keys. The object exporter refuses executable
or lossy shapes such as getters, proxies, symbols, unsupported prototypes, cycles,
undefined, nonfinite numbers, sparse arrays and array extensions. No caller
`toJSON` or iterator is invoked. Failure messages contain structural locations
and codes, never supplied labels, annotations or JSON excerpts.

## XLSForm table profile API

Import `exportXlsFormTables` and `importXlsFormTables` from
`service/dist/src/interchange/xlsform-tables.js` after building:

```js
const exported = exportXlsFormTables(formInput, mappingInput);
if (exported.ok) {
  const restored = importXlsFormTables(exported.tables);
  // restored has the same result contract as importAuthoringBundle.
}
```

The versioned profile contains exactly four tables of literal-string cells:

```text
{
  schemaVersion: 1,
  kind: 'kusanya-xlsform-profile',
  sheets: { survey, choices, settings, kusanya_source }
}
```

Each table begins with an exact header row. `survey` projects questions and
balanced group/repeat boundaries, with compiled relevance, constraint and
calculation text. `choices` projects ordered lists. `settings` supplies the form
identity, version, root name and whitespace policy. Column names and common type
spellings follow the [XLSForm reference](https://xlsform.org/en/).

`kusanya_source` has columns `index` and `json`. Its contiguous, one-based indexed
chunks preserve the complete canonical bundle, including mappings and author
annotations that cannot be reconstructed from the visible projection. Chunks are
at most 30,000 UTF-16 units and never split a surrogate pair. They are not executable
spreadsheet formulas. No hidden-sheet property or confidentiality is implied.

Import validates the source and regenerates **all** sheets, then compares every
row/cell. Changing only a label, constraint, count, choice, header or source chunk
is not silently ignored. Contradictions fail with structural diagnostics. To edit,
change the authoring definition/mapping input and re-export the profile. Generic
XLSForm editing/import is not implemented here.

This is consistency, not authenticity. An actor can modify the source and create
a matching projection; there is no signature, trusted checksum or authorization
proof. A future server must treat every imported bundle as untrusted author input.

### Interoperability limits

These in-memory tables are not an Excel workbook or a proven deployable XLSForm.
Internal round trips recompile the preserved source with Kusanya; they do not
run pyxforms or establish its output equivalence. XLSForm can interpret `${name}`
inside labels and expressions in defaults, while this compiler treats those fields
as literals. Repeat wrappers, nested expression context, hidden binds and generated
metadata also need explicit converter/runtime evidence before external claims.

Fixed counts project as literal numbers; answer-driven counts refer to their
source question rather than a missing `_ksny_count_*` helper. This does not close
notes 36/37: Collect UI evidence and the client-specific count-reduction policy
remain outstanding. Imported compilation carries the same warnings.

The table API itself performs no binary parsing or formula evaluation. Its strict
`.xlsx` adapter stores every projected cell as an OOXML inline string with the text
number format, including leading `=`, `+`, `-` and `@`, leading zeros and literal
whitespace. No formula or cached formula result is emitted. The canonical source
chunks are unchanged, so note 40 is answered without a lossy neutralization prefix.

## Strict XLSX adapter

Import `exportXlsFormWorkbook` and `importXlsFormWorkbook` from
`service/dist/src/interchange/xlsx-workbook.js` after building:

```js
const exported = exportXlsFormWorkbook(formInput, mappingInput);
if (exported.ok) {
  await writeFile('form.xlsx', exported.workbook);
  const restored = importXlsFormWorkbook(exported.workbook);
}
```

Both APIs are in-memory. The caller owns file I/O and authorization. Import accepts
`Uint8Array` or `ArrayBuffer`, copies caller-owned bytes and returns the same bundle
contract as the table importer. The workbook is deterministic and contains exactly
`survey`, `choices`, `settings` and `kusanya_source`.

This is a deliberately narrow OOXML subset. Import rejects formulas, typed cells,
comments, macros, external links, extra or missing ZIP parts, duplicate names,
unsupported compression, changed package metadata, non-sequential cells and any
projection that disagrees with the canonical source. A workbook re-saved by Excel,
LibreOffice or another tool may add unsupported parts and fail closed. Generic
workbook normalization and visible-cell editing remain outside this profile.

Compressed input is limited to 12 MB, each expanded part to 10 MB and all expanded
parts to 20 MB before decompression. The table limits below apply after XML decoding.
`fflate` 0.8.3 and `saxes` 6.0.0 are pinned free runtime dependencies; their complete
tree is recorded in `docs/dependency-licences.md`.

## Limits and audience

| Boundary                    | Limit                     |
| --------------------------- | ------------------------- |
| Authoring JSON input/output | 4,000,000 UTF-16 units    |
| Plain-data nesting          | 64 levels                 |
| Plain-data node budget      | 100,000                   |
| Plain-data string budget    | 2,000,000 UTF-16 units    |
| Tables                      | Exactly four named sheets |
| Rows per sheet              | 6,000                     |
| Total cells                 | 100,000                   |
| Individual cell             | 32,767 UTF-16 units       |
| Accumulated table text      | 8,000,000 UTF-16 units    |
| Source chunk                | 30,000 UTF-16 units       |

Node accounting includes every object/array/scalar and every object key across
the complete envelope on both export and import. String accounting includes keys
and values.

The existing form/mapping bounds still apply and can reject an input sooner. A
compiler-supported 32,768-unit label can fit a JSON bundle yet exceed a table cell;
table export fails rather than truncating it. Bounds describe this implementation,
not complete Salesforce, Excel or XLSForm limits.

Bundles and the source sheet intentionally include author-only information.
Never deliver them as collector forms. `audience: 'authoring-only'` is a label,
not access control. There are no HTTP routes or authorization changes in this unit.
Note 39's reviewer-delivery requirements remain due at the first delivery unit.

## Local checks and synthetic artifacts

From the repository root with the existing Node 24 dependencies:

```powershell
npm.cmd --prefix service run build
node --test service/dist/test/unit/authoring-bundle.test.js service/dist/test/unit/xlsform-tables.test.js
node scripts/check-interchange-fixtures.mjs
node --test service/dist/test/unit/xlsx-workbook.test.js
node scripts/check-xlsx-fixture.mjs
```

The checker uses the four existing ODK fixtures, the reviewer and 144-node
synthetic fixtures, and the two existing repeat-context definitions (without
running client engines). It asserts both import paths preserve canonical source and
exact compiled XML, and that a changed visible setting is rejected. It writes
bundle/table JSON, XML and SHA-256 hashes into a unique ignored `work/interchange-*`
directory. It accepts no input path and makes no network, authentication or
Salesforce call. These are synthetic artifacts, not production seed exports.

Full checks:

```powershell
node --test scripts/*.test.mjs
npm.cmd --prefix service test
npm.cmd --prefix service run lint
npm.cmd --prefix service run typecheck
npm.cmd run format:check
node scripts/check-scaffold.mjs
git diff --check
```

The optional ODK Validate command remains in the [compiler runbook](compiler.md);
validation of recompiled XML does not test a spreadsheet converter. No extra
scratch org, CI change, namespace change, runtime-probe install or device setup is
authorized. C10.10 still needs actual XLSForm file exchange into a fresh Salesforce
org, and C10.12 remains separate work.

Builder checks on this unit passed: 252 root tests and 151 service tests in both
PowerShell and Git Bash; service lint/typecheck, repository formatting, scaffold
and whitespace checks also passed. All eight synthetic definitions preserved
canonical JSON and exact compiled XML through both import paths, and all eight
altered projections were rejected. The generated artifact manifest was
`work/interchange-Q80wqE/manifest.json`; rerunning the checker creates a new unique
directory with deterministic artifact hashes.

The existing ODK Validate 1.20.0 check accepted four positive compiler fixtures
and rejected both negative controls, using the pinned validator SHA-256 in the
compiler runbook. Those results are XML checks, not spreadsheet-converter proof.
Boundary regressions include an exact 100,000-node envelope round trip and
rejection above that limit, and decimal rounding/underflow rejection.

No builder scratch org, local container run or optional runtime-tool installation
was used for this unit. Claude's review, the public CI container checks and the
approved hosted Apex run remain independent evidence, not supplied by this file.
