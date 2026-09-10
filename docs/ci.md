# CI and scratch-org verification

## Public PR checks

`.github/workflows/ci.yml` runs root formatting, source metadata checks and coverage
parser tests, then service lint/typecheck/unit/integration tests with disposable
PostgreSQL 17. It also builds and tests the service container and builds the runtime
image. All jobs use GitHub-hosted Ubuntu and no Salesforce/hosting credentials.

The database credential in this job is synthetic, used only by that ephemeral test
database. Real environment credentials must never enter this workflow.

## Salesforce gate

The builder and verifier can run locally from the root:

```powershell
$env:KUSANYA_DEV_HUB = 'Kusanya-DevHub'
node scripts/verify-salesforce.mjs
```

The CLI must already have an authorised Dev Hub. Authentication is an operator task;
do not extract or print auth URLs. Use only a dedicated Kusanya Dev Hub. The script
creates and cleans up its own one-day scratch org. Never point source deployment at
a production org. See `salesforce/README.md` for timeout and cleanup behavior.

For hosted validation, maintainers must first:

1. Review and bootstrap the trusted workflow/harness onto main through the normal
   independent-review process. A new dispatch workflow cannot run before it exists
   on the default branch; local Apex evidence remains distinct during bootstrap.
2. Create environment `salesforce-ci`, require maintainer approval, restrict it to
   the default branch and store `SF_DEV_HUB_AUTH_URL` only as an environment secret.
   Do not place it in repository-wide secrets or an unprotected environment.
3. Review a same-repository PR's exact full SHA, then use Actions → Salesforce
   verification → Run workflow from main, with its PR number and reviewed SHA.
4. Confirm the reported SHA still matches the PR at review/merge time. A new push
   requires review and another run. Record the run link and coverage in the review.

The job rejects fork source and dispatch from a non-default branch. Missing auth,
failed tests, missing coverage, <85% coverage or cleanup failure fails validation.
It checks out trusted harness code and reviewed metadata separately. The Dev Hub
credential is never passed as a command argument or emitted as an artifact.

No automatic Salesforce result is attached to the PR by the manual dispatch. A
maintainer must inspect that run; the public CI badge is not the complete gate.
Configure branch protection to require public CI and independent review, and retain
the Salesforce result in the verification log. Builders never merge their own PRs.

## Phase 0 reporting

No C10 tests are assigned to Phase 0. Report foundation checks and coverage with
their actual outcomes. The verifier alone records a gate verdict in
`docs/verification-log.md`. An unavailable Docker daemon or missing hosted CI run
must be stated as unverified, not replaced by a unit-test pass.
