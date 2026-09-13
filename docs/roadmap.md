# Delivery gates

Only Claude can close a phase by recording a verdict in `docs/verification-log.md`.
Bill relayed Claude's Phase 0 PASS in PR #3 review 5177252674; the first Phase 1
unit is now in development. The builder does not issue its own gate verdict.

| C11 phase | Deliverables                                                                | C10 acceptance tests                           |
| --------- | --------------------------------------------------------------------------- | ---------------------------------------------- |
| 0         | Repository, scratch definition, lint/test CI, Apex coverage >=85%, ADRs     | None assigned; foundation checks required      |
| 1         | Data model, compiler, XLSForm import/export, print view, CLI publish        | 10, 12                                         |
| 2         | Tenant relay, OpenRosa, Apex ingestion/mapping, media, retry/error handling | 1, 2, 3, 5, 6, 8, 14, 15                       |
| 3         | Jobs/tasks, collectors/assignment, prefill, dashboards, Enketo/links        | 4, 7, 13                                       |
| 4         | Lightning builder and publish/security checks                               | 9                                              |
| 5         | Migration, seven-form validation and cut-over runbook                       | 11                                             |
| 6         | Kotlin/JavaRosa Android client and richer task workflow                     | Earlier suite plus client/offline regressions  |
| 7         | Approved packaging, Azure release/deployment and user guides                | Full earlier suite plus release/restore checks |

All earlier acceptance tests run again at each gate. Unimplemented tests must be
reported as unimplemented, never represented by passing stubs or claimed from smoke
tests. The repository currently has only one worked example and an empty XLSForm
directory; additional fixtures are required before claiming the full migration suite.

Decisions still due before their corresponding implementation: exact Collect/Enketo
versions, tenant OAuth flow, XML/queue/transaction strategy,
API-call budget, storage drivers and measured Cobitech upload bandwidth. Packaging
choice and paid dependencies require Bill's approval under C12.

`ksny` is registered but linking is blocked. Bill's 13 September Option 2 permits
the first unnamespaced model unit and ADR amendments together, superseding the
earlier link/ADR sequencing restriction. Keep the project namespace empty; require
linking before packaging or namespaced claims and run the suite namespaced as soon
as linking works, before the next phase gate (ADRs 0006/0008).

The first unit contains Folder/Form/Form Version and external namespace resolution,
not the complete data model or tests 10/12. Next units must deliver question trees,
choices, skip rules and mappings, then compilation/validation, XLSForm round trips,
print view and CLI publication. Do not mark Phase 1 complete from model tests.
