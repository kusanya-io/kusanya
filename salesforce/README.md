# Salesforce source

Phase 0 supplies the Developer scratch definition and runtime smoke test. The first
Phase 1 slice added Folder, Form and Form Version with version identity/validation.
The subsequent units added the complete definition graph and its bounded portable
snapshot reader. ADR 0027 adds an internal, user-mode publication commit that binds
two caller-owned Salesforce Files and the canonical package digest atomically,
then freezes the published source graph. ADR 0031 additionally pins the exact
ContentVersion IDs. Salesforce itself refuses direct version deletion before Apex;
Kusanya guards block deletion of pinned documents and unlinking of committed
artifacts. It does not hash the uploaded bytes, expose an endpoint, choose OAuth
credentials, upload artifacts, execute mappings or claim C10. See
[the data model](../docs/data-model.md) and ADRs 0009/0010/0013 for exact limitations.

Question tree updates validate the entire affected version and protect partial-DML
outcomes. Detach children before changing container roles or reversing parent edges.
Keep once-only questions as siblings of a repeat, not its children; keep author
annotations in Author Notes, never Hint. Inline lists use question -> owned list
-> question backlink creation; ownership cannot be reassigned. See the data model
for the reverse unlink/delete sequence and deferred lifecycle protections.
The three Question self-lookups omit metadata delete restrictions: Salesforce
rejects Restrict on self-lookups (finding 26). A before-delete guard protects
direct Question batches with outside question dependants. Two additional probes
protect Mapping/Field Mapping references (three fixed queries, no DML).
Form/Form Version cascades bypass it; the deletion tests cover that
platform distinction and partial-DML retries. Source conversion is not a deploy
test. Published/Superseded definitions are now protected by ADR 0027;
submission-aware retention and draft recovery remain deferred.

Form and direct Form Version deletion first remove only their target-owned skip
rules (one query, at most one all-or-none child delete), then allow the native
detail cascade. This preserves Source Question Restrict on direct question
deletion; failed owner deletion must roll back that cleanup. The synthetic owner
tests cover rollback, partial deletion, sibling isolation and a 200-Form batch.
Inline-list cleanup and published/submission-aware deletion remain future work.

Mapping parents form a same-version acyclic graph; a reference may parent multiple
repeats without a main mapping. Field Mapping explicitly selects a question or
constant, including a blank constant. Once-only questions outside a repeat can be
shared by repeat mappings. Target names/Record Type DeveloperNames are portable
configuration, not validated target access; transforms and stamps are not executed.
See ADR 0013 for partial-write staging, direct deletion and compiler responsibilities.

The unassigned Admin/Integration/Supervisor permission sets cover nine definition
objects while preserving ordinary sharing and no View All grants. They do not yet
allow cross-owner definition reads. ADR 0011 records the decision and required
future reviewed implementation/effective-access tests before a Phase 2 reader
(Claude note 24); ADR 0013 explicitly extends that future allowlist and tests to
the two mapping objects without implementing the grants.

## Iterative development only

From the repository root in PowerShell, after the maintainer reserves capacity and
authorizes use of the local development Dev Hub:

```powershell
$env:KUSANYA_DEV_HUB = 'Kusanya-DevHub'
node scripts/builder-org.mjs status
```

