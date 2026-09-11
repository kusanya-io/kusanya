# CI and scratch-org verification

## Public PR checks

`.github/workflows/ci.yml` runs root formatting, source metadata checks and coverage
parser tests, then service lint/typecheck/unit/integration tests with disposable
PostgreSQL 17. It also builds and tests the service container and builds the runtime
image. All jobs use GitHub-hosted Ubuntu and no Salesforce/hosting credentials.

The database credential in this job is synthetic, used only by that ephemeral test
database. Real environment credentials must never enter this workflow.

## Development versus verification

Bill approved ADR 0006 after Claude's A1–A11 review. Inexpensive checks run before
org allocation. Iterative development can use one builder-only, seven-day scratch
org managed by `scripts/builder-org.mjs`; its output is never verification evidence.
Do not create that org until the reserved Phase 0 CI/verifier runs finish.

The builder's Apex evidence is the hosted run on the exact PR head. It does not
create another fresh local org for evidence. Claude independently uses its own
commands against one fresh org (a pair when test 14 requires it) per final relevant
head, not per test. Design/security reviews and intermediate heads use no orgs.

The fresh harness has no existing-target option or development-org fallback. It
requires explicit Dev Hub, role, run ID and full head SHA, creates unique one-day
orgs, tests the complete applicable suite and cleans up only positively owned orgs.
Use `salesforce/README.md` for the development tool and fresh-run identity contract.

### Finding 10: a required check is a tripwire, not a boundary

The PR controls the YAML defining `Salesforce verification gate`. It can edit that
job to return success without running Apex; that job has no environment approval.
Requiring the check catches ordinary failures, not malicious edits to the check
itself. With one GitHub account holding every role, its green status cannot prove
independent approval. CODEOWNERS or the shared reviewer identity cannot repair this.

**Any change to the gate, triggers, guards, harness pin, `verify-salesforce.mjs`,
`apex-coverage.mjs` or their client, lifecycle, exemption and retry dependencies
blocks merge unless Claude explicitly reviewed it.** Bill approves only the exact
head cleared for credential use. Claude's PASS must cite the actual Apex run ID,
confirm execution on that exact head, and include coverage and scratch cleanup.
An approved documentation exception must say Apex was not run, not invent evidence.
The builder never approves its own run or merges its own PR.

### Maintainer setup

1. Create environment `salesforce-ci` in GitHub repository Settings → Environments.
   Set a required human reviewer and disable administrator bypass. Enable prevention
   of self-review when builder and reviewer use distinct GitHub accounts. If both
   use Cobitech's account, GitHub cannot distinguish the human from the builder;
   Bill must approve manually and the builder must never approve its own run.
2. Set selected deployment branches to `main` and `refs/pull/*/merge`. GitHub matches
   these against the event's ref; a main-only restriction prevents PR runs.
3. Provision the approved CI-only Dev Hub, verify its ownership and scratch
   allocations, then add `SF_DEV_HUB_AUTH_URL` only as an **environment secret**
   through a private operator session. Do not use the builder/verifier hub for
   steady-state CI. The new hub and secret migration are separate authorized
   operator steps, not effects of this code change.
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

Opening, reopening, updating or marking a PR ready for review automatically runs
the policy check. Draft status alone does not suppress these events. There are no
workflow path filters that leave the required check absent. The protected Apex job
waits for Bill's approval only when the complete PR is not documentation-exempt.
Bill approves only the latest head marked READY; batch fixes before approval.
The job checks the live PR
repository, target, open state and exact head; it rechecks the actual checkout and
live head immediately before auth and rejects a head changed during testing.

The workflow pins policy and harness code to an immutable source commit, separate
from the PR metadata checkout. Inspect the exact pin in the workflow and the source
at that commit. A proposed replacement pin is not permission to run it: Claude must
review it before Bill approves its first credentialed execution. This bootstrap
does not require merging the PR. No PR-head JavaScript/npm script executes in the
credentialed job. Approval still requires inspection of YAML and its dependencies.

Authentication pipes the environment secret directly to the pinned CLI with
`--sfdx-url-stdin -`. The explicit `-` is required: without it the CLI can consume
the following `--alias` flag as the stdin option's value and reject the command.
Raw CLI output stays suppressed on both success and failure. Authentication JSON
stdout is captured only in an unexported shell variable, never an artifact, cache
or file; stderr remains discarded. On failure, a real JSON parser permits only an
exact top-level `name` from this allowlist: `ENOTFOUND`, `ETIMEDOUT`, `ECONNRESET`,
`ECONNREFUSED`, `EAI_AGAIN`, `invalid_grant`, `INVALID_SFDX_AUTH_URL`,
`AuthDecryptError`, `RequestError`. Anything else, including malformed JSON or
non-object output, reports `unrecognized`. Messages, nested data, URLs, instances
and parser diagnostics are never printed; success remains silent. The captured
variable is cleared before reporting. Never print an auth URL to diagnose a run.
A failed authentication run supplies no Apex evidence, and an error class alone
is not a reason to rotate the secret. See finding 20 in ADR 0006.

