# Data model: Phase 1 definition slices

The source defines the Form/Version foundation plus question trees, choices and
stored skip rules below. This is not the whole
C4 model, a publishing implementation or a claim of deployed/namespaced behavior.
See ADRs 0009/0010 for schema choices and ADR 0008 for Bill's unnamespaced-development
approval. `salesforce/sfdx-project.json` still has an empty namespace.

| Object            | Fields and role                                                                                                                                                      | Access / relationships                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `Folder__c`       | Name, Description                                                                                                                                                    | Private owned root; deleting it clears a form's folder lookup.                                                |
| `Form__c`         | Name, Status, Description, Folder, Default_Target_Object, Current_Version, Language, Country, Allow_Ad_Hoc_Submissions, GPS_Capture, Close_Message                   | Private owned root; Current_Version must belong to this form.                                                 |
| `Form_Version__c` | Form, Version_Number, Status, XForm, XLSForm, Compiled_At, Compile_Warnings, Published_By, Published_At, Change_Log, derived Version_Key                             | Non-reparentable master-detail to Form; inherits sharing and deletion. Auto-number Name.                      |
| `Question__c`     | All C4 question fields: tree/identity, labels, Hint, Author_Notes, types/flags, expressions/constraints, repeat/media/prefill/lineage settings; derived Question_Key | Non-reparentable detail of Form Version; same-version Parent lookup, with Apex protection for direct deletes. |
| `Choice_List__c`  | Name, Description, optional Owner_Question                                                                                                                           | Private owned root; reusable when owner is null, otherwise immutable inline ownership by a select question.   |
| `Choice__c`       | Choice_List, Value, Label, Order, Filter_Value, Score, derived Choice_Key                                                                                            | Non-reparentable detail of Choice List; exact Value unique within its list.                                   |
| `Skip_Rule__c`    | Question, Source_Question, Operator, Value, Value_To, Join, Action                                                                                                   | Non-reparentable detail of target Question; distinct, same-version source with restricted deletion.           |

The table omits custom-field `__c` suffixes for readability. Every object, custom
field and record-name field has a description in source. Form/version status
defaults to Draft; ad-hoc submissions default false, GPS to none. Version numbers
must be positive integers and unique within a form. A before-write trigger derives
the unique key from the Form ID and version number, replacing supplied keys without
query/DML loops. The key must not be exported as portable identity.

XForm/XLSForm fields hold intended ContentDocument IDs as text, not validated Files
relationships. The current-version pointer checks the parent, not Published state.
Publication, artifact integrity, automatic version allocation, immutable published
versions and published/submission-aware deletion protection remain future work.
Do not interpret a manually set status or file pointer as a valid publication.

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
one query and no DML to reject a direct Question delete batch when any outside
question references its Parent, Repeat Source or Previous Version targets. Related
questions may be deleted together in one trigger batch; partial-DML retries
recheck the actual remaining batch. Larger deletes may need leaf-first ordering.
Master-detail cascades from Form/Form Version do not invoke this guard; a Form
cascade test covers a section/count/repeat/child/skip-rule definition. A cascade
can clear a surviving successor's lineage lookup. Full lifecycle protection and
inline-list cleanup are not implemented by this direct-delete guard.

To author inline choices, create the select question with no list, create the list
with that Owner Question, then set the question's Choice List backlink. Owner
cannot change or be cleared. To delete, clear the backlink, delete the list (and
its choices), then delete the question after removing any other references. Shared
lists are reusable across questions/versions; published snapshot protection is not
implemented yet. Values are nonblank Text(255), labels are separately required,
and exact case-sensitive values are unique per list via a derived SHA-256 key.

Skip Rule stores answered/is/is_not/less_than/greater_than/in_range/contains
conditions. Answered takes no operands; other operators need Value, and only
in_range needs/allows Value To. Join and Action default all/show. Compilation must
later check operand types, repeat-relative scope, relevance cycles and conflicting
Join/Action policies, then generate escaped XPath. No relevance is generated now.
The compiler must explicitly reject a repeat counted from anywhere in its own
subtree and skip-rule sources that cannot be answered (including section, repeat,
note and end); current authoring storage does not enforce those semantics (note 28).

## Access and verification status

Unassigned `Kusanya_Admin`, `Kusanya_Integration`, `Kusanya_Supervisor` permission
sets grant model CRUD, read/create/edit and read respectively, retaining sharing
and no setup permissions. All three derived keys are read-only. Required/master-detail
fields omit FLS entries. These do not assign users, create collectors or grant
access to customer target objects, and their definitions alone do not establish
effective access for a particular user.

Private ownership still prevents integration/supervisor reads of another user's
definitions by default (Claude note 24). ADR 0011 selects a future seven-object
View All Records allowlist and its effective-access tests. This PR grants none of
it. Implement and verify that read policy before any Phase 2 definition reader;
read-all does not authorize editing administrator-owned definitions.

Synthetic `FormDefinitionModelTest`, `QuestionDefinitionModelTest`,
`QuestionDeletionTest` and `ChoiceAndSkipRuleModelTest` exercise the model invariants; root
`scripts/form-model.test.mjs` checks the source contract and permissions. Actual
deployment and Apex behavior require the approved hosted run and independent
verification. No C10 acceptance test is claimed by this slice.

The remaining Salesforce work includes metadata mappings, compilation, publication,
version lifecycle, jobs/tasks/prefill, assignment groups, collectors, submissions/answers,
scoring and operational audit records. Every future object and field must carry a
description. Target customer objects and fields are mapping data, never constants
hard-coded from the Splash seed.

PostgreSQL will hold tenant connections, hashed collector credentials, durable relay
state and API-use counters. Tenant-scoped keys, uniqueness, migration rollback and
retention constraints will be designed and tested before adding the first tables.
Salesforce refresh credentials must be encrypted at rest with rotatable keys.

No credentials or raw production seed records may become automated test fixtures.
