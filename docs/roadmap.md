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
The authoring-interchange unit passed PR #18 and merged as `3caea7a`; log PR #19
merged as `e90b05e`. The strict XLSX adapter passed PR #20 and merged as `2a4a1f1`;
its log PR #21 merged as `209e380`. Publication target validation passed PR #23 and
merged as `b3db0c7`; its log PR #24 merged as `8467e95`. Field compatibility passed
PR #25 and merged as `96998ad`; its log PR #26 merged as `1e7c966`. Salesforce
Describe normalization passed PR #27 and merged as `fb66940`; its log PR #29 merged
as `76c9a20`, after log PR #28 merged as `b24d8a3`. Publication preflight passed PR
#30 and merged as `91dbe8d`; its log PR #31 merged as `aab1c19`. The content-addressed
publication package passed PR #32 and merged as `164f35b`; its log PR #33 merged as
`92ec5d3`. The automatic validation unit passed PR #34 and merged as `308ff7f`; its
log PR #35 merged as `aa80c5c`. The bounded Describe transport passed PR #36 and
merged as `f48d788`; log PR #37 merged as `d9fce7e`. Collect evidence and finding 60
were logged through PR #38 as `b62b8c9`. The Collect `instanceID` correction passed
in PR #40 and its log merged in PR #41. Scoped definition snapshots passed in PR
#42 and their log merged in PR #43. The current unit implements the bounded atomic
Salesforce publication commit under ADR 0027. The builder does not issue its own
gate verdict.

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

Next units must complete the authenticated publisher/CLI composition, artifact
delivery and retention, client-specific repeat-count policy, Enketo evidence and
general edited-XLSForm import.
No model unit claims C10 tests 10/12. Do not mark Phase 1 complete from model tests.

The runtime-regression unit (ADR 0015) adds optional Enketo 9.0.1/JavaRosa 6.0.0
engine probes. Bill's later Collect v2026.3.4 emulator run confirmed nested count
contexts and the count-reduction divergence, answering note 36 for Collect and
confirming note 37. It also found that qualified metadata can lose `instanceID`
after a nested count change. The finding 60 correction emits conventional
unprefixed metadata, retains the guarded UUID calculation and changes the warning
to `DYNAMIC_REPEAT_CLIENT_SPECIFIC`. Note 37 remains open for the later
publication/ingestion cardinality rule. No C10 or publish-ready claim follows.

The verified reviewer-print unit (ADR 0016) adds a
pure static HTML renderer using shared compiler preparation and supplied mapping
summaries. Author-only annotations remain distinct from collector help and XML.
Synthetic 144-node rendering is not the real C10 fixture or a phase gate.
Note 38 is answered by a verified source tripwire for optional probe isolation; normal dependencies,
CI and the harness are unchanged. Notes 36/37 remain open, including Bill's
device/emulator decision and the cross-client count-reduction policy. Claude's
Enketo reproduction still requires Bill's optional-install authorization.

The verified authoring-interchange unit (ADR 0017) adds canonical JSON snapshots
and an XLSForm-style table projection with full
source/projection consistency checks. It preserves supported definitions and
mapping configurations, not all C4 records. The current strict binary adapter
(ADR 0018) wraps that profile in deterministic XLSX bytes with literal text cells,
bounded ZIP/XML input and fail-closed unsupported-feature checks, answering note 40.
General edited-XLSForm import and Salesforce persistence remain before C10.10.
This unit creates no org and changes no workflow, harness, namespace or dependency.
Note 39's reviewer authorization, no-store/header protections and collector-denial
test are recorded in ADR 0016 and remain due at the first delivery unit.

The current target-schema validator (ADR 0019) is a pure bridge toward publication.
It recomputes object, field, access, record-type, lookup, external-ID and stamp
checks from a caller-supplied normalized snapshot and does not trust saved Match
Status. A future Salesforce adapter must obtain fresh Describe data as the tenant
integration user before note 34 can close. ADR 0020 adds pure
source/transform/target datatype checks and active-value checks for base restricted
picklists. Length, precision, record-type-specific picklists, executable transforms,
JavaRosa validation, immutable storage and CLI/API publication remain open. This
unit claims no C10 acceptance test or Phase 1 gate.