The Apex job serializes across all PRs using the CI hub, without cancelling an
active scratch lifecycle. A replaced pending run has consumed no org; its skipped
or cancelled job is not passing evidence. A changed head needs fresh approval;
the older active run cleans up then fails its stale-head check.
Failures, missing coverage, <85% coverage and cleanup errors fail the Apex job. The
separate, unconditional `Salesforce verification gate` also fails if Apex was
skipped, cancelled or unsuccessful. Confirm the exact SHA and retain real scratch
coverage/run evidence for Claude's gate report. Builders never merge their own PRs.

### Strict documentation-only exception

Bill approved this narrow C13 deviation in ADR 0006. The policy helper inspects the
complete PR diff at the exact head, not just the most recent commit. It checks all
pages, both rename/deletion paths, regular-file modes and text content. Its positive
allowlist contains root README, contribution/code-of-conduct Markdown, and ordinary
`docs/` Markdown. The brief, verification protocol, CI runbook, threat model and ADRs
are excluded and still require Apex and explicit verifier review.

Code, service/mobile files, scripts, workflows, manifests, lockfiles, runtime
configuration, `docs/openapi.yaml`, unknown paths, binary or non-regular files are
not exempt. Incomplete/ambiguous evidence requires full Apex, never an exemption.
An exempt check explicitly reports `Apex not run—approved documentation-only
exemption` for the exact head. This result cannot close a phase's Apex requirement.
PR #3 is not exempt. Main's required check is still present for exempt PRs.

### Quota, retries and cleanup

