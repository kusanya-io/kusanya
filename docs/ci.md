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

### Maintainer setup

1. Create environment `salesforce-ci` in GitHub repository Settings → Environments.
   Set a required human reviewer and disable administrator bypass. Enable prevention
   of self-review when builder and reviewer use distinct GitHub accounts. If both
   use Cobitech's account, GitHub cannot distinguish the human from the builder;
   Bill must approve manually and the builder must never approve its own run.
2. Set selected deployment branches to `main` and `refs/pull/*/merge`. GitHub matches
   these against the event's ref; a main-only restriction prevents PR runs.
3. Add `SF_DEV_HUB_AUTH_URL` only as an **environment secret**, using the dedicated
   Kusanya Dev Hub's SFDX authorization URL through a private operator session.
   Never paste it into chat, issues, PR comments, logs or a repository file. Do not
   use a customer org credential or a repository-wide secret. Add the secret only
   after the environment protections are configured.
4. Approve a run after inspecting its exact source SHA, workflow YAML and Salesforce
   metadata. Approval releases the credential; the source-repository guard alone
   does not protect against a malicious change to the workflow itself.
5. After a real successful run, require these GitHub Actions checks on main:
   `Scaffold and lint`, `Service and container tests`, and
   **`Salesforce verification gate`**. Preserve existing protections and independent
   review. Do not require only `Scratch org tests and 85 percent coverage`: it is
   conditional and a skipped job can otherwise appear successful.

These settings are maintainer operations, not effects of committing YAML. An
environment referenced before it is configured can be created by GitHub without
protections; do not put a secret there until steps 1–2 are complete. Missing secrets
must fail validation, not be treated as skipped/passing Apex.

### Automatic same-repository PRs

Opening, reopening, updating or marking a PR ready for review automatically requests
an Apex run. There are no path filters: documentation-only PRs also request the gate.
The protected environment waits for Bill's approval. The job checks the live PR
repository, target, open state and exact head; it rechecks the actual checkout and
live head immediately before auth and rejects a head changed during testing.

The harness is pinned to `7974e25e8fa5855ca015bf01123282b744367f2e`, inspected during
Claude's initial PR #3 review. This avoids merging the first PR just to obtain a
trusted harness. Salesforce metadata is checked out separately at the PR head; no
PR JavaScript or npm scripts run in the credentialed job. A harness update requires
an explicitly reviewed pin change. Approval still requires inspection of YAML.

Runs serialize per PR without cancelling an active scratch lifecycle. A changed
head queues a fresh run; the older run cleans up then fails its stale-head check.
Failures, missing coverage, <85% coverage and cleanup errors fail the Apex job. The
separate, unconditional `Salesforce verification gate` also fails if Apex was
skipped, cancelled or unsuccessful. Confirm the exact SHA and retain real scratch
coverage/run evidence for Claude's gate report. Builders never merge their own PRs.

### Fork contributions and manual dispatch

Fork PRs never automatically enter the credentialed job. Their final gate fails
instead of treating skipped Apex as success. A maintainer reviews the fork changes
and stages them in a **same-repository PR** for testing and eventual merge. Do not
bypass the gate to merge a fork directly.

Keep Actions → Salesforce verification → Run workflow for an explicitly reviewed
same-repository PR number and full head SHA. Dispatch is accepted only from main;
the workflow must be on main before this manual entry point is available. It can
validate staged fork contributions or provide additional operator evidence. Its
check is attached to the dispatched main commit, not the fork/PR head, so it is not
a substitute for the automatic PR check. Direct fork merging would require a
separately reviewed trusted status publisher; no write-token permission is added.

### Workflow policy regressions

`npm test` includes `scripts/salesforce-workflow.test.mjs`. These tests execute the
actual inline Bash guards using synthetic GitHub/Git responses. They cover valid
PR/dispatch inputs, forks, stale SHA, mismatched checkout, invalid inputs and the
final fail-closed gate. Windows uses Bash from Git for Windows. These tests validate
policy only; they do not authenticate to Salesforce or replace hosted scratch tests.

See ADR 0005 for Bill's approval and the security trade-offs. GitHub documents
[environment approval and ref rules](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
and [skipped/required checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks).

## Phase 0 reporting

No C10 tests are assigned to Phase 0. Report foundation checks and coverage with
their actual outcomes. The verifier alone records a gate verdict in
`docs/verification-log.md`. An unavailable Docker daemon or missing hosted CI run
must be stated as unverified, not replaced by a unit-test pass.
