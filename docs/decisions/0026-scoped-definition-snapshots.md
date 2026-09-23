# ADR 0026: Scoped Salesforce definition snapshots

- Status: Proposed; implementation awaiting independent verification
- Date: 2026-09-23
- Brief sections: C2, C3.16, C4 sharing and permissions, C8, C11 Phase 1
- Decision owner: Cobitech Solutions

## Context

The publication package accepts strict portable form and mapping inputs, but no
reviewed boundary loads those inputs from Salesforce, where definitions are the
source of truth. ADR 0011 and note 24 also record that private Form and Choice List
roots prevent an integration user or supervisor from reading definitions owned by
an administrator. Object Read and field access alone do not cross that sharing
boundary.

The stored model uses Salesforce IDs for relationships and human-readable names
for Choice Lists and Mappings. Those IDs must not enter compiler or package input,
and the human names are not safe portable identifiers. This unit therefore needs
an explicit translation boundary rather than passing queried records onward.

## Decision

### Grant definition-only View All Records

Set `viewAllRecords=true` for Kusanya Integration and Kusanya Supervisor on exactly
Folder, Form, Form Version, Question, Choice List, Choice, Skip Rule, Mapping and
Field Mapping. Keep `modifyAllRecords=false`, and retain the existing role-specific
CRUD and field permissions: Integration can author definitions but View All grants
only cross-owner reads; Supervisor remains read-only. Kusanya Admin is unchanged.

Do not grant View All Data, Modify All Data, setup/user management, customer target
access, or access to collectors, jobs, tasks, submissions or answers. Permission
sets remain unassigned package metadata and create no Salesforce user, collector,
share, queue or group.

### Read one version through an internal, user-mode boundary

`DefinitionSnapshotReader` is `with sharing` and accepts exactly one Form Version
ID. Every SOQL statement uses user mode, so object permissions, field permissions
and record access are effective at the read itself. Missing access, a missing
relationship, the wrong ID type or a bound violation produces only
`DEFINITION_SNAPSHOT_REFUSED`; supplied names and platform messages are not
returned.

The reader performs no DML and reads no mapping target object. It uses at most
seven fixed queries and enforces the compiler/package row bounds: 500 questions,
500 referenced choice lists, 5,000 choices, 2,000 skip rules, 100 mappings and
2,000 field mappings. Stable query ordering makes repeated reads deterministic.

This is deliberately an internal Apex service, not an externally reachable REST
resource. A later authenticated publisher must receive a separately reviewed
endpoint and authorization contract before exposing it to the service or CLI.

### Resolve IDs, then discard them

Salesforce IDs are used only inside the reader to join parents, repeat sources,
choice lists, mapping parents and field mappings. The returned envelope contains
the existing strict `FormDefinition` and `PrintMappingBundle` shapes and no record
ID, derived Salesforce key, saved Match Status or Match Detail.

Because the stored model has no portable Choice List or Mapping key, the snapshot
assigns `choice_list_1...n` and `mapping_1...n` after deterministic ordering and
rewrites all references before returning. The form key is a non-reversible digest
of the version identity prefixed with `form_`; the underlying ID is not exposed.
These are publication-snapshot identities, not a claim of cross-org persistence.
The later Salesforce import/persistence design must preserve explicit portable
keys if byte-identical republishing after migration is required.

Author Notes are present in the authoring definition for reviewer and round-trip
use. The existing compiler and package allowlists remain responsible for excluding
them from XForm and collector-facing output; this unit adds no delivery path.

## Alternatives considered

- `without sharing` or system-mode queries: bypass the reviewed permission boundary
  and make restricted-field tests meaningless.
- View All Data or Modify All Records: grants unrelated customer and operational
  access far beyond definition loading.
- Return raw queried records or Salesforce IDs: contaminates the portable compiler
  boundary and makes package contents org-specific.
- Use human names as keys: Form, Choice List and Mapping names are labels and need
  not be portable or unique.
- Add a REST endpoint now: authentication, tenant binding, write authorization and
  refusal semantics belong with the later publisher composition.

## Consequences and verification

Hosted tests must use synthetic records owned by a different principal and prove
that Integration and Supervisor read the complete version, reusable choice root
and Folder root. A principal without either permission set must receive only the
static refusal, and Supervisor writes must remain denied. Source tests pin the
nine-object allowlist, View All/Modify All values, lack of setup/class grants and
unchanged role CRUD/FLS.

Snapshot tests cover relationship resolution, constants including null, stable
synthetic keys, deterministic output, no record-ID disclosure, no DML and the
fixed query budget. Existing compiler/package tests remain the authority for the
portable bundle after this boundary.

Independent real-org success closes note 24. This unit advances note 34 by adding
definition loading, but note 34 remains open for tenant OAuth selection, encrypted
credential persistence and rotation, restricted-user target FLS proof, a reviewed
external publisher boundary and a publisher that refuses on every diagnostic. No
C10 acceptance test or publish-success claim is made.

## Revisit when

Adding the authenticated publisher endpoint, persisting portable keys, importing
definitions across orgs, widening the definition model, or exposing a snapshot to
reviewers or collectors.
