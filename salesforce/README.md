# Salesforce scaffold

Phase 0 contains SFDX source, a Developer scratch definition and a runtime identity
smoke test. It implements no collection, mapping, authentication or C10 capability.

## Iterative development only

From the repository root in PowerShell, after the maintainer reserves capacity and
authorizes use of the local development Dev Hub:

```powershell
$env:KUSANYA_DEV_HUB = 'Kusanya-DevHub'
node scripts/builder-org.mjs status
```

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

Pair-acquisition unit tests prepare for C10 test 14; the Phase 0 runner and source
still implement only the one-org smoke suite. No tenant acceptance test is claimed.

Hosted verification also persists safe ownership intents at the fixed
`RUNNER_TEMP/kusanya-scratch-intents.json` path before allocation. The trusted
`cleanup-salesforce.mjs` always-run step uses that journal only for the exact
authenticated CI run/attempt, after the bounded verification step fails or is
cancelled and before logout. Successful verification already confirmed primary
cleanup and skips this fallback. It is not a manual target-org deletion tool or a verifier-org selector.
Pending/unknown requests still need private reconciliation; runner loss can prevent
the finalizer. See ADR 0006 and `docs/ci.md` for limits and the cleanup contract.

API 64.0 is a conservative metadata baseline. Namespace is empty because package
format and registration are deferred. The brief's `ksny` prefix remains subject
to an availability check and ADR; no package Id is claimed. Every Apex class carries
a responsibility header. The smoke test checks the version and zero SOQL/DML.

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
