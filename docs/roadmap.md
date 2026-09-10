# Delivery gates

Only Claude can close a phase by recording a verdict in `docs/verification-log.md`.
Phase 0 is in progress; the builder does not mark it passed.

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
versions, tenant OAuth flow, namespace availability, XML/queue/transaction strategy,
API-call budget, storage drivers and measured Cobitech upload bandwidth. Packaging
choice and paid dependencies require Bill's approval under C12.
