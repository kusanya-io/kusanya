# Salesforce scaffold

Phase 0 contains SFDX source, a Developer scratch definition and a runtime identity
smoke test. It implements no collection, mapping, authentication or C10 capability.

From the repository root in PowerShell, using an already authorised Dev Hub:

```powershell
$env:KUSANYA_DEV_HUB = 'Kusanya-DevHub'
node scripts/verify-salesforce.mjs
```

On Linux/macOS use `KUSANYA_DEV_HUB=Kusanya-DevHub node scripts/verify-salesforce.mjs`.
The script creates a unique one-day scratch org, deploys `salesforce/force-app`,
runs all local Apex tests, enforces >=85% measured executable-line coverage and
deletes only the confirmed org it created. An absent or non-Dev-Hub alias fails
before creation. Failed tests, missing coverage and failed cleanup are errors.
It prints the generated scratch alias for manual cleanup after a creation timeout;
any uncertain creation expires after one day. It never selects a default target.

API 64.0 is a conservative metadata baseline. Namespace is empty because package
format and registration are deferred. The brief's `ksny` prefix remains subject
to an availability check and ADR; no package Id is claimed. Every Apex class carries
a responsibility header. The smoke test checks the version and zero SOQL/DML.

CI's `salesforce-verify.yml` automatically requests protected-environment approval
for same-repository PRs. Configure `salesforce-ci` reviewers, allowed refs and its
Dev Hub secret, then require `Salesforce verification gate` on main, following
[the CI runbook](../docs/ci.md). An immutable reviewed harness runs against separately
checked-out PR metadata. Approvers must inspect the workflow as well as the exact
source SHA. Fork changes need a reviewed same-repository PR; manual dispatch from
main remains available once the workflow lands there. Never paste auth URLs in
source, issues, chat or terminal output. Missing configuration is not passing Apex.
