# ADR 0018: Strict XLSX adapter for authoring interchange

- Status: Accepted design decision; implementation awaiting independent verification
- Date: 2026-09-16
- Brief sections: C3.12, C5 import/export, C11 Phase 1, C12 dependencies
- Decision owner: Cobitech Solutions

## Context

ADR 0017 defines a lossless, consistency-checked four-table authoring profile but
does not cross the binary spreadsheet boundary. A workbook reader must treat ZIP,
XML and cell values as untrusted input. It must also answer verifier note 40:
author text beginning with `=`, `+`, `-` or `@` cannot become a spreadsheet formula,
while the canonical `kusanya_source` JSON must remain byte-exact.

General edited-XLSForm translation is a different problem. The current profile
intentionally refuses a visible projection that contradicts its canonical source,
and no real migration workbook exists in `seed/xlsform/` yet.

## Decision

Add `exportXlsFormWorkbook` and `importXlsFormWorkbook` as pure, in-memory service
adapters over ADR 0017's table API. A successful export returns deterministic XLSX
bytes with the existing `authoring-only` and `structural-only` labels. Import returns
the existing authoring-bundle result after complete projection validation. Neither
operation reads files, calls Salesforce, publishes, authorizes delivery or changes
the source of truth.

The workbook contains exactly `survey`, `choices`, `settings` and
`kusanya_source`, in that order. Every cell is an OOXML `inlineStr` using an
explicit text number format. The writer never emits a formula element, shared
formula, cached formula result, external link, macro, drawing, comment, defined
name or calculation chain. This stores formula-looking author text as literal text
without changing its value, so the source sheet and display sheets round trip
exactly. Note 40 is answered at this boundary.

Import accepts only the package subset emitted by the writer. It requires the
exact content-type, relationship, workbook and style parts; exact part names and
count; sequential rows and cells; and inline-string text cells. It rejects extra
or missing parts, duplicate ZIP names, unsupported compression, formulas, typed
cells, comments, CDATA, processing instructions, macros, external links and
altered package metadata. A workbook re-saved by another application may gain
unsupported package parts and be rejected; broad OOXML normalization is not part
of this unit.

Bound compressed input to 12 MB, each expanded part to 10 MB and total expanded
content to 20 MB before decompression. The existing table limits still apply after
XML decoding: four sheets, 6,000 rows per sheet, 100,000 cells, 32,767 UTF-16 units
per cell and 8,000,000 accumulated cell units. Failures expose structural codes and
locations, not author content or parser excerpts.

Use `fflate` 0.8.3 (MIT) for bounded ZIP creation/extraction and `saxes` 6.0.0
(ISC, with `xmlchars` under MIT) for strict streaming XML parsing. They are free,
small runtime dependencies and introduce no paid-dependency approval. The service
lockfile pins the complete tree, the dependency licence inventory records it, and
`npm audit` reports zero known vulnerabilities at selection time. Do not use the
larger general-purpose workbook packages whose permissive parsing would undermine
the deliberately narrow boundary.

## Consequences and verification

Tests require deterministic bytes, exact source/mapping/XML round trips and literal
preservation of formula prefixes, whitespace, Unicode and leading zeros. Negative
controls cover formulas, typed cells, comments, macros, external links, missing and
altered package parts, malformed archives, inconsistent projections and expansion
limits. The synthetic fixture checker writes one ignored workbook and manifest for
inspection by an independent reader.

This advances binary XLSX import/export but does not complete C3.12, C5 or C10.10.
General edited-XLSForm translation, pyxforms/converter equivalence, the real seven
migration workbooks, complete C4 persistence, fresh-org import/export and Salesforce
publication remain open. Authoring workbooks contain Author Notes and mapping data;
the audience label is not authorization and no delivery route is added.

No Enketo dependency is installed, no Collect device/emulator decision is made,
and notes 36/37 remain open. No workflow, harness, namespace, Salesforce metadata,
permission set or scratch-org behavior changes in this unit.

## Revisit when

Supporting third-party-produced workbooks, general visible-cell edits, CSV, shared
strings, richer formatting, larger limits, hosted download/upload, Salesforce
persistence, converter equivalence or C10.10.
