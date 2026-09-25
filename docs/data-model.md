# Data model: Phase 1 definition slices

The source defines the Form/Version foundation plus question trees, choices,
stored skip rules and mapping definitions below. This is not the whole
C4 model, a publishing implementation or a claim of deployed/namespaced behavior.
See ADRs 0009/0010/0013 for schema choices and ADR 0008 for Bill's unnamespaced-development
approval. `salesforce/sfdx-project.json` still has an empty namespace.

| Object             | Fields and role                                                                                                                                                                                           | Access / relationships                                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `Folder__c`        | Name, Description                                                                                                                                                                                         | Private owned root; deleting it clears a form's folder lookup.                                                                  |
| `Form__c`          | Name, Status, Description, Folder, Default_Target_Object, Current_Version, Language, Country, Allow_Ad_Hoc_Submissions, GPS_Capture, Close_Message                                                        | Private owned root; Current_Version must belong to this form.                                                                   |
| `Form_Version__c`  | Form, Version_Number, Status, XForm/XLSForm document IDs, exact XForm/XLSForm version IDs, Publication_Digest, Compiled_At, Compile_Warnings, Published_By, Published_At, Change_Log, derived Version_Key | Non-reparentable master-detail to Form; inherits sharing and deletion. Auto-number Name.                                        |
| `Question__c`      | All C4 question fields: tree/identity, labels, Hint, Author_Notes, types/flags, expressions/constraints, repeat/media/prefill/lineage settings; derived Question_Key                                      | Non-reparentable detail of Form Version; same-version Parent lookup, with Apex protection for direct deletes.                   |
| `Choice_List__c`   | Name, Description, optional Owner_Question                                                                                                                                                                | Private owned root; reusable when owner is null, otherwise immutable inline ownership by a select question.                     |
| `Choice__c`        | Choice_List, Value, Label, Order, Filter_Value, Score, derived Choice_Key                                                                                                                                 | Non-reparentable detail of Choice List; exact Value unique within its list.                                                     |
| `Skip_Rule__c`     | Question, Source_Question, Operator, Value, Value_To, Join, Action                                                                                                                                        | Non-reparentable detail of target Question; distinct, same-version source with restricted deletion.                             |
| `Mapping__c`       | Form_Version, Target_Object, Record_Type, Kind, Repeat_Question, Parent_Mapping, Parent_Lookup_Field, Matching_Field, Upsert_External_Id_Field, Collector_Field, Submission_Field, Order                  | Non-reparentable detail of Form Version; same-version acyclic parent graph; repeat kind requires a repeat Question.             |
| `Field_Mapping__c` | Mapping, Question, Target_Field, Transform, Constant_Value, Match_Status, Match_Detail; Source_Kind and derived Target_Key                                                                                | Non-reparentable detail of Mapping; same-version question or explicit constant; case-insensitive target uniqueness per mapping. |

The table omits custom-field `__c` suffixes for readability. Every object, custom
field and record-name field has a description in source. Form/version status
defaults to Draft; ad-hoc submissions default false, GPS to none. Version numbers
must be positive integers and unique within a form. A before-write trigger derives
the unique key from the Form ID and version number, replacing supplied keys without
query/DML loops. The key must not be exported as portable identity.

XForm/XLSForm fields hold linked ContentDocument IDs as text; companion Version
fields pin the exact immutable ContentVersion IDs. ADR 0031 permits newer document
versions without changing the pin. Salesforce refuses direct version deletion;
Kusanya guards refuse deletion of pinned documents and unlinking of committed
artifacts. The exact ADR 0023 package digest is stored separately, but neither the
lifecycle nor the retention guards hash large file bodies in synchronous Apex.
The later authenticated publisher must verify the uploaded bytes before calling
the commit. Automatic version allocation and submission-aware deletion remain
future work. A manually supplied pointer or status is refused.

## Question authoring rules

The explicit tree preserves mixed once-only and repeating content:

```text
section: observation
  question: station_ready       (once per section instance)
  question: student_count       (once per section instance)
  repeat: students              (from student_count)
    question: student_observation
  note: closing_note            (outside students repeat)
```

Only a repeat multiplies its descendants. A section itself does not repeat;
nesting that section inside another repeat still places all its children in that
outer scope. Parent checks reject cross-version references, non-containers and
cycles. Repeat count sources must be same-version integer questions. Fixed counts
and maxima are positive whole numbers. Question names use a restricted ASCII XML
name syntax and are unique case-sensitively throughout a version. Sibling Order
values are positive but not unique; deterministic tie handling is compiler work.

Use Hint for collector help and Author Notes for author/reviewer annotations.
The future compiler must omit Author Notes from collector output; this unit tests
separate storage, not delivery. Stored XPath, regex and scripts are not executed.
Integration can currently read and edit Author Notes: the compiler/delivery
allowlist, not FLS, must enforce exclusion and include a regression proving notes
never reach generated XForms or collector output (note 27).
See ADR 0010 for field lengths, defaults and publication-time validation gaps.

