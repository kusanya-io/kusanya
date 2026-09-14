# ADR 0010: Explicit question scope, owned choices and stored skip rules

- Status: Accepted implementation decision; Claude verification pending
- Date: 2026-09-14
- Brief sections: C3.6, C3.19, C4, C8, C11 Phase 1, C12
- Decision owner: Cobitech Solutions

## Context

Bill requested the next model unit after PR #8's Form/Version foundation passed
Claude review 5194796568 and was merged. This unit adds the C4 Question,
Choice List, Choice and Skip Rule fields, not the compiler or a publishing API.
The HWWS seed illustrates a section containing once-only questions alongside
repeated observations; fixtures use synthetic definitions, not seed records.
Author annotations must not become collector hints. Note 25 also requests the
current-version INSERT regression and relationship-aware external naming.

## Decision

### Scope is structural, not a renderer flag

Question is a non-reparentable master-detail child of Form Version. Its optional
Parent lookup points only to a section or repeat in the same version. A section
does not multiply its children; only a repeat does. A once-only question and a
repeat are siblings under a section (or at the root). A once-only question is
never represented as a repeat child with an exception flag. Nested sections and
repeats are allowed. The later compiler must retain this structure, not flatten
the enclosing section into the repeat. This is the schema design for C3.6, not
evidence of correct Collect rendering.

Finding 26 correction: Claude's real deployment of `e694453` rejected metadata
`deleteConstraint=Restrict` on all three Question self-lookups. Offline conversion
did not detect this platform rule. Omit `deleteConstraint` on Parent, Repeat Source
Question and Previous Version Question, leaving Salesforce's default clear behavior.
Use a Question before-delete guard for direct deletion instead: one bulk existence
query checks all three references from questions outside the current trigger batch.
If any such dependant exists, reject the whole batch with a generic error and no
internal DML; otherwise references wholly inside the batch do not block deletion.
No cached delete-ID set is used, so platform partial-DML retries query again against
their actual batch. A regression covers a child rejected by a native non-self
lookup restriction while its parent was also submitted for deletion. Operations
larger than one trigger batch may require explicit leaf-first deletion; the guard
does not assume later batches will succeed.

Master-detail cascades from Form or Form Version bypass child delete triggers.
The cascade regression deletes a Form with a section, integer count, from-answer
repeat, child and skip rule. Cascades can clear self-lookups on surviving records,
notably successor lineage after deleting an earlier Form Version; the direct-delete
guard does not promise to protect that path. Non-self lookups retain their native
Restrict behavior. Full version/publication lifecycle protection remains future work.

Development diagnosis after the self-lookup correction found a second cascade
constraint: native Restrict on Skip Rule's Source Question vetoes a whole Form
delete even when both rule endpoints belong to the deleting definition. Retain
that native restriction, including its protection for a direct source-question
delete. Before a direct Form or Form Version delete, `DefinitionDeletionHandler`
queries only skip rules whose **target** question belongs to those exact owners,
then deletes that set with one all-or-none DML statement before the detail cascade.
Each owner trigger invocation uses one query and at most one internal DML;
the separate Question guard remains one query and no internal DML. Both owner
entry points are needed because a Form cascade bypasses the Version trigger.
The handler runs without sharing to match the owning cascade, adds no read API or
permission grant, caches no processed IDs and catches no failures. It never deletes
rules merely because their source is in scope. Ancestor failures must roll back
child cleanup, including partial-DML retries. Tests check executed-cleanup rollback
with an explicit transaction savepoint, mixed failed/successful Forms and Versions,
sibling-version isolation and a 200-Form batch. The inline-list native restriction
rejects the blocked owner before its trigger; that preservation test is not proof
of a later automation failure after cleanup. No production test hook is added.
Undelete/Recycle Bin restoration of explicitly removed skip rules is untested and
not promised as equivalent to native cascade restoration. Ordinary row/DML limits apply;
no background cleanup or unlimited cascade size is claimed. Inline-list cleanup
and published/submission-aware protections remain deferred: this is not complete
C3.11. These contracts still require Claude's independent runtime verification.

Runtime rejection contracts are explicit in tests: direct self-lookups receive
Salesforce's `CIRCULAR_DEPENDENCY`, while other custom graph rejections retain
`FIELD_CUSTOM_VALIDATION_EXCEPTION`. Assignment of a persisted Question's
non-reparentable Form Version field throws `SObjectException` before DML; the test
requires that exception, zero DML and unchanged stored ownership/key. These test
corrections do not relax model validation or allow failed writes to persist.
The Question/Skip Rule detail chain below Form has three
levels, within Salesforce's documented [master-detail relationship limits](https://help.salesforce.com/s/articleView?id=platform.relationships_considerations.htm&language=en_US&type=5).
Complete draft cascade and published/submission-aware deletion still need a
lifecycle service; these metadata relationships alone do not implement C3.11.

