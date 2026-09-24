# ADR 0023: Content-addressed publication package

- Status: Accepted; package schema advanced by ADR 0029
- Date: 2026-09-18
- Brief sections: C3.12/.16 foundation, C4 Form Version artifacts, C5 publish snapshot, C11 Phase 1
- Decision owner: Cobitech Solutions

## Context

ADR 0022 returns deterministic compiled XML after fresh target validation, but it
deliberately does not create the complete content that a future publisher will
store. Phase 1 also needs the authoring snapshot and human XLSForm kept with the
published version. Those pieces already have reviewed canonical boundaries in
ADRs 0017 and 0018; regenerating a different serialization in a CLI or storage
adapter would create unnecessary drift.

The preflight's `targetObjects` retain deterministic mapping-selected casing.
Salesforce accepts that casing, but note 51 observes that a stored artifact may
need Salesforce's canonical API-name spelling from the Describe responses. A
package identity must also be independent of operational values such as a request
count, publisher identity, timestamp, database ID or Salesforce ContentVersion ID.

## Decision

Add a pure package builder after the ADR 0022 boundary. Before any Describe I/O it
exports the strict canonical ADR 0017 authoring JSON and deterministic ADR 0018
XLSX workbook. It then runs preflight once against those canonical definition and
mapping snapshots. Local definition, mapping, compilation, table and workbook
failures therefore spend zero Describe requests.

The internal preflight composition result additionally carries its normalized
target-schema snapshot to the package builder. The public ADR 0022 result remains
unchanged and does not expose that snapshot. The package takes its target-object
list from normalized snapshot object names, not mapping spelling, so canonical
Salesforce response casing is retained. This answers note 51 only at the package
boundary; authoring mappings continue to preserve exactly what the author saved.

Success originally produced canonical JSON with schema version 1 and kind
`kusanya-publication-package`. Both the manifest and returned result are labelled
`publisher-only`, because they contain author annotations and target metadata and
must never be served as collector or reviewer content. The package contains:

- canonical authoring JSON and its SHA-256;
- exact compiled XForm XML and its SHA-256;
- deterministic XLSX bytes encoded as base64 and their SHA-256;
- canonical normalized target-schema JSON and its SHA-256;
- canonical target-object names; and
- compiler and target-validation warnings.

ADR 0029 advances the package to schema version 2 and adds the exact
`submissionPolicy.dynamicRepeatCardinality` marker `submitted-count-v1`. The
marker binds the later ingestion adapter to the reviewed repeat-cardinality rule
and participates in the package digest. No version-1 production package exists
that requires migration.

Object keys in package and target-schema JSON use code-unit ordering. The overall
package identity is the lowercase SHA-256 of the exact UTF-8 package JSON. A helper
checks a package string against a strict lowercase digest without parsing or
trusting its contents. Individual hashes let a later persistence adapter verify
the exact bytes it decodes into separate XForm and XLSForm files.

The canonical package JSON is capped at 8,000,000 UTF-16 code units. Its target-
schema JSON has the same cap in addition to ADR 0021's tighter structural and text
budgets. Upstream workbook generation remains capped at 12 MB. Base64 conversion
is therefore bounded even if the final package is refused. Any local, Describe,
target-validation or package-size refusal returns diagnostics and the exact request
count only, with no partial package or hashes.

The result object, target list, warning list and warnings are frozen. The package
JSON itself is an immutable JavaScript string and shares no mutable caller input.
This is content addressing, not durability: a future publisher must persist the
exact content transactionally and recheck its hashes.

## Consequences and verification

Tests decode and re-import the embedded authoring JSON and XLSX, independently
recompute every component and overall digest, preserve author mapping spelling,
take package target casing from Describe, and confirm deterministic bytes under
definition, mapping and Describe-field reordering. They also cover caller mutation
during Describe, zero-I/O local refusal, provider and target refusal without partial
content, frozen warnings, digest tampering, malformed digests and verifier size
bounds. Existing boundary suites retain their hostile-input and exact-limit tests.

No timestamp, publisher, audit identity, operational request count or storage ID is
inside the content-addressed package. The request count is returned alongside it
for later API accounting but cannot change package identity.

This unit does not authenticate to Salesforce, choose an API version, implement a
REST transport, impose a Describe timeout, run JavaRosa, execute mapping transforms,
persist to Salesforce Files/database/blob storage, change Form Version lifecycle,
audit publication, deliver reviewer or collector content, or expose a CLI/API
command. It makes no C10.10 or C10.12 claim and does not complete Phase 1.

Note 52 remains part of note 34's closing conditions: the concrete transport must
enforce per-request and overall deadlines. Notes 36, 37 and 39 remain open. Notes
47, 49 and 50 remain informational. No Enketo dependency is installed and no
Collect device/emulator decision is made. The workflow, Salesforce harness pin,
policy scripts, dependencies and Salesforce metadata are unchanged.

## Revisit when

Adding automatic JavaRosa validation, transactional artifact persistence, Form
Version lifecycle and audit fields, tenant OAuth and the bounded Describe transport,
or the CLI/API publication command.