Tree edits are conservative under partial DML: detach children before changing a
container's type or reversing edges. A structural error rejects the entire batch
so successful rows cannot depend on failed ones. Version ownership cannot change.
Previous Version Question checks another version of the same Form, not chronology
or lineage cycles; those remain publication/version-lifecycle work.

Question self-lookups cannot use metadata Restrict (Claude finding 26). Their
metadata leaves Salesforce's default clear behavior. A before-delete guard uses
one self-reference query and no DML to reject a direct Question delete batch when any outside
question references its Parent, Repeat Source or Previous Version targets. Related
questions may be deleted together in one trigger batch; partial-DML retries
recheck the actual remaining batch. Larger deletes may need leaf-first ordering.
Master-detail cascades from Form/Form Version do not invoke this guard; a Form
cascade test covers a section/count/repeat/child/skip-rule definition. A cascade
can clear a surviving successor's lineage lookup. Full lifecycle protection and
inline-list cleanup are not implemented by this direct-delete guard.

Direct Form and Form Version deletes first remove only skip rules owned by their
target questions. This uses one query and at most one all-or-none child delete per
owner trigger batch, retaining native Source Question Restrict for direct question
deletes. Cleanup rolls back if owner deletion fails; partial retries do not use
cached IDs. The Form path performs its own cleanup because cascades bypass the
Version trigger. Inline lists can still block ancestor deletion until explicitly
unlinked/deleted; publication/submission-aware protection and the complete C3.11
lifecycle remain deferred. See ADR 0010 for rollback and bulk regression coverage.

ADR 0013 additionally protects Question references held by mappings: two fixed
dependency queries refuse direct deletion if a Mapping uses the repeat or a Field
Mapping uses the question. Remove these definitions first. A referenced repeat
cannot change to a non-repeat type. Owner cascades bypass direct-child guards and
delete the same-version questions and mappings together; the existing Skip Rule
cleanup remains unchanged. These are storage guards, not lifecycle/undelete APIs.

To author inline choices, create the select question with no list, create the list
with that Owner Question, then set the question's Choice List backlink. Owner
cannot change or be cleared. To delete, clear the backlink, delete the list (and
its choices), then delete the question after removing any other references. Shared
lists are reusable across Draft questions/versions. Once any Published or
Superseded version uses a shared list, that list and its choices are immutable.
Values are nonblank Text(255), labels are separately required,
and exact case-sensitive values are unique per list via a derived SHA-256 key.

Skip Rule stores answered/is/is_not/less_than/greater_than/in_range/contains
conditions. Answered takes no operands; other operators need Value, and only
in_range needs/allows Value To. Join and Action default all/show. Compilation must
later check operand types, repeat-relative scope, relevance cycles and conflicting
Join/Action policies, then generate escaped XPath. No relevance is generated now.
The compiler must explicitly reject a repeat counted from anywhere in its own
subtree and skip-rule sources that cannot be answered (including section, repeat,
note and end); current authoring storage does not enforce those semantics (note 28).

## Mapping authoring rules

A reference mapping may supply the parent lookup for two repeat mappings with no
main mapping, as in the worked example. Parent Mapping and Parent Lookup Field
are paired. Parents must be distinct and same-version; cycles are refused,
including cycles possible under partial DML. Detach before reversing edges.
Order is positive/whole, not unique and not executable scheduling.

Target names are single API identifiers, not expressions, traversal paths or IDs.
Preserve customer/foreign name spelling and namespaces after Salesforce's pre-trigger
boundary-whitespace normalization; only explicitly Kusanya-owned
schema names receive the configured prefix outside Salesforce. Record Type is an
optional DeveloperName; publish must resolve it on the target, check availability
and reject ambiguity. No target schema, CRUD/FLS or record-type access is checked
by storage. The lexical rule even accepts `Account__r`/`Account__R` as Target Object
(Claude note 34); the publisher must Describe-check and reject identifiers that
are not actual target objects/fields. Reference Matching Field is required and may be `Id` or `Name`; future
publish/lookup logic must check uniqueness and refuse zero/multiple matches.

Repeat kind requires a repeat Question; main/reference kinds have no Repeat
Question. Field sources can be once-only answers outside a repeat, reused by both
repeat mappings, or answers inside it. Same-version ownership is enforced, but
answerability and executable instance scope are compiler work. Sibling/deeper-repeat
aggregation must not be silently inferred.

