# Delivery gates

Only Claude can close a phase by recording a verdict in `docs/verification-log.md`.
Bill relayed Claude's Phase 0 PASS in PR #3 review 5177252674 and the first Phase 1
unit PASS in PR #8 review 5194796568 (merged as `e97882d`). The question-tree unit
passed Claude verification and merged as `1ec8488`; its verification log merged
through PR #7. Mapping definitions passed PR #10 and merged as `f435129`; the log
merged through PR #11 as `f5f4eb1`. The bounded compiler passed PR #12 and merged
as `bff5791`; its log merged through PR #13 as `f8bf523`. Runtime regressions
passed PR #14 and merged as `6356a87`; log PR #15 merged as `bb292e6`.
The reviewer print unit passed PR #16 and merged as `fc64c38`; log PR #17
merged as `0f1b209`.
The builder does not issue its own gate verdict.

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

The first unit contains Folder/Form/Form Version and external namespace resolution.
The current unit adds Question trees, choices and stored skip rules, separate
Hint/Author Notes, the Current Version INSERT regression and external `__r`
resolution (note 25). It does not complete C3.6/.19 rendering/delivery guarantees.
ADRs 0010/0011 record scope, lifecycle gaps and note 24's future object-scoped read
policy. That policy must be implemented and effective-access tested before any
Phase 2 definition reader; this unit retains private sharing and no View All.
Finding 26 replaces unsupported self-lookup metadata restrictions with direct-delete
Apex protection and cascade/grouped-delete regressions. Notes 27/28 require future
compiler/delivery tests for Author Notes exclusion, rejection of a repeat counted
from its own subtree, and rejection of non-answerable skip-rule sources.

The mapping-definition unit (ADR 0013) adds Mapping/Field Mapping storage,
same-version parent dependencies, explicit constants, portable target names and
deletion/reverse-reference guards. It extends ADR 0011's future read allowlist to
these definitions without granting cross-owner access now. No mapping execution
or target schema validation is claimed. Note 30's observed undelete gaps and
notes 29/31's tool/CI hardening stay deferred to their appropriate reviewed units.

The first compiler unit (ADR 0014) implements neutral-bundle tree/choice/skip
validation and deterministic XML generation inside the service. It tests Author
Notes exclusion and the note 28 invalid repeat/skip states. Offline synthetic
ODK Validate checks are not Collect/Enketo execution or acceptance evidence.
Dynamic-count reduction, richer XPath/options, JavaScript-to-XPath equivalence and
automatic per-artifact JavaRosa validation remain required before corresponding
runtime/publish claims. No CI or harness change is included; notes 29/31/35 remain
separate reviewed tooling/workflow work.

Next units must complete compilation/runtime validation, immutable publication
and draft deletion behavior, XLSForm round trips, reviewer delivery and CLI publication.
No model unit claims C10 tests 10/12. Do not mark Phase 1 complete from model tests.

The runtime-regression unit (ADR 0015) corrects qualified OpenRosa metadata and
draft ID generation, and adds optional Enketo 9.0.1/JavaRosa 6.0.0 engine probes.
Nested count contexts, draft reload and count-reduction differences are tested
with synthetic forms. Actual Collect app testing remains outstanding, so note
36 stays open. No C10 or publish-ready claim follows from these engine results.

The verified reviewer-print unit (ADR 0016) adds a
pure static HTML renderer using shared compiler preparation and supplied mapping
summaries. Author-only annotations remain distinct from collector help and XML.
Synthetic 144-node rendering is not the real C10 fixture or a phase gate.
Note 38 is answered by a verified source tripwire for optional probe isolation; normal dependencies,
CI and the harness are unchanged. Notes 36/37 remain open, including Bill's
device/emulator decision and the cross-client count-reduction policy. Claude's
Enketo reproduction still requires Bill's optional-install authorization.

The authoring-interchange unit (ADR 0017), awaiting independent verification,
adds canonical JSON snapshots and an XLSForm-style table projection with full
source/projection consistency checks. It preserves supported definitions and
mapping configurations, not all C4 records. Binary workbook handling, general
edited-XLSForm import and Salesforce persistence remain next steps before C10.10.
This unit creates no org and changes no workflow, harness, namespace or dependency.
Note 39's reviewer authorization, no-store/header protections and collector-denial
test are recorded in ADR 0016 and remain due at the first delivery unit.