ADR 0012 records Claude's local-tool approval of the Windows argument-quoting
correction at `e6720e9411a22246ccf005fcd2b61b31d33195dc`
([PR #9 comment 5664197630](https://github.com/kusanya-io/kusanya/pull/9#issuecomment-5664197630)).
Approval covers only `builder-org.mjs status`, `acquire` and `release` under Bill's
one-development-org authorization, not hosted CI approval or finding 26 closure.
Windows arguments must not end in a backslash; omit a trailing directory separator
or use `/`. Workflow and harness pin are unchanged. Pre-existing working-directory
executable discovery remains deferred hardening (Claude note 29; ADR 0012).

`acquire` creates or returns the one owned, seven-day development org; `release`
deletes only the positively owned org. `status` inspects without allocating. Never
create a second builder org or share its receipt across machines. Pending creation
must be reconciled before another allocation. The tool refuses CI execution and
the CI environment secret. Its state contains ownership metadata, not credentials,
and remains under ignored `work/`. Use only synthetic development data.
Use one designated builder checkout per Dev Hub: its lock is local, not distributed.
If an ambiguous request has no visible server record, the receipt stays pending
until private operator reconciliation; the tool never clears it to retry blindly.
Only a recognized quota rejection with a proven absent request can retire that
unsuccessful intent for a later explicit acquire.

Development output is not verification evidence. Do not put it in a verification
request. No builder org may be created until the reserved Phase 0 CI and verifier
runs have finished. Do not deploy into the Dev Hub itself or a customer org.

## Fresh verification

The builder's Apex evidence is the hosted CI run on the exact PR head. Do not run
another fresh local builder verification. Claude uses its own independent commands
and one fresh org per final relevant head, not one per test.

The pinned `scripts/verify-salesforce.mjs` requires `KUSANYA_DEV_HUB`,
`KUSANYA_VERIFY_ROLE`, `KUSANYA_RUN_ID` and `KUSANYA_HEAD_SHA`. Hosted CI sets role
`ci`, a GitHub run/attempt ID and the reviewed full SHA. `KUSANYA_SALESFORCE_DIR`
selects the reviewed source directory, not an existing org. No command-line or
environment target-org override is accepted.

The harness checks capacity, creates unique tagged one-day orgs, deploys
`salesforce/force-app`, runs all local Apex tests, enforces >=85% exact executable
line coverage and cleans only positively owned orgs. It never selects an existing
target. Quota shortage is `BLOCKED` (exit 75), not a test pass or skip. Tests,
coverage, unknown failures and cleanup errors fail the run. Creation timeouts need
exact job/tag reconciliation. See the CI runbook for retry and cleanup restrictions.
Apex test classes must not use `@TestSetup` while the gate requires exact equality
between the summary test count and the detailed result rows.

Pair-acquisition unit tests prepare for C10 test 14. The existing runner deploys
the complete reviewed source and runs all local Apex tests, including the new
model tests, in one org. No tenant acceptance test is claimed.

Hosted verification also persists safe ownership intents at the fixed
`RUNNER_TEMP/kusanya-scratch-intents.json` path before allocation. The trusted
`cleanup-salesforce.mjs` always-run step uses that journal only for the exact
authenticated CI run/attempt, after the bounded verification step fails or is
cancelled and before logout. Successful verification already confirmed primary
cleanup and skips this fallback. It is not a manual target-org deletion tool or a verifier-org selector.
Pending/unknown requests still need private reconciliation; runner loss can prevent
the finalizer. See ADR 0006 and `docs/ci.md` for limits and the cleanup contract.

API 64.0 remains the metadata baseline. `ksny` is registered, but Dev Hub linking
is blocked by the locked connected-app PKCE setting. Bill's Option 2 explicitly
permits initial Phase 1 source with `"namespace": ""`; no source/configuration
switch or package creation is authorized here. Apex and metadata use local API
references without a hard-coded namespace. Empty-namespace Apex and synthetic
prefix fixtures do not establish namespaced behavior. Once linking works, the
suite must run namespaced before the next phase gate (ADRs 0006/0008).
Every Apex class carries a responsibility header. The original smoke test still
checks runtime version and zero SOQL/DML; model tests use only synthetic data.

CI's `salesforce-verify.yml` automatically requests protected-environment approval
for same-repository PRs. Configure `salesforce-ci` reviewers, allowed refs and its
Dev Hub secret, then require `Salesforce verification gate` on main, following
[the CI runbook](../docs/ci.md). An immutable reviewed harness runs against separately
checked-out PR metadata. Approvers must inspect the workflow as well as the exact
source SHA. The required check is a tripwire, not a security boundary: PRs can edit
its YAML. Changes to the gate, guards, triggers, harness pin and verification code
block merge without explicit Claude review and real exact-head evidence. The
approved narrow docs-only exemption is not evidence that Apex executed.
Fork changes need a reviewed same-repository PR; manual dispatch from
main remains available once the workflow lands there. Never paste auth URLs in
source, issues, chat or terminal output. Missing configuration is not passing Apex.