Read-only preflight checks both active and daily capacity before creation. Daily
capacity is a daily allocation, not a rolling 24-hour window; deleting an org frees
active capacity, not daily capacity. The observed reset time is still unconfirmed
(issue #5 note 16). `BLOCKED` exits 75 with limit/remaining/required counts and
`next UTC slot unavailable`. Never infer a reset by adding 24 hours to creation
timestamps or assume midnight Pacific. Preflight uses live limits without querying
creation history; any future reset forecast needs independently confirmed ADR evidence.
Malformed limits and failed queries fail closed. A race can still exhaust quota
after preflight: recognized limit errors receive the same blocked treatment.
The gate fails for BLOCKED; it never skips or substitutes the development org.

Use one fresh org per whole suite, or acquire a complete pair before test 14 starts.
If the second allocation fails, clean the first immediately. Pair-lifecycle fixture
tests are not evidence that the product's two-tenant acceptance test is implemented.

No automatic retries occur. The read-only GitHub budget check inspects all attempts
for this workflow/head, across run IDs. Allow at most one explicitly requested
infrastructure recovery per head per UTC day; capacity recovery consumes that
retry budget and must pass preflight again. Test/coverage failures need a new fixed
head. A successful head is not rerun for duplicate evidence. Unknown outcomes,
incomplete logs and failed cleanup require investigation, not presumed permission.
The early policy check is repeated inside Apex, after approval and its exact-head
recheck, immediately before authentication. Partial reruns cannot reuse the early
job's permission, and the current UTC admission date is recomputed. The reader must
finish within its bounded step or fail closed without authentication. Completed
zero-step skipped/cancelled Apex jobs with valid run/attempt/head identity never
allocated an org; the reader does not request their unavailable logs. Other jobs
do not get that zero-allocation exemption.

Finding 19 adds a distinct, counted pre-verification failure: a validated completed
failed Apex job with exactly one completed, skipped step named
`Verify reviewed metadata using only trusted harness code` is
`failed-infrastructure`, `retryable: true`. The harness never ran, so an outcome
marker cannot exist. The reader uses Jobs API evidence without a log for PR runs,
counts the attempt against the existing daily budget, and still needs Bill's
explicit approval for any retry. It never makes the failed gate green. Missing,
duplicate, incomplete or non-skipped verify steps retain the marker requirement;
contradictory completion is refused.

For executed verification, only a unique, sanitized harness marker matching
run/attempt/head establishes the previous outcome. Both the marker and step-based
exception are subject to finding 10's explicit-review rule.
Manual dispatch uses main's workflow SHA, so history is enumerated without a SHA
filter and its reviewed head is bound by the trusted `Verifying PR ... at head ...`
log line, including pre-verification failures. The trusted harness's actual start
timestamp determines the UTC retry day when verification ran. For the skipped
verify exception only, there is no harness timestamp: use the validated completed
job's UTC `started_at`. Workflow queue time is never used. Unidentified legacy
dispatches or missing required logs fail closed and need investigation; they are
not silently excluded. The history reader caps at
1,000 workflow runs and refuses incomplete history rather than resetting budget.

Tag each disposable org with role, run ID, short head SHA and a unique suffix.
Reconcile creation timeouts by exact job ID or tag before another create. Delete
only positively owned orgs. A janitor must additionally establish that its own
role's run has ended; never delete another role's org or one with unknown/live
status. Failed cleanup fails the run. Never cache org authentication or raw CLI
output in GitHub artifacts.

`runJanitor` in `scripts/scratch-lifecycle.mjs` is a tested, default-dry-run helper,
not a scheduled service or ready-made administrative CLI. Its caller must supply
authoritative ended-run evidence for the requested role before explicitly applying
cleanup. A pending/unknown creation result requires private reconciliation of its
exact logged tag; this PR does not automate that operator investigation.

The dedicated CI hub is approved but not provisioned by this PR. Until migration,
CI and Claude coordinate the shared hub using live allocations and reserve recovery
capacity. The original 11 September slot estimates were withdrawn in issue #5 note 16. Phase 0 CI and independent runs are complete; this hardening work consumes no
builder org. Check actual limits before each authorized fresh run.

### Timeout recovery and truthful failures (issue #5)

The Apex job stays at 45 minutes. Its explicit step deadlines total 40, retaining
five minutes of slack: 20 for verification, five for recovery cleanup, one for
logout, and 14 for the other bounded steps. Each creation/deploy/test wait is five
minutes. The CLI adapter bounds those direct processes to six minutes and other
calls to 30 seconds. A killed CLI does not prove its remote request stopped, nor
does killing Windows' `cmd.exe` wrapper guarantee all descendants were killed.

The harness creates a private journal at
`RUNNER_TEMP/kusanya-scratch-intents.json`, recording only this run's identity and
exact tag intents before allocation. No credentials, usernames or raw results
enter it; no artifact/cache uploads it. Existing, malformed, off-run or symlinked
journals fail closed. Creation cannot start until its intent was persisted.

The primary `finally` cleanup remains. An additional pinned `always()` step runs
`node trusted/scripts/cleanup-salesforce.mjs` only after authenticated verification
failed or was cancelled. It does not run after success: the harness has already
confirmed primary cleanup before emitting its passed marker (finding 17). This
avoids a redundant remote read failing a successful job or contradicting that marker.
It requires GitHub's
current CI run ID and attempt to match the journal, revalidates every allowed tag
and remote org ID, and deletes only this attempt's positively owned orgs. Already
deleted orgs are a no-op. It accepts no existing-target input or cross-run selector.
It runs before Dev Hub logout and does not turn a failed verification into success.

Initial journal admission failure is `JOURNAL_UNAVAILABLE`, reported as
`failed-infrastructure` with `retryable: false` (note 18), since this invocation has
not allocated an org. It still blocks the gate. Later journal persistence failures
or recovery reads remain reconciliation/cleanup failures; this change grants no
retry or permission to ignore an existing journal.

Confirmed provider creation rejection with no org reports nonretryable
`failed-creation-rejected`, not a fictitious cleanup failure. The classifier uses
the narrow `RemoteOrgSignupFailed` case from
[Salesforce core](https://github.com/forcedotcom/sfdx-core/blob/main/src/org/scratchOrgErrorCodes.ts)
plus an exact remote read; a terminal Error record must explicitly have no org.
Recognized quota rejection remains `BLOCKED` (75). Unknown errors, pending requests
and absent timeout records are not rejection evidence; they require reconciliation.
Real quota-error classification is not claimed live-tested by synthetic fixtures.
Do not consume capacity to manufacture a quota rejection.

The fallback fails if the journal is missing or ambiguous, or cleanup cannot be
confirmed. Total runner loss/force cancellation may prevent all cleanup steps;
privately reconcile the logged ownership tag before another attempt. This current
attempt finalizer does not pretend the whole job is ended, and does not expand the
separate ended-run janitor's authority. ADR 0006 records these decisions; ADR 0007
records Bill's limited Phase 0 deferral. Issue #5 stays open until Claude verifies.

Run `actionlint` with an installed ShellCheck executable, not `-shellcheck=`.
For example, when both are on PATH: `actionlint -shellcheck shellcheck`.
CI policy/harness/workflow changes require Claude's explicit security review before
Bill approves their first Salesforce execution, even when public fixtures pass.

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
actual inline Bash guards using synthetic GitHub/Git/Salesforce responses. They
cover valid PR/dispatch inputs, forks, stale SHA, mismatched checkout, invalid inputs,
authentication arguments/stdin, missing credentials, allowlisted error names,
suppression of synthetic credentials in both CLI streams, malformed/nested output and
the final fail-closed gate. Windows resolves Bash from the Git for Windows root's
`bin` or `usr/bin`, including when Git Bash exposes `mingw64/bin/git.exe` first.
Resolver fixtures also run on Linux. These tests validate policy and command
plumbing only; they do not authenticate to Salesforce or replace hosted scratch
tests.

The policy, quota, lifecycle and development-tool tests use injected clients and
synthetic records. They create no Salesforce orgs and do not validate live quota,
authorization, creation, timeout recovery or cleanup. Those require independent
review followed by real hosted execution when capacity is available.

See ADRs 0005 and 0006 for Bill's approval and the security trade-offs. GitHub documents
[environment approval and ref rules](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
and [skipped/required checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks).

## Phase 0 reporting

No C10 tests are assigned to Phase 0. Report foundation checks and coverage with
their actual outcomes. The verifier alone records a gate verdict in
`docs/verification-log.md`. An unavailable Docker daemon or missing hosted CI run
must be stated as unverified, not replaced by a unit-test pass.