Question Name is the Text record-name field (80 characters), restricted to the
portable XML-name subset `[A-Za-z_][A-Za-z0-9_.-]*`, excluding names beginning
with `xml` in any case. This deliberately excludes valid non-ASCII XML names;
labels and hints remain Unicode. Names are case-sensitive and unique throughout
a version, not merely among siblings. A before-write trigger replaces supplied
`Question_Key__c` values with `<18-character version ID>:<Name>` in unique,
case-sensitive Text(100). It is internal identity, omitted/regenerated on import.

Each Question insert/update trigger batch locks its affected Form Versions, reads their complete
question graphs and referenced questions, and locks referenced/owned choice lists:
three fixed SOQL queries and no internal DML. Validation covers same-version
parents, container types, self-reference, cycles, repeat settings, lineage bounds
and inline ownership. Validation deliberately uses both old and proposed edges
and roles so a subset committed by `Database.update(..., false)` cannot leave an
invalid graph when another row fails a later rule. A graph error rejects the whole
batch. Consequently even some valid atomic rewrites, such as reversing a parent
edge or changing a container type while detaching its children, need staged
detach-then-reattach operations. No hidden retries are introduced. Concurrent lock
contention may fail the transaction; live concurrency is not established by unit
fixtures. Reading complete affected graphs also remains bounded by Salesforce's
transaction row/heap limits, not an unlimited-volume guarantee.

Repeat questions explicitly choose `fixed`, `from_answer` or `open`. Fixed requires
a positive whole count and no count source; from-answer requires a distinct
same-version integer question and no fixed count; open has neither. An optional
maximum is a positive whole number and cannot be below the fixed count. Repeat
settings on non-repeat questions are rejected. Choice-list references are valid
only for select-one/select-multiple questions. A select may have no list while
being authored; publication must reject incomplete definitions.

Previous Version Question currently means another version of the same Form,
never self or the current version. Chronological ordering, cross-version lineage
cycles and lifecycle immutability remain for version-cloning/publication work;
mutable version numbers must not be mistaken for a proven chronological chain.

### Hint and Author Notes are separate data

All C4 Question fields are present with descriptions. Hint is collector help;
Author Notes is author/reviewer-only content, in separate LongTextArea(32768)
fields. Future compiler/delivery code must explicitly allowlist collector fields
and exclude Author Notes from XForms and collector-facing output. An author-only
review view may deliberately include notes. There is no collector delivery path
yet, so persistence tests do not establish the end-to-end C3.19 guarantee.
Note 27: Integration currently has read and edit FLS on Author Notes for definition
authoring/import/export. FLS is therefore not the collector-leak boundary. The
compiler and delivery units must add synthetic tests proving distinctive author
notes never occur in generated XForms or any collector response/output, while
collector Hint remains available. Until those tests pass, C3.19 is not complete.

Narrative content, XPath, regex and validation scripts use LongTextArea(32768).
Appearance and Prefill Source use Text(255). Numerical bounds use Number(18,6).
Order, repeat counts/maxima, cascade level and media seconds use Number(9,0)
with positive-whole-number rules, preserving the validation-before-rounding
behavior proven for version numbers in PR #8. Bounds reject Minimum > Maximum.
Boolean flags default false; Type defaults text. Order is positive but not unique:
the compiler/importer must define deterministic sibling tie handling before export.
Stored expressions/scripts are not executed, validated as XPath or translated to
constraints in this unit. Import must reject overflow, never silently truncate.

### Reusable and inline lists

Choice List is a private owned root with Name, Description and optional
Owner Question. Null owner means reusable, including across versions. An inline
owner must be a select question and is immutable after creation, including
clearing it; ownership conversion uses a new list. Creation locks the owner row
before checking its type. Question updates cannot convert an inline-list owner
away from a select, even with an empty Choice List backlink.

An inline list's only permitted question backlink is its owner. Creation is
explicitly staged: insert the select question, insert its owned list, then set
the question's Choice List. Delete in reverse: clear that backlink, delete the
list and its Choice details, then delete the owner if desired. Other references
must also be removed explicitly. This protects reuse, but is not the final draft
cascade API. Reusable lists can currently be edited; publication must snapshot
or lock the correct versioned content before immutable published forms exist.

Choice is a non-reparentable master-detail child of Choice List. Value is required
Text(255); Label is LongTextArea(32768), enforced as nonblank by the trigger.
Order is a required positive whole number; Filter Value is optional Text(255)
and Score is Number(18,6). Duplicate exact values within a list are rejected by
unique Text(64) `Choice_Key__c`, a SHA-256 digest of `<list ID>:<Value>` computed
before every write. Different lists and different letter case may reuse values.
The hash avoids truncating long values; a digest collision fails uniqueness rather
than silently merging choices. It is not portable identity. The handler has no
SOQL or DML when assigning keys, including a 200-row batch.

