# Data model: first Phase 1 slice

The source now defines the Form/Version foundation below. This is not the whole
C4 model, a publishing implementation or a claim of deployed/namespaced behavior.
See ADR 0009 for schema choices and ADR 0008 for Bill's unnamespaced-development
approval. `salesforce/sfdx-project.json` still has an empty namespace.

| Object            | Fields and role                                                                                                                                    | Access / relationships                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `Folder__c`       | Name, Description                                                                                                                                  | Private owned root; deleting it clears a form's folder lookup.                           |
| `Form__c`         | Name, Status, Description, Folder, Default_Target_Object, Current_Version, Language, Country, Allow_Ad_Hoc_Submissions, GPS_Capture, Close_Message | Private owned root; Current_Version must belong to this form.                            |
| `Form_Version__c` | Form, Version_Number, Status, XForm, XLSForm, Compiled_At, Compile_Warnings, Published_By, Published_At, Change_Log, derived Version_Key           | Non-reparentable master-detail to Form; inherits sharing and deletion. Auto-number Name. |

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

Unassigned `Kusanya_Admin`, `Kusanya_Integration`, `Kusanya_Supervisor` permission
sets grant model CRUD, read/create/edit and read respectively, retaining sharing
and no setup permissions. The derived key is read-only. Required/master-detail
fields omit FLS entries. These do not assign users, create collectors or grant
access to customer target objects, and their definitions alone do not establish
effective access for a particular user.

Synthetic `FormDefinitionModelTest` exercises these invariants; root
`scripts/form-model.test.mjs` checks the source contract and permissions. Actual
deployment and Apex behavior require the approved hosted run and independent
verification. No C10 acceptance test is claimed by this slice.

The remaining Salesforce work includes question trees, choices and skip rules, metadata
mappings, jobs/tasks/prefill, assignment groups, collectors, submissions/answers,
scoring and operational audit records. Every future object and field must carry a
description. Target customer objects and fields are mapping data, never constants
hard-coded from the Splash seed.

PostgreSQL will hold tenant connections, hashed collector credentials, durable relay
state and API-use counters. Tenant-scoped keys, uniqueness, migration rollback and
retention constraints will be designed and tested before adding the first tables.
Salesforce refresh credentials must be encrypted at rest with rotatable keys.

No credentials or raw production seed records may become automated test fixtures.
