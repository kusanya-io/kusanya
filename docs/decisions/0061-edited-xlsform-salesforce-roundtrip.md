# ADR 0061: Bounded edited-XLSForm import and atomic Salesforce round trip

- Status: Proposed; implementation and C10.10 evidence awaiting independent verification
- Date: 2026-10-30
- Brief sections: C1.1/.2/.8, C3.12, C4, C5, C10.10, C11 Phase 1
- Decision owner: Cobitech Solutions

## Context

ADRs 0017 and 0018 deliberately made the first XLSForm profile immutable: the
embedded canonical source and every visible cell had to agree exactly. That proved
lossless export but could not accept a human edit. Brief C10.10 requires exporting
an XLSForm, importing it into a fresh org and comparing the compiled XForms after
normalising Salesforce identities. Salesforce must remain the authoring source of
truth, and importing must not create a partial graph when any late record fails.

The four-sheet Kusanya workbook contains authoring details that standard XLSForm
columns cannot express, including mappings, Author Notes and validation-script
source. Accepting an arbitrary third-party XLSForm would either discard those
details or require a different precedence and translation contract. C10.10 does
not require that broader converter.

## Decision

### Edited profile

Add separate `importEditedXlsFormTables` and `importEditedXlsFormWorkbook`
operations. The existing strict importers retain their exact behavior. Edited
import accepts only a workbook previously exported by Kusanya and preserves its
four sheets, row identities and embedded source.

The editable projection is bounded to visible authoring values: form title and
version; question labels, hints, required/read-only flags, defaults, calculations,
constraints and messages, relevance, appearance and repeat options; and choice
labels. Question, list and choice identities, question structure, types, names,
bindings, settings identity, rows and headers cannot change. A changed constraint
replaces the specialized regex/minimum/maximum source fields. A changed relevance
replaces the stored skip rules targeting that question. Unprojected mappings,
Author Notes and validation-script source remain from `kusanya_source`.

Expression cells are editable only in the compiler printer's canonical spelling;
the importer reports the exact noncanonical cell without echoing its text. When one
edit changes another generated cell, such as switching a repeat from fixed to an
answer count, that dependent cell may retain its original exported value and is
recomputed from the returned definition. Clearing skip-derived relevance removes
the corresponding stored rules.

The source sheet is consistency data, not a signature. After translating edits,
the importer regenerates the complete profile and requires every visible cell to
equal the canonical result. The same ZIP, XML, formula, package and resource bounds
from ADR 0018 remain in force. This is not arbitrary XLSForm ingestion, workbook
normalization or pyxform equivalence.

### Atomic Salesforce import

Add an integration-only Apex REST resource at
`/services/apexrest/v1/definitions/import`. It accepts schema version 1 portable
definition and mapping objects, never Salesforce record IDs. The service validates
bounds, portable keys, API-name grammar and all portable references before DML.
Because Apex reserves `hint` and `join` as identifiers, the resource first moves
those two exact public keys to private DTO names at their schema-defined paths;
private spellings in input are refused and strict DTO decoding still rejects every
unknown field. The wire contract remains `hint`/`join` in both directions.
It then inserts one Draft Form, Draft Form Version and their questions, choices,
skip rules and mappings under a savepoint. Every DML operation uses user mode. Any
late trigger, picklist, CRUD/FLS or relationship failure rolls back the entire
graph and returns one fixed refusal.

Only `Kusanya_Integration` receives the resource class and the new
`Import_Kusanya_Definition` custom permission. The resource does not publish,
Describe customer targets, read target records, select credentials, create users
or grant collectors Salesforce access. Existing publication validation remains
responsible for target-object compatibility.

Choice List and Mapping `Name` remain human-readable model fields, not stable export
identities. The existing snapshot reader assigns deterministic snapshot-local keys
and resolves every relationship through those keys. They do not affect compiled XML:
choices are inlined and mappings are outside the compiler definition. Salesforce
has no portable Form key field, so the XML comparison normalises
`definition.form.key`, the only generated identity that reaches those bytes.

### C10.10 harness

The service round-trip harness accepts an edited workbook and an injected,
per-request access-token provider. It sends exactly two bounded, non-redirecting
HTTPS requests to one Salesforce origin: atomic import, then the existing read-only
definition snapshot. It compiles the imported workbook and returned snapshot after
normalising the Form key, and succeeds only when the XML strings are byte-identical.
It derives the request count at the injected transport and reports both SHA-256
values on success and mismatch; matching hashes never substitute for byte comparison.

The harness stores no credential, does not retry, does not publish and does not
claim the imported Draft is production-ready. C10.10 passes only after the verifier
deploys the exact pull-request head to a fresh scratch org and exercises this path.

## Alternatives considered

- Treat the embedded source as authoritative and ignore visible edits: this is the
  old strict importer and does not implement import of an edited workbook.
- Reconstruct everything from standard XLSForm columns: loses Kusanya mappings and
  author-only fields that those columns cannot represent.
- Accept structural row edits now: requires a separately reviewed identity,
  hierarchy, mapping and unsupported-XLSForm translation design.
- Perform independent DML without a savepoint: can leave an unusable partial graph.
- Grant import to administrators or collectors: the service integration boundary
  is narrower, and collectors must never require Salesforce users or licences.
- Compare hashes only: a byte comparison is cheap and is the acceptance-test claim.

## Consequences and verification

Unit tests pin the strict/edited distinction, canonical regeneration, structural
refusals, retained author-only data, deterministic workbook parsing, hostile
response handling, deadlines and exact XML mismatch detection. Apex tests insert a
complete synthetic graph, read it back without IDs, prove the integration-only
permission, and force a late invalid record to show that every earlier insert is
rolled back.

The change introduces no package, namespace, workflow, harness, dependency,
manifest or lockfile change. The project namespace remains empty under ADR 0008.
Synthetic fixtures contain no customer or production data.

C10.10 evidence must state the fresh org, exact workbook bytes, normalized field,
both XML hashes and byte result. It does not establish generic XLSForm support,
C10.11 migration of the seven supplied forms, a namespaced deployment, publication,
or Phase 1 completion by itself.

## Revisit when

The builder supports structural spreadsheet edits, a third-party XLSForm converter
is selected, the portable bundle schema changes, or the Salesforce model gains a
dedicated portable Form or Mapping key.