Field Mapping Source Kind is explicitly `question` or `constant`. Question mode
requires Question and no constant text. Constant mode forbids Question;
`0`/`false` are not missing. Salesforce trims leading/trailing spaces, tabs and
newlines before triggers, retains interior spaces, and converts whitespace-only
or empty values to null (Claude finding 33). Constant Value stores that normalized
literal, not byte-for-byte input. Null means an explicit blank in constant mode,
not omission. Whitespace-sensitive constants require lossless representation or
explicit import rejection before claiming C3.12 round trips; see ADR 0013.
The derived SHA-256 Target Key prevents
case-variant duplicate target assignments within one mapping and is never portable
identity. All twelve C4 transforms are stored, not run. Nullable Match Status has
no success default; saved diagnostics must never authorize publication.

Collector Field and Submission Field configure future trusted stamps, not response
identity overrides. No target write or stamping is implemented here. Compiler and
ingestion tests must reject conflicts with user field mappings and enforce C7.

Direct deletion of a referenced parent Mapping is refused with a generic message;
deleting it with all dependent mappings in one trigger batch is allowed. Larger
direct batches may need leaf-first order. Form/Version deletion cascades ownership;
Mapping deletion cascades Field Mappings. ADR 0027 blocks direct mutation and
deletion of Published/Superseded mappings and their Field Mappings.
Submission-aware retention and note 30's undelete behavior remain future work; do
not use restored definitions as published artifacts. See ADR 0013 for the earlier
storage tests and exact boundaries.

## Access and verification status

Unassigned `Kusanya_Admin`, `Kusanya_Integration`, `Kusanya_Supervisor` permission
sets grant model CRUD, read/create/edit and read respectively, with no setup
permissions. Integration and Supervisor have View All Records on exactly the nine
definition objects so ADR 0026's user-mode reader can cross private definition
ownership; neither has Modify All Records or View All Data. All four derived keys
are read-only. Required/master-detail fields omit FLS entries. These permissions
do not assign users, create collectors, grant customer-target access or allow a
Supervisor to edit definitions.

Private ownership still prevents integration/supervisor reads of another user's
definitions by default (Claude note 24). ADRs 0011/0013 select a future nine-object
View All Records allowlist and its effective-access tests. This PR grants none of
it. Implement and verify that read policy before any Phase 2 definition reader;
read-all does not authorize editing administrator-owned definitions.

Synthetic `FormDefinitionModelTest`, `QuestionDefinitionModelTest`,
`QuestionDeletionTest`, `ChoiceAndSkipRuleModelTest`, `MappingDefinitionModelTest`,
`MappingDeletionTest` and `FieldMappingDefinitionModelTest` exercise the model invariants; root
`scripts/form-model.test.mjs` checks the source contract and permissions. Actual
deployment and Apex behavior require the approved hosted run and independent
verification. No C10 acceptance test is claimed by this slice.

The remaining Salesforce work includes executable mapping/ingestion, an authenticated
publication composition and artifact delivery/retention, jobs/tasks/prefill,
assignment groups, collectors, submissions/answers,
scoring and operational audit records. Every future object and field must carry a
description. Target customer objects and fields are mapping data, never constants
hard-coded from the Splash seed.

PostgreSQL will hold tenant connections, hashed collector credentials, durable relay
state and API-use counters. Tenant-scoped keys, uniqueness, migration rollback and
retention constraints will be designed and tested before adding the first tables.
Salesforce refresh credentials must be encrypted at rest with rotatable keys.

ADR 0029 defines the future Answer cardinality boundary for dynamic repeats. The
submitted count is authoritative per enclosing repeat instance; trailing physical
rows beyond it are excluded from normalized Answers and mapped child records, a
deficit or invalid count fails closed, and the raw XML remains retained separately.
Publication package schema 2 pins the rule as `submitted-count-v1`. This unit does
not add Submission/Answer objects or perform ingestion DML.

No credentials or raw production seed records may become automated test fixtures.

## Portable compiler boundary

ADR 0014 and [the compiler contract](compiler.md) define a pure in-memory bundle
of form identity, questions, choice lists and skip rules. No Salesforce fields or
permissions change in that unit. It uses portable question names, not Salesforce
record IDs or namespaced API names; future Salesforce readers/importers must resolve
their connection's namespace before constructing it. Existing empty/`ksny__` resolver
fixtures do not prove a namespaced deployment.

ADR 0026 adds an internal, bounded Salesforce reader that translates one Form
Version and its definition/mapping graph into those existing portable shapes. It
uses Salesforce IDs only while resolving relationships, emits no record IDs, and
assigns deterministic snapshot-local keys where the stored model has no portable
Choice List or Mapping key. It is not an external endpoint or publication write.

The compiler checks question reference scope and excludes Author Notes from generated
XML (notes 27/28). It does not yet validate Mapping/Field Mapping execution scope,
target Describe/CRUD/FLS, record types, collector/submission stamp conflicts or lookup
uniqueness (notes 24/34). Mapping definitions are deliberately outside this input
schema, not accepted and then ignored. Compilation creates no Salesforce artifact,
cannot publish a version and does not fix lifecycle/undelete gaps.