### Skip Rule stores conditions, not executable relevance

Skip Rule is a non-reparentable detail of its target Question with a required,
delete-restricted Source Question. Target and source must be distinct questions
with the same non-reparentable version ownership. One bulk query validates these
references; no own DML.
Operator, Join and Action are restricted C4 picklists, defaulting to answered,
all and show. `answered` takes no operands; other operators require Value;
`in_range` also requires Value To, which all other operators reject. Operands
are Text(255), checked for presence only. Type compatibility, lexical conversion,
repeat-relative scope, circular relevance, escaping, range ordering and per-target
Join/Action combination/conflict checks belong to the compiler. No relevance is
generated or silently applied, and hand-written Relevant is not rewritten here.
Note 28 explicitly requires compile-time rejection of a from-answer repeat whose
count source is anywhere inside its own repeat subtree (including nested sections
or repeats), and of skip rules sourced from non-answerable nodes such as section,
repeat, note or end. The model currently accepts these incomplete authoring states;
the future compiler must reject them with actionable diagnostics and tests before
it can produce a publishable artifact. They are not supported runtime semantics.

The integrity handlers deliberately run without sharing so hidden definitions
participate in validation; they are trigger-only helpers, return no definition
data and expose no REST/Aura/collector API. This is not a substitute for CRUD/FLS
or sharing checks in future read/publish services.

### External relationship names and permission scope

Extend the existing pure service resolver with `kusanyaRelationship` for one
explicit local `__r` name, and `targetRelationship` for a preserved standard,
customer or foreign-package relationship API name. Callers supply the actual
relationship name rather than inferring a child relationship from a field name.
Neither accepts a traversal expression. Existing Kusanya-owned object/field helpers remain
`__c`-only. This follows [Salesforce custom relationship naming](https://developer.salesforce.com/docs/platform/salesforce-soql-sosl/guide/sforce-api-calls-soql-relationships-and-custom-objects.html).
Synthetic empty and `ksny__` tests cover both parent and child names, hostile
inputs and independent resolvers. No external query endpoint is introduced.

Extend the three unassigned model permission sets to these four objects using
the existing Admin CRUD / Integration read-create-edit / Supervisor read policy.
Derived keys remain read-only; no View All, Modify All, setup or target-object
grants are added. ADR 0011 records note 24's future cross-owner read decision and
the effective-access tests required before Phase 2 reads any definitions.

## Alternatives considered

- A form-wide repeat flag or once-only override inside a repeat: ambiguous scope
  that recreates C3.6. Explicit sibling nodes preserve the intended tree.
- Automatically move children when a parent is deleted: silently changes scope.
- Trust query-before-insert for uniqueness: fails under concurrent writes.
- Mutate inline ownership or shared published lists implicitly: risks changing
  other definitions. Explicit authoring steps precede a reviewed lifecycle API.
- Implement compiler semantics now: exceeds this bounded model unit and would
  hide unproven behavior behind successful record inserts.

## Consequences and verification

Synthetic Apex tests cover mixed once-only/repeat scopes, trees and invalid/partial
updates, 200-row batches/deep trees, names/keys, repeat/lineage references, separate
Hint/Notes, inline ownership, choice uniqueness/deletion, skip-rule references and
operands. `QuestionDeletionTest` covers the finding 26 cascade, direct/grouped
self-reference deletes, partial-DML retry and 200-row query/DML bounds. These
platform behaviors require real-org evidence; source conversion is insufficient.
`DefinitionDeletionTest` checks owner-scoped skip cleanup, rollback, partial
owner deletion and bulk bounds without claiming the full publication lifecycle.
The Form test adds note 25's cross-form Current Version INSERT rejection.
Source tests check field inventory/descriptions/permissions and local API names;
service tests exercise both namespace configurations. Deployment, runtime deletion
behavior and >=85% Apex coverage still require the approved exact-head hosted run
and Claude's independent verification, not local source conversion.

C10 tests 10 and 12 are not implemented or claimed. No mapping, compiler,
XLSForm round trip, print view, CLI publishing, lifecycle/authorization API,
collector account, CI/harness change, scratch allocation or package is added.
The namespace remains empty under ADR 0008: namespace-specific defects remain a
risk until the linked namespaced suite runs before the next phase gate.

## Revisit when

Compiler/import/export establishes deterministic ordering, expression semantics,
limits and immutable publication; the authoring UI needs atomic tree rewrites;
larger measured workloads require a different graph-validation strategy; or
namespace linking permits the required namespaced suite.