The current bounded publication unit (ADR 0021) normalizes uncached integration-user
REST Describe responses with exactly one injected request per distinct target
object and bounded, non-disclosing failures. It does not own OAuth, tenant tokens,
API-version selection, mapping-derived target acquisition, immutable artifacts or
CLI publication. Note 34 remains open until the concrete authenticated adapter and
refusing publisher are reviewed together.

The current preflight unit (ADR 0022) validates form and mapping inputs before I/O,
compiles deterministic XML, derives and deduplicates every mapping target, loads a
fresh ADR 0021 snapshot and runs ADR 0019/0020 validation against detached inputs.
It returns a frozen in-memory candidate and exact request count, not an immutable
stored publication or publish success. The concrete authenticated transport,
JavaRosa validation, transform execution, lifecycle/persistence and CLI/API command
remain future work. Note 34 therefore advances but stays open, and no C10 test is
claimed.

The verified package unit (ADR 0023) combines canonical authoring JSON, deterministic
XLSX, exact XForm XML, the normalized target snapshot, warnings and component hashes
under one bounded canonical JSON digest. Package target names use canonical Describe
response spelling, answering note 51 at this boundary. The immutable string is not
durable storage or publish success. Transactional persistence, lifecycle/audit,
automatic JavaRosa validation and CLI/API publication remain future work; the
deadline-enforcing authenticated transport required by notes 34 and 52 is also not
added. No C10 test or Phase 1 gate is claimed.

The current automatic-validation unit (ADR 0024) makes package success conditional
on the exact package XForm passing the reviewed ODK Validate 1.20.0 JAR. The concrete
adapter requires explicit tool paths, verifies and snapshots the pinned JAR bytes,
runs without a shell under heap/time/output/environment bounds, discards output and
fails closed if cleanup does not complete. It commits or downloads no JAR and is not
Collect/Enketo runtime evidence. Persistence, lifecycle/audit, authenticated bounded
Describe transport and CLI/API publication remain future work. Notes 34/36/37/39
remain open, note 53 remains informational, and no C10 or Phase 1 gate is claimed.

The current Describe-transport unit (ADR 0025) turns the injected ADR 0021 callback
into a concrete API 64.0 HTTPS request boundary with strict origin/path construction,
fresh caller-supplied tokens, no redirect/retry/cache behavior, bounded streamed JSON
and per-request plus publication-attempt deadlines. It implements note 52's network
deadline requirement without selecting or storing tenant OAuth credentials. Note 34
remains open until a tenant-bound authenticated connection, definition reader and
refusing publisher are composed and reviewed. No Salesforce metadata, dependency,
workflow, harness, Enketo or Android boundary changes in this unit.

The current definition-snapshot unit (ADR 0026) implements ADR 0011's narrow
definition-only View All policy for Integration and Supervisor and adds an internal
`with sharing`, user-mode reader for one bounded Form Version graph. Salesforce
IDs are resolved internally and replaced with deterministic snapshot identities
before the existing compiler/mapping shapes are returned. It adds no external
endpoint, OAuth selection, credential storage, lifecycle mutation or publication
write. Note 24 closes only after real-org effective-access verification; note 34
advances through definition loading but remains open for the authenticated refusing
publisher and its remaining connection requirements. No C10 test is claimed.

The current publication-lifecycle unit (ADR 0027) adds an internal user-mode,
savepoint-backed commit for a validated package digest and two already-uploaded
caller-owned Files. It atomically links artifacts, records audit metadata, advances
one current Published version, supersedes the prior one and freezes the complete
published definition graph. Exact retries are no-DML and mismatches refuse. It adds
no external endpoint, OAuth selection, artifact upload/delivery, target write or
CLI, so notes 34 and 39 remain open and no C10 test is claimed.
