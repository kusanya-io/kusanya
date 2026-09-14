# ADR 0009: Form/version foundation and explicit external namespace resolution

- Status: Accepted implementation decision; Claude verification pending
- Date: 2026-09-13
- Brief sections: C2, C3, C4, C8, C11 Phase 1, C12, C13
- Decision owner: Cobitech Solutions

## Context

Bill approved unnamespaced Phase 1 development while Salesforce Support addresses
the locked namespace-registry flow (ADR 0008). Phase 0 passed independent review;
the first Phase 1 PR is a bounded foundation, not the whole phase. It must be
deployable without a namespace and avoid baking that deployment choice into future
service, CLI, XForm binding or mapping code.

## Decision

### A small, coherent first model unit

Implement `Folder__c`, `Form__c` and `Form_Version__c`, including every Form and
Form Version field in C4, with explicit descriptions. Form and Folder are private
owned roots. A form's optional folder lookup clears when the folder is deleted;
deleting a folder does not delete its forms. Versions have a non-reparentable
master-detail relationship to Form and inherit its access and deletion behavior.
An optional `Current_Version__c` lookup clears if that version is deleted and a
validation rule rejects a version belonging to another form.

Version numbers are required positive integers of up to nine digits. Enforce
uniqueness per form with a case-sensitive, unique `Version_Key__c` Text(28), derived
from the 18-character Form ID, a colon and the integral version number. A before
insert/update trigger recomputes it regardless of caller input, with no SOQL or
DML of its own. Invalid numbers retain their validation errors, not a truncated
identity. Version numbering is caller-supplied, not an automatic allocator; the
database's unique constraint rejects collisions, including concurrent attempts.
The key is internal record identity, not a cross-org export identifier. Future
import/export must omit and regenerate it from the destination form.

Form and version statuses default to Draft; ad-hoc submission permission defaults
false and GPS capture to none. C4 status values are stored but publishing,
immutability and retirement transitions are not implemented by this slice. No
publishing endpoint is exposed and these fields are not evidence of a compiled or
published form. Published/submission-aware delete guards must precede actual
publication/ingestion; the current cascade is not a claim of C3.11 completion.

`XForm__c` and `XLSForm__c` are Text(18) pointers intended for ContentDocument IDs,
not unsupported custom lookups to Files. File existence, ownership, lifecycle and
authorization checks belong to the upcoming compiler/file service. A stored string
alone does not establish a valid artifact. `Published_By__c` is an optional User
lookup for Salesforce staff, never a collector account or credential.

Use Text(255) for the configured default target object's API name, Text(35) for
language and Text(80) for country; do not invent a country catalogue or mandatory
locale policy. Narrative content uses LongTextArea(32768). Later import limits must
report overflow, not silently truncate source definitions.

Provide three unassigned permission sets for this model only: Admin has CRUD,
Integration has read/create/edit without delete, Supervisor has read. No setup
privileges, view-all/modify-all bypass, user creation, collector assignment, licence
binding or target-customer-object grants are included. All retain ordinary record
sharing. The derived version key is readable but not writable through these sets.
Universally required fields and master-detail fields do not get individual FLS
entries, following the [Metadata API permission-set rules](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/api_meta.pdf).
Assignment and effective user access are separate from this metadata contract.

### One explicit external naming boundary

`service/src/salesforce-names.ts` exports a pure, immutable resolver constructed
from each connection's namespace prefix. The service's initial deployment default
comes from `SALESFORCE_NAMESPACE_PREFIX` (empty by default); that value must never
select a tenant or overwrite another connection's namespace. Future tenant
connections construct independent resolvers from their stored configuration.

Use `kusanyaObject` / `kusanyaField` only for unqualified Kusanya-owned custom API
names with `__c`. They reject already-qualified input to prevent double prefixes.
Use `targetObject` / `targetField` for explicit standard, customer-owned or other
package API names: validate a single identifier and preserve it verbatim. Do not
prefix every custom field just because it ends in `__c`, guess ownership, rewrite
XPath/question node names, or accept raw SOQL expressions as API identifiers.
Syntax validation is not a describe lookup, authorization check or query builder.

The same module is reusable by future CLI publish and compiler/mapping adapters;
they must accept namespace configuration rather than introduce another hard-coded
name table. REST resources use `apexRestPath`: a literal relative resource becomes
`/services/apexrest/<namespace>/<resource>` with the namespace's `__` removed,
or `/services/apexrest/<resource>` for the empty configuration, following
[Salesforce's Apex REST namespace convention](https://trailhead.salesforce.com/content/learn/modules/apex_integration_services/apex_integration_webservices).
Reject absolute paths, traversal, escapes, query strings and fragments. No REST
resource or CLI publishing implementation is introduced by this helper.

Inside Salesforce, source retains local typed/custom metadata references and
contains no fixed namespace or org IDs. The project namespace remains empty.

## Alternatives considered

- Build all C4 objects in one PR: makes the first verified unit unnecessarily large
  and introduces phase-specific behavior before its APIs and invariants are ready.
- Store a globally unique version number: different forms legitimately have version
  1. Query-before-insert alone would not close concurrent uniqueness races.
- Automatically prepend the namespace to every `__c` name: corrupts customer and
  other-package targets. Ownership must be explicit at the call site.
- Change the namespace or CI now: exceeds Option 2 and cannot establish a link.

## Consequences and verification

Synthetic Apex fixtures cover metadata defaults, hierarchy, positive integral
numbers, same-form current-version validation, per-form version uniqueness,
attempted derived-key overrides, bulk operations and deletion relationships.
Source tests check C4 fields/descriptions, local references and permission scope.
Service fixtures cover empty and `ksny__` prefixes, interleaved configurations,
target preservation, REST paths and malformed/injected inputs without secrets.

These are foundation tests, not C10 tests 10 or 12. Questions, choices, skip rules,
mappings, compilation, validation, XLSForm round trips, print view, CLI publish and
enforced lifecycle remain unimplemented. No namespace-specific runtime claim is
made; only a linked namespaced scratch-org suite can establish that evidence.
No paid dependency, CI change, org creation, hosting deployment or package decision
is part of this implementation. Hosted exact-head Apex and independent Claude
verification still follow the existing rules; public local checks do not replace
either. Namespaced defects remain an accepted risk under Bill's Option 2 decision.

## Revisit when

Compiler/import/export work defines artifact integrity, stable cross-org IDs and
version transition rules; additional target APIs require more identifier kinds;
or namespace linking succeeds. Run the applicable suite namespaced before the
next phase gate and review any required source/configuration changes separately.
