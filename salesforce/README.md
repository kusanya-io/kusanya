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

CI's `salesforce-verify.yml` must first exist on the trusted default branch. Configure
required reviewers and the Dev Hub secret on environment `salesforce-ci`, following
[the CI runbook](../docs/ci.md). Only trusted harness code runs locally with the
credential; the reviewed PR supplies Salesforce metadata. Never paste auth URLs in
source, issue comments or terminal output.
