# Verification log

Every review and gate verdict, oldest first. Written by the verifier only. The protocol is in `docs/verification.md`.

## 2026-09-10: Review 1 of Phase 0, branch `phase-0/repository-scaffold`

- Commit reviewed: `72c6ccf8469f5621c9789f0ea80d24ba6f3c6cdc`
- Pull request: not yet published at review time (the builder's sandbox could not push). Findings will be posted as review comments once it exists.
- Brief sections claimed: C11 Phase 0; C2, C8, C12, C12a, C13 foundations.
- C10 acceptance tests claimed: none (Phase 0 has none assigned).

### What was run

| Check                                                                                                    | Result                                                                                                          |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Root tooling: `npm ci`, `format:check`, `npm test` (coverage gate tests), `check:scaffold`               | Pass; 7 of 7 tests, 0 vulnerabilities                                                                           |
| Service: `npm ci`, `lint`, `typecheck`, `npm test` (unit)                                                | Pass; 8 of 8 tests, 0 vulnerabilities                                                                           |
| Builder's scratch org script `scripts/verify-salesforce.mjs` against `Kusanya-DevHub`                    | Pass; 1 test, 2 of 2 lines covered (100%); org created and deleted                                              |
| Independent scratch org: create, deploy, `sf apex run test --code-coverage`, delete                      | Pass; `KusanyaRuntimeTest` 1 of 1, `KusanyaRuntime` 2 of 2 lines; the raw JSON also passes the builder's gate   |
| Container test image on `cobitech-edge` (Docker 29.7.2): build, unit tests inside the container          | Pass; 8 of 8                                                                                                    |
| Integration tests inside the container against a disposable `postgres:17`                                | Pass; 2 of 2 (real `SELECT 1` readiness, real driver timeout)                                                   |
| Runtime image: user and size                                                                             | User `node`; 83 MB                                                                                              |
| Production mode, `DATABASE_SSL=true` against a non-TLS Postgres                                          | `/healthz` 200, `/readyz` 503 `{"status":"unavailable"}`, `Cache-Control: no-store`; no URL or password in logs |
| Production mode, `DATABASE_SSL=false`                                                                    | Refuses to start with a message naming the setting, not its value                                               |
| Development mode, database up then stopped                                                               | `/readyz` 200, then 503 within 3 ms; `/healthz` stays 200                                                       |
| SIGTERM shutdown                                                                                         | Under 1 s                                                                                                       |
| Docker `HEALTHCHECK`                                                                                     | `healthy` after the start period                                                                                |
| Pinned action SHAs                                                                                       | `actions/checkout` = v4.4.0, `actions/setup-node` = v4.4.0, confirmed against upstream tags                     |
| `actionlint` 1.7.12 on both workflows                                                                    | Clean                                                                                                           |
| Dependency inventory `docs/dependency-licences.md` regenerated and formatted                             | Identical to the committed file; 213 entries; no GPL, none marked review required                               |
| Salesforce CLI flag `--sfdx-url-stdin` used by the Salesforce workflow                                   | Exists in CLI 2.135.7                                                                                           |
| ADR 0003 claims about the seed (two repeats capped at 20, `seed/xlsform/` empty, C10.2 wording)          | Confirmed against `seed/` and the brief                                                                         |
| ADR 0003 exclusions (PPI, mobile money, survey library, contact groups, client assignation, interviewee) | Match brief C4 and C12                                                                                          |
| Hosted GitHub Actions run                                                                                | Not run; the branch was not on GitHub at review time                                                            |

Everything disposable was removed afterwards: both scratch orgs, the server containers, network, images built for the review, and temporary folders. The `postgres:17` and `curlimages/curl` images were left on the server for reuse.

### Checks that do not apply in Phase 0

Collector stamp, no Salesforce user or sharing for collectors, API batching, tenant isolation, breakage with the seed forms, object and field descriptions, credential and token storage: no code touches these yet. Every Apex class carries a responsibility header. Nothing in the branch stores collector, submission or tenant data.

### Findings

1. **Must fix before the phase gate.** Apex tests do not run automatically on pull requests. `salesforce-verify.yml` runs only by manual dispatch from `main`, from an environment (`salesforce-ci`) and a secret that do not exist yet, so no required status check can ever gate Apex. Brief C11 Phase 0 asks for CI that runs Apex tests at 85 percent or better, and C13 says the suite runs on every pull request. The builder disclosed this under known gaps and in ADR 0004, so it is not a blocker, but the security argument in ADR 0004 is stronger than the facts: GitHub withholds secrets from pull requests opened from forks, and only maintainers can push branches to this repository. Recommended: run the Salesforce job on `pull_request` when the head repository equals this repository, make it a required check on `main`, and keep the dispatch path for fork contributions. Needs Bill's decision, and Bill must create the Dev Hub secret.
2. **Should fix before merge.** `scripts/publish-phase0.ps1` is a one-off script for publishing this branch from Bill's machine. It names people, switches the GitHub CLI account and never switches it back. It should not be part of the repository.
3. **Should fix before merge.** `docs/reviews/phase-0-pr.md` is a pull request description committed to the tree. It goes stale on merge, and it says the gate verdict is recorded in `docs/verification.md`; the correct file is `docs/verification-log.md`. Use it as the pull request body and drop it from the tree.
4. **Should fix.** `service/src/app.ts` maps every error to 500. A request body over `bodyLimit` returns 500 instead of 413 (reproduced with a 2 KB POST). OpenRosa clients rely on 413, 415 and 400 later. Preserve the error's status code when it is a 4xx.
5. **Note.** `docs/licences.md` says `upload-artifact` is pinned; no such action is used.
6. **Note.** `.prettierignore` excludes `service/`, so the service has a linter but no formatter.
7. **Note.** C12 decisions still due and listed in the roadmap: ODK Collect and Enketo versions, tenant OAuth flow, namespace prefix. The availability check for `ksny` must land before the first Phase 1 objects, because renaming afterwards is painful.
8. **Question for Bill, not a finding against the builder.** ADR 0002 chose Apache-2.0 for the service. C13 delegated the choice, but it is the option least protective of a future hosted offering: anyone may host Kusanya commercially without sharing changes. AGPL-3.0 is the alternative. Confirm or overturn before Phase 1.

### Verdict

`HOLD: PR phase-0/repository-scaffold (unpublished), 4 findings` (1 to 4; 5 to 7 are notes, 8 is a question).

Becomes `PASS` when: the branch is published and the hosted CI run is green; findings 2 and 3 are fixed; finding 4 is fixed or deferred with Bill's word. Finding 1 does not block the merge, because the Salesforce workflow must exist on `main` before it can run at all. It blocks the gate.

`PHASE 0: HOLD` pending finding 1 and a green hosted run.

### Addendum, same day: pull request #3 published, head `7974e25e8fa5855ca015bf01123282b744367f2e`

Two commits were added after the review: a quoting fix to the Postgres health command in `ci.yml` (the first hosted run failed on it), and the removal of `scripts/publish-phase0.ps1`, which closes finding 2. The reviewed code is otherwise unchanged, so the test evidence above stands.

- Hosted CI run 34485172831 on the head: both jobs green. Unit and integration tests ran four times (locally on the runner and inside the container): 8, 2, 8, 2 passed, none skipped.
- Findings posted as review comments on #3: 1, 3, 4 and notes 5 to 7. Finding 8 is Bill's call and was not posted.

`HOLD: PR #3, 3 findings` (1 blocks the gate, 3 and 4 block the merge).

`PHASE 0: HOLD` pending finding 1.

### Security review before releasing the Dev Hub secret, same day: head `5e5567fbeae6885eda29b86867c3bbbeadcbf1d8`

Scope: is it safe for Bill to approve Salesforce verification run 34487910391 (attempt 2, `pull_request` event, head 5e5567f), which releases the environment secret `SF_DEV_HUB_AUTH_URL` to the job? Bill had approved the automatic same-repository trigger recommended in finding 1.

What was checked:

- The whole workflow at the head, ADR 0005, the CI runbook, and the six policy tests that run the workflow's own shell guards.
- The pinned harness commit 7974e25: its `verify-salesforce.mjs` and `apex-coverage.mjs` are byte-identical to the scripts reviewed at 72c6ccf; the only difference is the removed publish script. They are unchanged at the head too.
- The `salesforce/` tree the credentialed job checks out: eight known files, no dotfiles, classes unchanged since 72c6ccf.
- The `salesforce-ci` environment through the API: required reviewer `cobitechsolutions`, administrator bypass off, branch policies `main` and `refs/pull/*/merge`, one environment secret, zero repository secrets.
- The pending run: `pull_request`, head 5e5567f, waiting on that environment, no approvals yet. Public CI run 34487911546 is green on the same head.
- Root tests at the head (13, including the policy tests), service lint and 11 unit tests, format check: pass from PowerShell. actionlint 1.7.12: clean.

Why it is safe: the secret is in scope for one step only, piped through stdin with output discarded, telemetry and log file off; the only code that runs with the resulting Salesforce session in reach is the pinned harness, the pinned Salesforce CLI from npm, and Apex that executes inside a scratch org rather than on the runner; nothing from the pull request is installed or executed; the GitHub token is read-only; the PR head is re-checked immediately before authentication and again after the tests, so a push after approval fails before the credential is used; fork pull requests are skipped and the gate job fails closed.

Residual risks, none blocking:

- R1. The pull request controls its own workflow file, so the pin and every guard live in the file the approver reads. Human approval is the real boundary: read the YAML of every run before approving, not only the source diff. ADR 0005 says this.
- R2. Self-review prevention is off and the reviewer account is also the author account, so GitHub cannot tell Bill from the builder. Acceptable while the builder pushes from Bill's machine; revisit if the builder gets its own token.
- R3. The secret is the Dev Hub's administrator refresh token. The org holds no customer data. Rotate it on any suspicion.
- R4. The job tests the PR head, not the merge result with `main`. Fine while `main` has no Salesforce source.

Note 9: the policy tests fail when run from Git Bash because `where.exe git` returns the `mingw64` launcher first and the derived Bash path does not exist. They pass from PowerShell, the documented shell, and on Linux.

Findings 3 to 6 from review 1 are fixed in 5e22782 (file removed, 4xx statuses preserved with three new unit tests, stale action mention removed, Prettier now covers the service). Finding 7 was acknowledged in the roadmap and ADR 0003.

`SAFE TO APPROVE: run 34487910391 at head 5e5567f`

`HOLD: PR #3, 1 finding` (finding 1 closes when that run passes and the three checks are required on `main`).

`PHASE 0: HOLD` until then.

### Security review before approving run 34499943255, same day: head `ac93b957702fe8834841ec6982dc65408fab9055`

Correction to the previous entry: it recorded the `--sfdx-url-stdin` flag as checked because the flag exists in CLI 2.135.7. That check was not enough, because the flag takes a value. Run 34487910391 was approved on the strength of that entry and failed at authentication for exactly this reason. It never created a scratch org or ran Apex.

What was checked:

- The failed run's log, 442 lines. The authentication step failed with its output discarded. The secret appears only as `***`. There are no `force://` strings and no strings shaped like a refresh token. The logout step failed because nothing was logged in, and the gate failed closed. Nothing leaked.
- Both command forms, reproduced in CLI 2.135.7 with a fake input that is not a credential. The old form exits 2 with "Unexpected argument" naming the alias, which matches the hosted failure. The new form with `-` reads stdin and exits 1 with `INVALID_SFDX_AUTH_URL`, which proves the input reaches the URL parser.
- The diff since 5e5567f: one token in the workflow, a Bash resolver with its tests, and docs. The harness pin is still 7974e25, and the pinned scripts are unchanged. `salesforce/` is unchanged since 72c6ccf. The secret is still in scope for one step only, with stdout and stderr discarded.
- The merge ref the pending run executes, 9de19e3, whose parents are `main` at c2945e0 and the head ac93b95. Its workflow and `salesforce/` are identical to the head.
- Pending run 34499943255: a `pull_request` event on head ac93b95, waiting on `salesforce-ci`, with no approvals. Public CI run 34499942796 is green on the same head.
- The environment, which is unchanged: reviewer `cobitechsolutions`, administrator bypass off, branch policies `main` and `refs/pull/*/merge`, one environment secret and zero repository secrets. `main` still has no required status checks.
- Root tests: 22 of 22 pass in Git Bash and in PowerShell, so note 9 is fixed. The format check and scaffold check pass, and actionlint 1.7.12 is clean.
- The new authentication tests. They use a labelled fake string, check the exact nine arguments, and assert that nothing reaches stdout or stderr. ADR 0005 and the CI runbook describe them as plumbing tests, not authentication evidence.

Residual risks R1 to R4 are unchanged.

`SAFE TO APPROVE: run 34499943255 at head ac93b95`

`HOLD: PR #3, 1 finding` (finding 1 closes when this run passes and the three checks are required on `main`).

`PHASE 0: HOLD` until then.

### Testing-strategy design review, same day: PR #3 head `ac93b95`, no scratch orgs created

Scope: the builder's proposal to reduce scratch org use. It covers cheap checks first, one reused seven-day builder org, fresh hosted CI on the final head, the verifier's separate fresh org, a quota preflight with blocked diagnostics, coordination between runs, two slots for C10 test 14, and never counting reused-org or blocked runs as evidence.

Facts read from the Dev Hub and GitHub at 19:13 UTC:

- Limits: 3 active scratch orgs, all 3 free; 6 daily, none left. Salesforce counts the daily limit at creation over a rolling 24 hours. Deleting an org frees an active slot but not a daily one.
- All six daily slots were used on 10 September. The setup smoke test used one at 11:33 UTC, three builder runs used three at 13:20, 13:22 and 13:26, and two verifier runs used two at 13:44 and 13:46 on the same head. All six are deleted. The verifier needed only one of its two.
- Run 34499943255 authenticated and then failed to create its scratch org. There is no creation record after 13:46, so the daily limit caused the failure. The harness reported only "Scratch creation failed". Hosted Apex is still unverified.
- Daily slots should return at 11:33 UTC on 11 September, then at 13:20, 13:22, 13:26, 13:44 and 13:46.
- GitHub: free organisation plan, one member, one account with push access, no rulesets, no CODEOWNERS and no required checks on `main`.

Assessment:

- Independence holds if the reused org stays development only. The evidence must then be two fresh orgs per final head: the hosted CI run, which also serves as the builder's evidence, and the verifier's run.
- One Dev Hub is enough for Phases 0 and 1, at about two reviewed heads a day with one retry. It is not enough from Phase 2. C10 test 14 needs two orgs for CI and two for the verifier on every suite run. That is 4 of 6 daily slots for one head, and every later gate reruns the test.
- Finding 10, must fix before the gate. The required check `Salesforce verification gate` comes from the pull request's own workflow file and runs without environment approval. A pull request that edits that job can turn the check green without running Apex. One GitHub account holds every role, so no technical control prevents this. The real boundary is the verifier's review of `.github/` and `scripts/`, plus a PASS that cites the Apex run for the exact head.

The adjustments A1 to A11 and the tool safeguards are in the design review on PR #3.

`STRATEGY: ADOPT WITH ADJUSTMENTS A1 to A11`

`HOLD: PR #3, 2 findings` (1 and 10)

`PHASE 0: HOLD`

### Security review before approving run 34523564584, same day: head `8e1e2b7c984298c19ae61d1ddf5609c58a635d4c`

Scope: whether Bill may approve Salesforce run 34523564584. The head adds ADR 0006, a builder-org tool, a quota preflight, tagged scratch lifecycle and cleanup, a documentation classifier, a retry budget, global serialisation and a new harness pin, c8470cd. No scratch orgs were created for this review.

What was checked:

- Every new or changed script and workflow line, ADR 0006, and the doc changes. The pin c8470cd is in the branch history. Its scripts are identical to the head; the head differs only in the pin value and one test.
- The credentialed job. The secret is still in scope for one step. The verify step runs only pinned scripts that import Node built-ins. No pull request code or npm package runs there. The GitHub token is read-only. Head checks run before authentication and after the tests.
- SOQL is built only from validated values. Cleanup deletes only `ActiveScratchOrg` records whose tag, request ID and org ID match an org created in the same run.
- The Dev Hub schema, read-only. `OrgName` is filterable with 80 characters, and tags reach at most about 56. `ScratchOrg` is a 15-character string on both objects, matching the cleanup filter. Both exact filters run, and `ActiveScratchOrg` is deletable. `Description` is not filterable, and the builder tool only reads it.
- CLI 2.135.7: `--name`, `--description`, `--async`, `--job-id`, `--sobject` and `--record-id` all exist and take values.
- The policy job holds no secret and runs pinned code. The documentation classifier fails closed to full Apex. PR #3 is not exempt.
- Tests: 100 of 100 tooling tests in Git Bash and in PowerShell, service lint, typecheck and 11 unit tests, format and scaffold checks. Public CI 34523565060 is green on the head. The merge ref 02037ab matches the head for workflows, scripts and `salesforce/`. `salesforce/` metadata is unchanged since 72c6ccf, `service/` since 5e22782, and `docs/verification.md` is untouched.
- The environment is unchanged: one environment secret, no variables, still the shared Dev Hub. Dev Hub limits at 20:08 UTC: 3 of 3 active free, 0 of 6 daily left.
- actionlint 1.7.12 with shellcheck reports warning SC2155 on the classify step. The builder reported a clean run.

Findings:

- Finding 10 is closed. ADR 0006 and `docs/ci.md` state that the check is a tripwire, list the files that need explicit verifier review, and require a PASS to cite the Apex run, coverage and cleanup.
- Finding 11, should fix before the gate. The retry budget runs only in the policy job. GitHub's REST reference says "Re-run failed jobs" and "Re-run a job" repeat only failed jobs and their dependents. The policy job is not repeated, so a partial re-run either reuses the earlier budget decision or skips Apex. The budget also decides on the trigger's UTC day, not the approval day.
- Finding 12, should fix before the gate. An Apex job cancelled while waiting for approval is recorded as cancelled with no steps, and its log does not exist; run 34523279197 shows this. The budget reader then refuses every later attempt on that head. For a cancelled dispatch run it refuses every head. Only skipped jobs are excused, and no test covers the cancelled shape.
- Finding 13, should fix before Phase 1. Creation, deploy and test waits are 15 minutes each, which, with setup, can reach the 45-minute job timeout. A killed job never reaches the harness's cleanup, so an org could hold one of 3 active slots for up to a day.
- Note 14. The SC2155 line masks a failed `git rev-parse`. The result is still full Apex, so it fails safe.
- Note 15. A creation rejected with no request record is reported as failed cleanup, and a deploy compile error as failed infrastructure. Both fail closed, but the labels mislead. The quota-message pattern is unverified against a real rejection.

`SAFE TO APPROVE: run 34523564584 at head 8e1e2b7`, only after daily scratch capacity returns, from 11:33 UTC on 11 September. Do not cancel or reject the run, because of finding 12.

`HOLD: PR #3, 4 findings` (1, 11, 12 and 13)

`PHASE 0: HOLD`

## 2026-09-11: Decision recorded and quota correction, PR #3 head `8e1e2b7`

- Bill approved deferring findings 11, 12 and 13 to the first builder pull request after Phase 0, before any Phase 1 work. Issue #5 tracks them with the required fixes and tests, notes 14 and 15, and the operating constraints. The builder acknowledged each finding on its review thread. PR #3 head 8e1e2b7 and run 34523564584 are unchanged, and the run has no approvals.
- Correction to the design review entry of 10 September: the daily scratch org limit is not a rolling 24-hour window. At 09:00 UTC on 11 September the Dev Hub reported 6 of 6 daily orgs remaining, although all six creations of the previous day were less than 24 hours old. The limit reset at a fixed time between 20:20 UTC on 10 September and 09:00 UTC on 11 September. The Dev Hub's time zone is America/Los_Angeles, so midnight Pacific, 07:00 UTC, is the likeliest reset time. That is not yet confirmed.
- Consequences: the preflight's quota gate reads the live limits and stays correct. Its "next UTC slot" estimate is wrong, and so are the rolling-window statements in ADR 0006 and `docs/ci.md`. All three are added to issue #5 as note 16. The earlier condition to wait until 11:33 UTC no longer applies.
- Capacity at 09:00 UTC: 3 of 3 active and 6 of 6 daily free, and no active scratch orgs.

`SAFE TO APPROVE: run 34523564584 at head 8e1e2b7, now`

`HOLD: PR #3, 1 finding` (finding 1; findings 11 to 13 deferred to issue #5 with Bill's approval)

`PHASE 0: HOLD` until hosted Apex passes on 8e1e2b7, the verifier's fresh-org run passes, and the three checks are required on `main`.

## 2026-09-11: Phase 0 gate report, PR #3 head `8e1e2b7`

- Date: 11 September 2026, 09:40 UTC.
- Commit: `8e1e2b7c984298c19ae61d1ddf5609c58a635d4c`. Merge ref 02037ab on `main` at c2945e0. The PR is mergeable and clean.
- C10 acceptance tests: none are assigned to Phase 0, none are claimed, and no earlier phase exists.

### Evidence

| Check                                                                         | Result                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hosted Salesforce run 34523564584, attempt 1, approved by `cobitechsolutions` | Success. Apex job 103026947098 ran every step. Its log shows 1 test passed, 2 of 2 lines covered (100.00%) and 1 owned scratch org deleted. The marker shows role `ci`, run 34523564584-1, the exact head and outcome `passed`. The gate job succeeded.                                                                  |
| Logs of all three jobs in that run                                            | No auth URL, token or scratch username appears. The secret is shown only masked.                                                                                                                                                                                                                                         |
| Dev Hub audit                                                                 | The CI org `kusanya-ci-v1__34523564584-1__8e1e2b7c9842__5dcfe7a521cd` is Deleted. No scratch orgs are active.                                                                                                                                                                                                            |
| Verifier fresh-org run with its own commands, on an export of the exact head  | One org, `kusanya-verifier-v1__claude-p0gate__8e1e2b7c9842__e94f63356002`, was created and 4 files deployed. `KusanyaRuntimeTest` passed 1 of 1 and `KusanyaRuntime` covered 2 of 2 lines. The head's coverage gate passes on the raw result. The org is deleted and confirmed Deleted. Daily capacity went from 5 to 4. |
| Public CI run 34523565060 on the head                                         | Scaffold and lint: format check, 100 of 100 tooling tests, scaffold check. Service and container tests: 11 unit and 2 integration tests on the runner, then 11 unit and 2 integration tests inside the container, and the runtime image built.                                                                           |
| Verifier local runs at this head on 10 September                              | 100 of 100 tooling tests in Git Bash and PowerShell. Service lint, typecheck and 11 unit tests. actionlint with shellcheck gave one warning, note 14.                                                                                                                                                                    |
| Required checks on `main`                                                     | Scaffold and lint, Service and container tests, and Salesforce verification gate, all from GitHub Actions. Strict up-to-date is on and admins are included. Force pushes and deletions are off.                                                                                                                          |
| Repository                                                                    | Apache-2.0 licence, Issues and Discussions on, public. No workflow, script or Salesforce change since the security review of 8e1e2b7.                                                                                                                                                                                    |
| Verifier container run of the service                                         | Not run. `cobitech-edge-01` has been offline on Tailscale since about 00:30 UTC, and Cloudflare returns HTTP 530 for cobitechsolutions.com. The verifier last ran the containers at 72c6ccf. Since then the service changed only in its error handler, in 5e22782.                                                       |

### Brief C11 Phase 0 deliverables

- Present: the repository, the scratch org definition, the ADR folder with its template, and the brief committed as `docs/brief.md`.
- Present and green on the exact head: CI with the Salesforce CLI, Apex at 85 percent or better, service tests and lint. Apex is gated by human approval and a required gate check.

### ADRs against the brief's decide and ask rules

- Decided and recorded: service language, framework and database (0001); monorepo and service licence (0002); exclusions (0003); CI trust model (0004 and 0005); quota and verification strategy (0006).
- Asked and approved by Bill: automatic Apex (0005); adjustments A1 to A11, the CI Dev Hub and the documentation exemption (0006); the deferral of findings 11 to 13 (issue #5, with ADR 0007 due in the follow-up).
- Correctly left unchosen: packaging, paid dependencies and per-collector licences.
- Still due: the namespace availability check and ADR before Phase 1 objects (note 7); ODK Collect and Enketo versions and the tenant OAuth flow before their phases; an ADR on measured upload bandwidth before staging (C12a); Bill's confirmation of Apache-2.0 for the service (question 8).

### Findings

- Finding 1 is closed. Hosted Apex, coverage and cleanup pass on the exact head, and the three checks are required on `main`.
- Findings 2 to 10 were closed earlier.
- Findings 11 to 13 and notes 14 to 16 are deferred to issue #5 with Bill's approval. They are due in the first builder PR after Phase 0, before Phase 1.

### Verdict

`HOLD: PR #3, 0 findings, 1 verifier check outstanding`

`PHASE 0: HOLD` until the verifier's own container run of the service at 8e1e2b7 passes on `cobitech-edge`. Every other gate requirement is met. When that run passes, the verdict becomes `PASS: PR #3 may be merged` and `PHASE 0: PASS`. If Bill waives the container run in writing, the verdict becomes PASS with the deviation recorded.

## 2026-09-11: Phase 0 gate verdict, PR #3 head `8e1e2b7`

The outstanding verifier container run is complete. Everything in the gate report above still applies: the head, `main`, the required checks and the check runs are unchanged, and no new runs exist.

| Check                                                                                                             | Result                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Connectivity                                                                                                      | `cobitech-edge-01` was back online at 09:42 UTC, 2 minutes after booting. All 11 existing containers were up.                                                                                                                                                                                                                                          |
| Source identity                                                                                                   | The service tree defcf88 was exported from 8e1e2b7 with `git archive` and is identical to the head.                                                                                                                                                                                                                                                    |
| Unit tests in the test image                                                                                      | 11 of 11 passed, none skipped. This includes the 413, 400 and 415 handling added after the last verifier container run.                                                                                                                                                                                                                                |
| Integration tests in the container against a disposable `postgres:17` (17.11), with `REQUIRE_DATABASE_TESTS=true` | 2 of 2 passed, none skipped.                                                                                                                                                                                                                                                                                                                           |
| Negative control: `REQUIRE_DATABASE_TESTS=true` with no `DATABASE_URL`                                            | The database test fails with exit 1, so it cannot skip.                                                                                                                                                                                                                                                                                                |
| Runtime image                                                                                                     | Runs as `node`, 83 MB.                                                                                                                                                                                                                                                                                                                                 |
| Runtime probes                                                                                                    | `/readyz` 200 and `/healthz` 200, with `Cache-Control: no-store`. A 2 KB POST gets 413 with a generic body, and malformed JSON gets 400. With the database stopped, `/readyz` gives 503 while `/healthz` stays 200. No password or database user appears in the logs. Production refuses `DATABASE_SSL=false`, and SIGTERM stops the app in under 1 s. |
| Isolation and cleanup                                                                                             | The run used its own network, database, containers, images and folder, and all were removed afterwards. The existing workload names were identical before and after. The `postgres:17` and `curl` images were kept for reuse.                                                                                                                          |

Open items carried forward, none blocking Phase 0:

- Issue #5 (findings 11 to 13, notes 14 to 16) goes in the first builder PR after Phase 0, before Phase 1 work.
- The `ksny` namespace availability check and its ADR are due before the first Phase 1 objects.
- ODK Collect and Enketo versions and the tenant OAuth flow are due before the phases that use them.
- An ADR on measured upload bandwidth is due before staging (C12a), and the CI-only Dev Hub still has to be provisioned.
- Bill still has to confirm the Apache-2.0 service licence.

`PASS: PR #3 may be merged`

`PHASE 0: PASS`

## 2026-09-11: Security review before approving run 34587333623, PR #6 head `7fcfee2`

Scope: whether Bill may approve Salesforce run 34587333623 for PR #6. The PR implements issue #5 (findings 11 to 13, notes 14 to 16) with a new harness pin, 6e6eb94. No scratch orgs were created.

What was checked:

- Identity. PR #3 merged as f579da9. PR #6 adds two commits on top. The pin 6e6eb94 is in the branch history and differs from the head only in the pin line. The merge ref 2510241 matches the head for workflows, scripts, `salesforce/` and `service/`. The service tree is identical to the Phase 0 container run, and Salesforce metadata is unchanged; only `salesforce/README.md` differs.
- Credential path. The secret is still in scope for one step. The new budget recheck runs before authentication with a read-only token covering contents, pull requests and Actions. The new fallback cleanup step runs pinned code and holds no secret or GitHub token. It deletes only `ActiveScratchOrg` records whose tag carries this run ID, attempt and head, and only after rechecking the remote request and org IDs. Its journal lives at a fixed runner-temp path, is created exclusively and written only by the trusted harness, and holds no credentials or usernames.
- Finding 11 answered. The budget is recomputed inside the Apex job on the approval day, and tests cover partial re-runs and a UTC date change.
- Finding 12 answered. Completed zero-step skipped or cancelled jobs are exempt only when run, attempt and head identity match. Real GitHub job objects carry `run_id`, `run_attempt`, `head_sha` and an empty `steps` array, as run 34523279197 shows.
- Finding 13 answered. Step deadlines total 40 of 45 minutes. CLI waits are 5 minutes, with 6-minute process kills. An always-run fallback cleans up this attempt's orgs if the harness is cut off.
- Notes 14, 15 and 16 answered. SC2155 is fixed. A proven rejection is reported as `failed-creation-rejected`. The next-slot estimate is removed, and ADR 0006 and `docs/ci.md` are corrected.
- Tests at the head: 130 of 130 in Git Bash and PowerShell, plus format, scaffold and whitespace checks. actionlint 1.7.12 with ShellCheck 0.11.0 is clean. Public CI 34587333746 is green.
- Settings unchanged. The environment has one secret, last updated 10 September, no variables, reviewer `cobitechsolutions` and administrator bypass off. The default workflow token is read-only. The three required checks are on `main` with strict on.
- Dev Hub at 12:14 UTC: 3 of 3 active and 4 of 6 daily free, and no active orgs.

New items:

- Finding 17, should fix before PR #6 merges. The fallback cleanup also runs when verification passed, even though the harness has already confirmed its own cleanup. If the fallback then fails, for example on a 30-second read timeout, the job fails while its log carries a `passed` marker. The budget reader treats that as a contradiction and refuses every later attempt on the head. Skip the fallback when verification succeeded, or record that case explicitly as a cleanup failure.
- Note 18. A journal that cannot be created is reported as `failed-cleanup`, although no org exists at that point.

Accepted residual risks, all documented in ADR 0006: runner loss, a remote request that continues after its CLI process is killed, and Windows process trees.

The verifier plans no fresh org for PR #6. Salesforce metadata is unchanged since the Phase 0 runs, and only the hosted run can show the changed harness working. That evidence will come from its log and a Dev Hub audit.

`SAFE TO APPROVE: run 34587333623 at head 7fcfee2`

`HOLD: PR #6, 1 finding` (finding 17). Issue #5 stays open until the hosted run's log and the Dev Hub audit confirm admission, cleanup and the fallback working live.

## 2026-09-11: Re-verification of PR #6 head `c635566` and authentication diagnosis

Scope: findings 17 and 18, the new pin e006ed9, and why run 34587333623 failed at authentication. No scratch orgs were created, and no credential was read or displayed.

Code and settings:

- Findings 17 and 18 are closed. The fallback cleanup now runs only when authenticated verification failed or was cancelled, and a regression test exercises the real guard for every combination of authentication and verification outcomes. A journal that cannot be created before allocation reports `JOURNAL_UNAVAILABLE` as non-retryable infrastructure failure. Later journal failures keep their reconciliation meaning.
- The pin e006ed9 differs from the head only in its two pin lines. The merge ref 0acc34d matches the head for workflows, scripts, `salesforce/` and `service/`. The service tree and Salesforce metadata are unchanged.
- Tests: 132 of 132 in Git Bash and PowerShell, plus format, scaffold and whitespace checks. actionlint 1.7.12 with ShellCheck 0.11.0 is clean. Public CI 34601412415 is green.
- Settings unchanged: one environment secret, last updated 10 September; reviewer `cobitechsolutions`; administrator bypass off; three required checks on `main`.
- The failed run's log holds no credential material. Its in-Apex budget recheck ran live and admitted the attempt before authentication. That is the first live evidence for finding 11.

Authentication diagnosis, all read-only:

- Only one Salesforce CLI OAuth token exists in the Dev Hub. A browser login created it at 11:27 UTC on 10 September. Its use count is 6: that login plus 5 successful refreshes.
- Two refreshes came from GitHub runner addresses, at 16:28 UTC on 10 September and 09:13 UTC on 11 September. Both match the successful CI authentication steps to the second. The other three came from the laptop, the last at 12:14 UTC on 11 September. The CI secret therefore holds this same token, which was valid 31 minutes before the failure and is still valid.
- The failed attempt, from 12:45:17 to 12:45:19, left no LoginHistory row. The setup audit trail shows no security change. Salesforce's status API reports USA876 OK, with no incident that day.
- The runner image, runner version, Node 24.20.0 and the CLI install were identical to the successful run. The authentication step took about 2 seconds in both runs.
- Conclusion: expiry, revocation and a changed secret are ruled out. The request most likely failed on the runner's network path, or inside the CLI before Salesforce processed a refresh. The cause cannot be confirmed, because the step discards all CLI output. `sf org logout` does not revoke tokens: the token kept working after each CI logout.

New findings:

- Finding 19, should fix before PR #6 merges. A failure after the Apex job starts but before the verify step leaves an executed job with no result marker. That covers the head recheck, CLI install, budget recheck and authentication. The budget reader then refuses every later attempt on that head. Its own module confirms this against run 34587333623's real log. Head 7fcfee2 is now permanently locked, and a second authentication failure would lock c635566. This belongs to the same gap as finding 12, and the earlier review did not catch it. Fix: when the Jobs API shows the verify step skipped, no org can exist, so count the attempt as a retryable infrastructure failure within the daily budget.
- Finding 20, should fix before PR #6 merges. The authentication step discards all CLI output, so an authentication failure cannot be diagnosed. Print only an allowlisted error name from the CLI's JSON error, never its message, and keep suppressing everything else.

`SAFE TO APPROVE: run 34601412466 at head c635566`. Approval is safe for the credential but not recommended yet. If authentication fails again, finding 19 locks this head and finding 20 leaves no diagnosis. Fixing both first means one run on the final head.

`HOLD: PR #6, 2 findings` (19 and 20). Issue #5 stays open.

## 2026-09-11: Re-verification of PR #6 head `d675e01` before approving run 34619677398

Scope: findings 19 and 20, the new pin b4df0b1, and whether Bill may cancel the stale run and approve the new one. No scratch orgs were created, and no credential was handled.

What was checked:

- Identity. The pin differs from the head only in its two pin lines. The merge ref cd5a0ae matches the head for workflows, scripts, `salesforce/` and `service/`. Salesforce metadata, the service and all settings are unchanged. Dev Hub at 16:13 UTC: 3 of 3 active and 4 of 6 daily free, with no active orgs.
- Tests. 141 of 141 in Git Bash and PowerShell, plus format, scaffold and whitespace checks. actionlint 1.7.12 with ShellCheck 0.11.0 is clean, and public CI 34619677236 is green.
- Runs. Stale run 34601412466, for head c635566, is waiting for approval and holds the shared Salesforce concurrency slot. Run 34619677398's Apex job is therefore queued as pending and cannot reach approval.
- Finding 19 is closed for pull request runs. A completed, failed Apex job whose Jobs API steps show the verify step completed and skipped now counts as a retryable infrastructure failure within the daily budget. GitHub recorded exactly that shape for run 34587333623's authentication failure.
- The authentication step was tested with its real script against a fake CLI in 15 hostile cases. They covered secret echoes in both streams, a secret as the name, malformed, nested, duplicate-key and prototype JSON, a 3 MB output, and success output carrying tokens. The fake credential never appeared, allowlisted names printed exactly, and success stayed silent.
- The pinned CLI 2.135.7 was run with fake inputs in an isolated home. An unreachable host and a rejected token both report the top-level name `RefreshTokenAuthError`. The underlying cause appears only inside `message` and a `cause` string, and no literal code field exists.

Findings:

- Finding 20 remains open, should fix before PR #6 merges. The allowlist never matches a real refresh failure, because the CLI wraps both network and token errors as `RefreshTokenAuthError`. The step would print `unrecognized` for exactly the failure it exists to diagnose. Fix: allow `RefreshTokenAuthError`, and for it classify `message` and `cause` with fixed patterns into fixed labels only:
  - `dns` for ENOTFOUND, EAI_AGAIN or getaddrinfo;
  - `timeout` for ETIMEDOUT or timed out;
  - `connection` for ECONNRESET, ECONNREFUSED or socket hang up;
  - `token-rejected` for expired access/refresh token or invalid_grant;
  - `other` for anything else.
- Finding 21, should fix before PR #6 merges. For a manual dispatch, the reader needs the `Verifying PR` subject line. The first Apex step prints it only after its live head, source, base and state checks. If the PR changes between dispatch and approval, or a `gh api` call fails, that step exits before printing. The reader then throws for every head, because it reads dispatch runs before filtering by head. Salesforce verification would stay blocked for the whole repository until that run is deleted. Fix: print the subject right after the inputs pass their format checks, before the live checks, and add a test.
- Finding 22, should fix before PR #6 merges. The new exception requires a failed job. A job cancelled after it starts but before verification, for example by Bill during CLI install, has its verify step skipped but a `cancelled` conclusion. The reader throws and locks that head. No org can exist in that state, so it should be treated like the failed case or like a zero-step cancellation.

`SAFE TO APPROVE: run 34619677398 at head d675e01`, after Bill cancels stale run 34601412466. Cancelling is safe: that run's Apex job has zero steps and belongs to a superseded head. Approval is recommended now. A repeat authentication failure no longer locks this head, and this run gives the first live evidence of the journal, cleanup and silent-success paths. The fixes for findings 20 to 22 will need one more run on the final head.

`HOLD: PR #6, 3 findings` (20, 21 and 22). Issue #5 stays open.

## 2026-09-11: PR #6 live evidence at `d675e01` and re-verification of head `715661c`

### Live evidence from run 34619677398 on head d675e01, independently checked

- The run ran attempt 1, succeeded, and carries Bill's approval. Every Apex step succeeded. The fallback cleanup was skipped after success, as designed.
- The budget admission JSON appears twice: once in the early policy job and once inside the Apex job before authentication. That is live evidence for finding 11.
- The harness log shows ownership tag `kusanya-ci-v1__34619677398-1__d675e0131cd9__9233971acba0`, 1 test passed, 2 of 2 executable lines covered (100.00%), and 1 owned scratch org deleted with 0 already deleted. The marker shows outcome `passed` for the full head and run 34619677398-1.
- None of the three job logs, 939 lines in total, contains an auth URL, token, username or instance host.
- Dev Hub audit at 17:00 UTC. The tagged record is Deleted, and the setup audit trail logged the deletion at 16:36. No scratch orgs are active, and 3 of 6 daily slots remain. A successful CLI refresh at 16:35:50 matches the authentication step.
- Not proven live: fallback recovery after a failed or cancelled verification, and the pre-verification exceptions. Their tests use the real GitHub job shapes and the real CLI error shapes.

### Re-verification of head 715661c, pin 1d0edc1

- Identity. The pin differs from the head only in its two pin lines. The merge ref 8e18406 matches the head for workflows, scripts, `salesforce/` and `service/`. Salesforce metadata, the service and all settings are unchanged. The stale run 34601412466 is cancelled, and run 34623685881 is the only one waiting.
- Tests. 150 of 150 in Git Bash and PowerShell, plus format, scaffold and whitespace checks. actionlint 1.7.12 with ShellCheck 0.11.0 is clean. Public CI 34623685706 is green.
- Finding 20 closed. The real CLI 2.135.7 error JSON, captured from fake inputs, was replayed through the extracted authentication step. It printed `RefreshTokenAuthError/dns` for an unreachable host and `RefreshTokenAuthError/token-rejected` for a rejected token. Fifteen cases, including secrets inside matching messages, pattern precedence, non-string and nested fields, a label planted inside the name, and success with tokens, never printed the synthetic credential or host.
- Finding 21 closed. With a failing live head check, the extracted confirm step printed `Verifying PR 6 at head ...` before failing. An invalid SHA still printed no subject.
- Finding 22 closed. A cancelled job counts against the daily budget only when its verify step is completed and skipped and at least one step executed. The `verificationNotStarted` flag is set only by the collector from Jobs API data, and the marker reader returns no such field. Zero-step cancellations stay free, and success with a skipped verify step still fails closed.
- All issue #5 items are now answered: findings 11 to 13 and 17 to 22, and notes 14 to 16.

`SAFE TO APPROVE: run 34623685881 at head 715661c`. Capacity at 17:00 UTC was 3 of 3 active and 3 of 6 daily free.

`HOLD: PR #6, 0 findings, awaiting hosted Apex on 715661c`. The verdict becomes `PASS: PR #6 may be merged` once that run passes with coverage and cleanup confirmed by its log and a Dev Hub audit. Issue #5 can close when PR #6 merges.

## 2026-09-11: PR #6 verdict, head `715661c`

Final hosted evidence for issue #5 hardening. Nothing has changed since the review of this head: the head, pin, merge ref 8e18406, settings, Salesforce metadata and service are identical.

| Check                                       | Result                                                                                                                                                                                                                                                                     |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Salesforce run 34623685881, attempt 1       | Success, approved by `cobitechsolutions` for `salesforce-ci`. Apex job 103343579965 succeeded in every step. The fallback cleanup was skipped after success, as designed. The gate succeeded.                                                                              |
| Budget admission                            | The admission JSON appears in the policy job and again in the in-Apex recheck before authentication.                                                                                                                                                                       |
| Harness evidence                            | Tag `kusanya-ci-v1__34623685881-1__715661c10168__4687f565462e`. 1 test passed with 2 of 2 executable lines (100.00%). 1 owned scratch org deleted, 0 already deleted. The marker shows outcome `passed` for the full head and run 34623685881-1, started 17:06:33.725 UTC. |
| Credential safety                           | 950 log lines across three jobs contain no auth URL, token, username or instance host. The one `RefreshTokenAuthError/` match is the step's echoed script. No authentication failure line was printed.                                                                     |
| Dev Hub audit, 17:11 UTC                    | The tagged ScratchOrgInfo record is Deleted, with no error code. The setup audit trail logged `deleteScratchOrg` at 17:07:00 for the same org ID. No scratch orgs are active, and 2 of 6 daily slots remain. The CLI refresh at 17:06:33 matches the authentication step.  |
| Required checks on the head                 | Scaffold and lint, Service and container tests, and Salesforce verification gate all succeeded. The PR is mergeable and clean.                                                                                                                                             |
| Tests at this head, from the previous entry | 150 of 150 in Git Bash and PowerShell. actionlint with ShellCheck 0.11.0 is clean. The service tree is identical to the Phase 0 container run.                                                                                                                             |

Findings 11 to 13 and 17 to 22 are closed, and notes 14 to 16 are addressed. Two things are not proven live: fallback recovery after a failed or cancelled verification, and the pre-verification retry exceptions. Their regression tests use real GitHub job shapes and real CLI error shapes.

Merge order: merge PR #6 before PR #4. `main` requires branches to be up to date, so merging PR #4 first would force a new PR #6 head and void this Apex evidence.

`PASS: PR #6 may be merged`

Issue #5 may close when PR #6 merges.

## 2026-09-11: PR #6 merged and issue #5 closed

- PR #6 was squash-merged by `cobitechsolutions` at 17:16 UTC as 87b008a. The merged tree is identical to the verified head 715661c. `main`'s scripts are identical to the pin 1d0edc1, and its workflow pins 1d0edc1. The PASS in review 5181512246 therefore applies to `main`'s content.
- Issue #5 was closed by the verifier, with a comment listing the resolved findings, the live evidence, and the limitations that stay true.
- Still not proven live: fallback recovery after a failed or cancelled verification, the pre-verification retry exceptions, and the authentication diagnostic labels. Runner loss and remote requests that outlive their CLI process still need private reconciliation. The daily reset time is unconfirmed, and the CI-only Dev Hub is not provisioned.
- This branch, PR #4, was brought up to date with `main` by a merge commit, keeping every entry. It changes only this file, so its Salesforce gate uses the approved documentation exemption, with no approval and no scratch org.
- Still due before Phase 1: the `ksny` namespace availability check and its ADR, and Bill's confirmation or revision of the Apache-2.0 service licence in ADR 0002.

## 2026-09-11: Read-only diagnosis of the ksny namespace-link failure

Scope: the builder's request to confirm the `ksny` registration and the absent Dev Hub link, and to diagnose the Link Namespace error `invalid_request: missing required code challenge`. There is no pull request yet; the builder's branch `docs/service-licence-confirmation` is unpushed at acbd7b2. No settings, connected apps, credentials, scratch orgs, CI or support cases were touched.

Confirmed read-only at 19:23 UTC:

- The holder org 00Dbm00000yxbH7EAI, under local alias `Kusanya-Namespace`, is a Developer Edition, non-sandbox org on USA876 with `NamespacePrefix = ksny`.
- The Dev Hub 00Dbm00000yeiz3EAA has zero `NamespaceRegistry` rows for any prefix, so the link is absent.
- Both orgs' `OauthOidc` settings metadata show `isPkceRequired = false`, so the org-wide PKCE requirement is off in each.
- The Dev Hub has exactly one connected application, "SalesforceDX Namespace Registry". Automated Process created it at 11:30 UTC on 10 September, when Dev Hub was enabled. It is not listed as retrievable `ConnectedApp` metadata, and its standard fields expose no PKCE setting. No external client apps exist.
- `NamespaceRegistry.NamespaceOrg` is not createable through the API, so no API path exists to write a link.

Diagnosis:

- The error arrives before any namespace-org sign-in, so neither org's policy can apply yet. The requirement must come from the connected app named in the popup's request.
- With org-wide PKCE off in both orgs, the likely cause is that the Dev Hub's automatically created "SalesforceDX Namespace Registry" app requires PKCE while the Salesforce-generated Environment Hub flow sends no code challenge. That makes it a Salesforce-side incompatibility.
- The app's PKCE flag is not readable by API, so this is an inference until Bill views the app's OAuth settings.
- Salesforce's Known Issue a028c00000qQ0CBAA0 confirms Link Namespace depends on a Dev Hub connected app with callback `/environmenthub/soma-callback.apexp`. Its workaround creates such an app, which is outside the approved scope. In 2026 that is also constrained by connected-app creation and security changes.
- A third-party article suggests unticking PKCE on the app. That is not a Salesforce-supported remedy, and it is the change the approval forbids.

Recommendation: Bill views the app's OAuth settings read-only, then Salesforce Support is asked for a supported fix. Any change to the app's PKCE flag, or the Known Issue workaround, needs Bill's separate approval and verifier review before and after. The drafted support request was given to Bill and not sent.

No verdict applies. Linking stays incomplete, and ADR 0008's Phase 1 prerequisite is still open.

## 2026-09-13: Option 1 stopped; Namespace Registry app PKCE is locked by Salesforce

Bill approved one temporary PKCE change on the Dev Hub's "SalesforceDX Namespace Registry" app to link `ksny`. The approval required stopping without any change if the control was unticked or not editable. The verifier recorded a read-only baseline at 12:09:45 UTC first.

Builder report, recorded locally in ADR 0008 at 9bb1f65, not pushed:

- On the app's Edit form, PKCE was checked and disabled, with the text "To change this required setting, contact Support."
- Edit was cancelled without saving, so no window started and no link was attempted.
- The builder also opened the app's Delete confirmation by mistake and cancelled it.

Verifier check, read-only, at 12:44:49 UTC:

- Both org identities match the approval: Dev Hub 00Dbm00000yeiz3EAA, and holder 00Dbm00000yxbH7EAI with `NamespacePrefix = ksny`.
- `NamespaceRegistry` still has 0 rows, the same as the baseline.
- The Dev Hub still has exactly one connected application, "SalesforceDX Namespace Registry". Its `LastModifiedDate` is unchanged from the baseline, 2026-09-10T11:30:21Z by Automated Process, so it was neither saved nor deleted.
- The setup audit trail has no entries after 17:07 UTC on 11 September, so no setting was saved.
- The org-wide `isPkceRequired` is still false.

Conclusion:

- The app-level PKCE requirement is now directly observed. Salesforce has made it a required setting that only Support can change, so the earlier diagnosis is confirmed.
- The Link Namespace flow cannot succeed from this org without Salesforce. No admin-side workaround remains within the approved security boundaries.
- The two routes left are a Salesforce Support request, and Option 2: continue Phase 1 without a namespace and link before any package is created.
- Option 2 needs Bill's approval and amendments to ADR 0006 and ADR 0008.
- Linking stays incomplete, and no verdict applies.

## 2026-09-13: Source and security review of PR #8 head `9da8f13` before approving run 34758585587

Scope: the first Phase 1 unit. It adds Folder, Form and Form Version metadata, a version-identity trigger, three model-only permission sets, and the service's Salesforce name resolver, plus ADRs 0002, 0006, 0008 and 0009. This is a source and security review before Bill approves Apex, not the phase gate. No scratch org was created.

What was checked:

- Identity and trust boundary. The merge ref 4399356 matches the head. No workflow changed. The only new `scripts/` file is a public-CI source test, and the credentialed harness stays pinned at 1d0edc1. PR metadata and Apex run only inside the scratch org, contain no callouts, and never reach the runner's Dev Hub session. `sfdx-project.json` and the scratch definition are unchanged, with an empty namespace.
- Brief C4. Every listed Form and Form_Version field is present, and Folder is added. Every object, field and name field has a description. No `ksny__` prefix or org ID appears in the source.
- Model. Form and Folder are private roots. Form_Version is a non-reparentable master-detail to Form. Current_Version and Folder lookups clear on delete. Version_Key (Text 28, unique, case-sensitive) is derived in a before trigger with no queries or DML, and a caller-supplied key is overwritten. Validation rules reject a non-positive or fractional version number, and a current version from another form.
- Permission sets. Admin has create, read, edit and delete; Integration has create, read and edit; Supervisor has read only. None has view-all or modify-all, user or setup permissions, or class, tab or app access, and none is assigned. The derived key is read-only.
- Service. `createSalesforceNames` prefixes only Kusanya-owned `__c` names. It preserves standard, customer and foreign-package names byte for byte, builds namespaced Apex REST paths, and rejects traversal, query and injection input. The deployment default does not select a tenant.
- Tests at the head: 154 of 154 root tests in Git Bash and PowerShell; service lint, typecheck and 21 of 21 tests; format, scaffold and whitespace checks; offline source conversion. Public CI 34758585542 is green.
- Settings are unchanged. Dev Hub capacity at 13:07 UTC was 3 of 3 active and 6 of 6 daily.

Notes, none blocking:

- Note 23. The fractional-version rule assumes Salesforce evaluates the validation rule before rounding the scale-0 `Version_Number__c`. Only the hosted Apex run can show this. If Salesforce rounds first, `rejectsNonPositiveAndFractionalVersions` fails, and 1.5 would save as 2. The fix would then be a non-zero scale with the whole-number rule.
- Note 24. Form and Folder are private, and Integration and Supervisor have no view-all. The integration user will not read forms that administrators create, and supervisors will see only their own. Decide the sharing model or the permission-set grants before Phase 2 reads forms.
- Note 25. `Current_Version_Matches_Form` is tested on update but not on insert. The resolver handles only `__c`; relationship (`__r`) and other suffixes will be needed later, as ADR 0009 acknowledges.

`SAFE TO APPROVE: run 34758585587 at head 9da8f13`

`HOLD: PR #8, 0 findings, awaiting hosted Apex and the verifier's fresh-org run`

## 2026-09-14: PR #8 verdict, head `9da8f13`

Final evidence for the first Phase 1 unit. Nothing changed since the source and security review of this head: the head, merge ref 4399356, settings and required checks are the same.

| Check                                                                      | Result                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Salesforce run 34758585587, attempt 1, approved by `cobitechsolutions`     | Success on the exact head. Every Apex step succeeded, the fallback cleanup was skipped after success, and the gate passed.                                                                                                                                                                                                                   |
| Hosted harness evidence                                                    | Tag `kusanya-ci-v1__34758585587-1__9da8f13fdf55__8e6d70ffe3d9`. 10 tests passed, 16 of 16 executable lines (100.00%), 1 owned scratch org deleted and 0 already deleted. The marker shows `passed` for the full head and run 34758585587-1.                                                                                                  |
| Credential safety                                                          | 950 log lines across three jobs contain no auth URL, token, scratch username or instance host.                                                                                                                                                                                                                                               |
| Dev Hub audit at 06:54 UTC                                                 | The CI org record is Deleted, and the setup audit trail logged `deleteScratchOrg` for the same org ID at 13:28 UTC on 13 September. No scratch orgs are active.                                                                                                                                                                              |
| Verifier fresh-org run at 06:55 UTC, own commands on an export of the head | 35 of 35 components deployed. 10 of 10 tests passed: 9 model tests and the Phase 0 smoke test. Coverage was `FormVersionIdentityHandler` 13 of 13, `FormVersionIdentity` 1 of 1 and `KusanyaRuntime` 2 of 2, and the head's coverage gate accepts the raw result. The org is deleted and confirmed Deleted. Capacity went from 5 to 4 daily. |
| Required checks and public CI                                              | All five checks are green on the head, and the PR is mergeable and clean.                                                                                                                                                                                                                                                                    |
| Local checks at this head, from the previous entry                         | 154 of 154 root tests in both shells, service lint, typecheck and 21 of 21 tests, format, scaffold, whitespace and offline source conversion.                                                                                                                                                                                                |

Notes:

- Note 23 is closed by evidence. `rejectsNonPositiveAndFractionalVersions` passed in two real scratch orgs, so Salesforce evaluates the validation rule before rounding into the scale-0 `Version_Number__c`. A fractional 1.5 is rejected, not silently saved as 2. The deployed field is precision 9, scale 0 and not nillable.
- Notes 24 and 25 remain open for later units, and neither blocks this one. The integration user cannot read administrator-created forms while sharing is Private with no view-all, and that must be decided before Phase 2 reads forms. The insert path of `Current_Version_Matches_Form` is untested, and the service name resolver handles only `__c` names.
- Not proven by this unit: namespaced execution, effective user access from assigned permission sets, publication and lifecycle enforcement, and C10 tests 10 and 12.

`PASS: PR #8 may be merged`

This is a Phase 1 unit, not the Phase 1 gate. Phase 1 still needs question trees, choices, skip rules, mappings, the compiler, XLSForm import and export, the print view and CLI publish, with tests 10 and 12.

## 2026-09-14: PR #8 merged

- PR #8 was squash-merged by `cobitechsolutions` at 08:32 UTC as e97882d. The merged tree is identical to the verified head 9da8f13, so the PASS in review 5194796568 applies to `main`'s content.
- This branch, PR #7, was brought up to date with `main` by a merge commit, keeping every entry. It still changes only this file, so its Salesforce gate uses the documentation exemption.
- Still open: notes 24 and 25 for later Phase 1 units, the `ksny` Dev Hub link through Salesforce Support, a namespaced suite run once linking works, and C10 tests 10 and 12.

## 2026-09-14: Source and security review of PR #9 head `e694453`; deployment blocker

Scope: the question-tree unit, covering Question, Choice List, Choice and Skip Rule, four integrity handlers and triggers, permission-set extensions, the `__r` name resolver, and ADRs 0010 and 0011. The review was requested before Bill approves Salesforce run 34829135270.

What passed locally and in source review:

- Trust boundary. No workflow changed; the only script change is the public-CI source test. The harness is still pinned at 1d0edc1, and the project and scratch definitions are unchanged. The merge ref 68ebfc6 matches the head.
- Tests at the head: 157 of 157 root tests in Git Bash and PowerShell; service lint, typecheck and 24 of 24 tests; format, scaffold and whitespace checks; offline conversion to 105 components. Public CI 34829135322 is green.
- Source. All C4 fields are present, with descriptions and restricted picklists. Tree validation checks old and new parent edges, detects cycles, and uses three bounded queries with no DML of its own. The trigger-only `without sharing` handlers return no data. The three permission sets cover the seven objects with no view-all, modify-all or other grant types. ADR 0011 correctly defers cross-owner reads to a separately tested change. The resolver adds bounded `kusanyaRelationship` and `targetRelationship` methods.
- Capacity and settings were unchanged before the verifier run.

Verifier fresh-org run, 09:51 UTC, on an export of the exact head:

- Deployment failed: 96 of 166 components succeeded and 70 failed. Salesforce rejected `Question__c.Parent__c`, `Question__c.Repeat_Source_Question__c` and `Question__c.Previous_Version_Question__c` with "Cannot add a self-lookup relationship child with cascade or restrict options to the object itself". Each field declares `<deleteConstraint>Restrict</deleteConstraint>` on a Question-to-Question lookup. Everything referencing those fields then failed to compile: `QuestionIntegrityHandler`, the `QuestionIntegrity` trigger, `QuestionDefinitionModelTest`, and all three permission sets.
- No Apex test or deletion probe ran. The org was deleted and confirmed Deleted, no scratch orgs are active, and daily capacity went from 6 to 5.
- Local checks and offline source conversion cannot detect this platform rule; only a real deployment does.

Findings:

- Finding 26, blocker. PR #9 does not deploy.
  - A self-lookup cannot use Restrict. Salesforce allows only Clear (SetNull), which is the default.
  - To keep ADR 0010's intent that deleting a parent must not silently change repeat scope, remove the delete constraints from the three self-lookups. Enforce the protection in a `before delete` trigger on Question instead.
  - That trigger refuses deleting a question still referenced as Parent, Repeat Source or Previous Version by a question outside the same delete operation.
  - Master-detail cascade deletes of a Form or Form Version do not fire child delete triggers. Confirm this with a test that deletes a Form containing a section, repeat, child and skip rule.
  - Add tests for direct deletion of a referenced parent, for deleting a parent together with its children, and for the other two references.
  - Re-run a real deployment before requesting review.
- Note 27. The integration user can read and edit `Author_Notes__c`. That is plausible for future XLSForm import and export, so C3.19 will rest entirely on the compiler and delivery allowlist, which must be tested there.
- Note 28. Two things are accepted, and are compiler-time checks only: a repeat whose count source sits inside the same repeat, and a skip rule sourced from a non-answerable question such as a section. The deletion and edge-case probes will be re-run on the fixed head.

`HOLD: run 34829135270 at head e694453`. Do not approve: it would fail at deployment, consume a scratch org, and leave that head non-retryable.

`HOLD: PR #9, 1 finding` (26)

## 2026-09-14: Local security review of the Windows Salesforce launcher, PR #9 local candidate `e6720e9`

Scope: the builder's unpushed candidate e6720e9, whose parent is acbad1d on top of published head e694453. This is a local tool review before Bill's one authorized development org is used. It is not a CI approval, a closure of finding 26, or a merge verdict.

Context: `node scripts/builder-org.mjs acquire` failed on Windows during read-only discovery, before any allocation. Node escaped the client's already-quoted `cmd.exe` arguments a second time.

What changed: `scripts/salesforce-client.mjs` now sets `windowsVerbatimArguments` on Windows only, and additionally rejects Windows arguments that end in a backslash. There are new real-process tests with a fake `sf.cmd` and a capture fixture, plus ADR 0012 and a README note. The CI workflow, guards, lifecycle and the harness pin 1d0edc1 are unchanged.

What was checked:

- Identity. The builder clone head is e6720e9 with a clean working tree and parent acbad1d. The only changed `scripts/` files are the client, its tests, the two fixture files and the form-model test. The workflow still pins 1d0edc1 twice.
- Quoting. The command line is now `cmd.exe /d /s /c sf "arg" ...`. Because the text after `/c` does not start with a quote, `/s` strips nothing. Inside quotes, `& | < > ^ ( )` are literal. Quotes, `%`, `!`, control characters and now trailing backslashes are rejected before any process starts, so an argument cannot close its quote or smuggle an argument into `sf.cmd`'s parser. The Linux path is unchanged, and the option is ignored there.
- Fixtures. The fake `sf.cmd` only forwards arguments to `capture-argv.mjs`, which uses no Salesforce modules, authentication, files or network. The tests pass a minimal environment (`SystemRoot`, a fixture-first `PATH`, `PATHEXT`, the Node path), so neither the installed CLI nor any credential is reachable.
- Tests in a verifier-owned worktree at e6720e9, later removed: client subset 10 of 10 and all root tests 161 of 161, in both Git Bash and PowerShell; service lint, typecheck and 24 of 24 tests; Prettier and the scaffold check. The negative control confirms the old quoting fails through real `cmd.exe`.

Note 29, pre-existing and not blocking: on Windows, `cmd.exe` searches the working directory for `sf` before `PATH`, as ADR 0012 acknowledges. The client runs from repository folders, so a committed `sf.cmd` there would run with local builder authentication. Acceptable for the builder's own trusted checkout. Harden later by setting `NoDefaultCurrentDirectoryInExePath=1` in the client environment, or by resolving an absolute `sf` path outside the repository.

Operational: run 34829135270 on the published head was still waiting at 12:44 UTC and was not cancelled. It must be cancelled, not approved.

`SAFE TO USE LOCAL BUILDER TOOL: e6720e9`, for `builder-org.mjs` status, acquire and release under Bill's one-org authorization only. Development output is not verification evidence.

`HOLD: PR #9, 1 finding` (finding 26 stays open until the pushed head deploys in the verifier's fresh org and passes its tests and deletion probes).

## 2026-09-14: Re-verification of PR #9 head `bc5affc`; finding 26 closed

Scope: the finding 26 fix (acbad1d), the Windows launcher already cleared at e6720e9, and bc5affc, which adds owner-scoped skip-rule cleanup before Form and Form Version deletion. Requested before Bill approves hosted run 34846612699.

Trust boundary and identity:

- The PR head is bc5affc. No workflow changed, and the harness pin 1d0edc1 appears twice as before. The project and scratch definitions are unchanged. Since e6720e9, the only script change adds two class names to `scripts/form-model.test.mjs`.
- Codex's development org `kusanya-builder-v1`, created at 12:50 UTC, shows Deleted. No scratch org was active before the verifier run.

Source review:

- The three Question self-lookups no longer declare `deleteConstraint`.
- The `QuestionIntegrity` before-delete guard uses one query with `LIMIT 1` and no DML. It rejects the whole batch with a generic message when any question outside the batch references a deleted question as Parent, Repeat Source or Previous Version.
- `DefinitionDeletionHandler` is without sharing, holds no state, and is called only from the Form and Form Version before-delete triggers. Each call queries skip rules whose target question belongs to those exact owners and deletes them in one all-or-none statement. The platform checks delete access on the owners before the trigger runs. Source Question's native Restrict is kept.
- `SkipRuleDefinitionHandler` requires the source and target to share a version, so an owner's cleanup covers every rule sourced in that owner.
- Test corrections: `CIRCULAR_DEPENDENCY` for direct self-lookups, and an `SObjectException` on assignment for the non-reparentable Form Version. Both still assert that nothing changed.
- ADR 0010, the data model, the roadmap and the README record notes 27, 28 and 29 and the remaining gaps.

Local, in a verifier-owned detached worktree of bc5affc (removed afterwards):

- Root tests: 161 of 161.
- Service: lint, typecheck, and 24 of 24 tests.
- Prettier, run with the repository's own dependencies, and the scaffold check: both clean.
- Public CI 34846612683 is green.

Verifier fresh org `kusanya-verifier-v1__claude-pr9__bc5affcd0f62`, created 13:14 UTC from the head's own scratch definition:

- Deployment: Succeeded, 109 of 109 components, 0 errors.
- `RunLocalTests` with coverage: Passed, 51 of 51.
  - QuestionDefinitionModelTest 17, ChoiceAndSkipRuleModelTest 10, FormDefinitionModelTest 10, QuestionDeletionTest 7, DefinitionDeletionTest 6, KusanyaRuntimeTest 1.
  - Org-wide coverage 99%. Every class and trigger is at 100%, except ChoiceDefinitionHandler at 98%.
- Probes: anonymous Apex, synthetic data, each probe rolled back, 0 rows left. `Kusanya_Admin` was assigned to the scratch admin so anonymous Apex could compile against field access.
  - P1. A whole Form deletes: a section, an integer count, a from_answer repeat, a child, two skip rules and Current Version set. 0 questions and 0 rules remain.
  - P2. Deleting a lineage predecessor directly is refused with the generic guard message. Deleting version 1 succeeds, clears the surviving successor's lineage lookup as documented, and keeps version 2's own rule.
  - P3. A cross-version skip rule is refused on insert and on update.
  - P4. Deleting a skip source directly is refused by the native Restrict. Deleting the target cascades its rule, and the source then deletes.
  - P5. An inline list blocks Form deletion with `DELETE_FAILED`, as documented. After unlinking and deleting the list, the Form deletes.
  - P6. Choice values are trimmed on save. `a ` and ` a` are duplicates of `a`, `A` is distinct, and a single space is refused as required-missing.
  - P7. Note 28: a repeat counted from its own child, and a section as a skip source, are both still accepted, as documented.
  - P8. Undeleting a deleted Form restores the version and both questions, but 0 of its skip rules.
  - P9. Undeleting only a child from a deleted parent-and-child group restores the child with Parent cleared.
  - P10. The guard message does not name or identify the dependant record.
- Cleanup: the org was deleted and shows Deleted, with 0 active. Daily capacity went from 4 to 3 of 6.

Finding 26 is closed: the head deploys, and the deletion design behaves as ADR 0010 describes in a real org.

Note 30, non-blocking, for the lifecycle unit:

- Recycle Bin restoration is unsafe for definitions. An undeleted Form comes back without its skip rules (P8). An undeleted child can come back outside its repeat (P9).
- The lifecycle service should either restore what was removed or refuse the restore, with a test.
- ADR 0010 should record this as observed behaviour rather than "untested".

Operational:

- Run 34829135270 on e694453 is still waiting.
- Run 34846612699 on bc5affc is pending behind it on the global Apex concurrency slot.
- Cancel the old run first, then approve the new one.

`SAFE TO APPROVE: run 34846612699 at head bc5affc`, after run 34829135270 is cancelled.

`HOLD: PR #9, 0 findings`. This becomes PASS once the hosted run succeeds on this exact head and the gate is green.

## 2026-09-14: Read-only diagnosis of run 34846612699 attempt 1 and retry clearance, PR #9 head `bc5affc`

Scope: Bill rejected run 34829135270 and approved run 34846612699, which failed. This is a read-only diagnosis. No scratch org, container run, rerun, approval or secret change was made.

Evidence:

- The Apex job 103984075830 ran from 13:48:14 to 13:48:28 UTC. The step "Confirm reviewed commit and trusted workflow" printed `Verifying PR 9 at head bc5affc…`, then after about 11.5 seconds printed `unexpected end of JSON input` and exited 1.
- That text is what `gh api --jq` prints when a response body is empty or cut off. It came from one of the step's four separate pull request lookups. The guard's own mismatch message was not printed.
- The token permissions were Actions, Contents, Metadata and PullRequests, all read.
- The same step passed on every earlier executed Apex run: 34523564584, 34619677398, 34623685881 and 34758585587. The workflow has not changed since 87b008a.
- A live lookup at 13:55 UTC returned head bc5affc, repository kusanya-io/kusanya, base main and state open. No workflow run was queued or in progress.
- GitHub's status feed lists no incident on 14 September. The most recent was 13 September, 09:16 to 10:44 UTC.
- Jobs API steps: every credentialed step was `skipped`, including harness checkout, CLI install, both rechecks, authentication, verification and cleanup. The logout step's exit 127 follows from the CLI never being installed.

Retry budget:

- The pinned `apex-run-budget.mjs` and `apex-pr-policy.mjs` from 1d0edc1 were exported to the scratchpad. They were run read-only against live history, with only this run's listing changed to attempt 2.
- The exact-head history has one Salesforce run, 34846612699, attempt 1. That attempt is counted as `failed-infrastructure`, retryable, because its failed job's verify step is completed and skipped.
- Old run 34829135270 on e694453 is filtered out by head.
- Result: `allowed: true`, `kind: infrastructure-retry`, "One infrastructure retry remains for this head and UTC day."

Note 31, non-blocking, a later tripwire change: the confirm step makes four separate `gh api` calls with no retry, so one dropped response fails the run. A reviewed change could fetch and parse the pull request once, with a bounded retry and a clear error. The logout step could skip when `sf` is absent. Do not change the workflow or pin for this retry.

`SAFE TO APPROVE: ONE same-head infrastructure retry of run 34846612699 at bc5affc`, using "Re-run all jobs" with one environment approval. If it fails the same way again, stop and send the log.

`HOLD: PR #9, 0 findings`. This becomes PASS once the hosted run succeeds on this exact head and the gate is green.

## 2026-09-14: PR #9 hosted Apex evidence, run 34846612699 attempt 2 at `bc5affc`; PASS

Scope: independent review of the hosted retry's log, the Dev Hub cleanup, and credential hygiene. No scratch org or fresh-org run was created; my 13:14 UTC fresh-org run on this same head remains the independent runtime evidence.

Run and head:

- Attempt 2 completed as success on bc5affc. The policy, Apex and gate jobs all succeeded.
- The pull request head is unchanged. It is up to date with main e97882d, the merge state is CLEAN, and all five checks are green.
- The workflow, the harness pin 1d0edc1 and the ADRs are unchanged since review 5198161599.

Apex job 104005342261, full log of 531 lines:

- Every step succeeded, except the fallback cleanup step, which was correctly skipped.
- The confirm step printed the exact head, and the stale-head check passed.
- The in-job budget recheck returned `allowed: true, kind: infrastructure-retry`.
- Result: `Apex for bc5affc…: 51 passed; 286/287 executable lines (99.65%)`.
- There is exactly one marker: schema 1, role `ci`, run `34846612699-2`, full head bc5affc, started 14:03:09.910Z, outcome `passed`, retryable false.
- Cleanup: 1 owned scratch org deleted, 0 already deleted. Tag `kusanya-ci-v1__34846612699-2__bc5affcd0f62__d01396573f6d`.

Dev Hub:

- ScratchOrgInfo shows the tag as Deleted, for org 00Dcb00000NiiBN, created 14:03:14 and last modified 14:04:01 UTC.
- The Setup Audit Trail has `deleteScratchOrg` for "00Dcb00000NiiBN" at 14:04:03 UTC. ActiveScratchOrg has 0 rows.

Credential hygiene:

- The scan found no `force://` URLs, org session IDs, bearer, access or refresh tokens, JWTs, private keys, or email addresses.
- All 10 `***` masks are GitHub redactions: the auth URL secret once in an env display, `GH_TOKEN` and checkout tokens, and the checkout auth header.

Finding 26 remains closed. Notes 27 to 31 remain for later reviewed units and do not block this one. This is a Phase 1 unit, not the phase gate.

`PASS: PR #9 may be merged`

## 2026-09-14: PR #9 merged

Bill squash-merged PR #9 as 1ec8488. Its tree, 61ad122, is identical to the verified head bc5affc, so the hosted Apex evidence from run 34846612699 attempt 2 and my fresh-org run apply to main unchanged. Main CI 34876934759 passed.

Carried forward to later reviewed units, none blocking:

- Note 24: the ADR 0011 read policy and its effective-access tests before any Phase 2 definition reader.
- Note 25: the untested insert path of the Current Version rule; the resolver handles only `__c`.
- Note 27: Author Notes exclusion must be proven at the compiler and delivery layer.
- Note 28: compile-time rejection of a repeat counted from its own subtree and of non-answerable skip sources.
- Note 29: working-directory executable discovery in the Windows launcher.
- Note 30: undelete restores a Form without its skip rules, and a lone child without its parent.
- Note 31: a single dropped GitHub API response fails the confirm step, and logout fails when the CLI is absent.
- A namespaced suite run once `ksny` is linked, and C10 tests 10 and 12 before the Phase 1 gate.

## 2026-09-14: Source and security review of PR #10 head `ca90e4a`; two Apex test failures

Scope: the mapping-definition unit. It adds Mapping and Field Mapping, the MappingDefinition and FieldMappingDefinition triggers and handlers, and mapping probes in the Question delete and type-change guard. It also covers the permission-set extensions and ADR 0013, with ADR 0011 amended. The review was requested before Bill approves run 34879906645.

Trust boundary:

- No change to workflows, the harness, packages, the project or the scratch definition. The pin 1d0edc1 appears twice.
- The script changes are source-contract tests. `mapping-model.test.mjs` imports only `node:assert`, `node:fs` and `node:test`.
- The head is based on main 5e4e681.

Local, in a verifier-owned detached worktree:

- Root tests: 167 of 167.
- Service: lint, typecheck, and 25 of 25 tests.
- Prettier, the scaffold check and offline conversion: clean.
- Public CI 34879906584 is green.

Source review:

- Mapping is a non-reparentable master-detail child of Form Version, and Field Mapping of Mapping. Both inherit private sharing.
- The permission sets add only these two objects: Admin CRUD, Integration read, create and edit, and Supervisor read. View All and Modify All are false on all nine objects. Target Key is read-only.
- The handlers are trigger-only and without sharing. They return no data, give generic errors, and use fixed locking queries with no DML.
- The identifier regex is linear and refuses dots, spaces, operators and leading digits.

Verifier fresh org `kusanya-verifier-v1__claude-pr10__ca90e4a9a036` (00DQL00000bbjnL2AQ), created 18:22 UTC from the head's own scratch definition:

- Deployment: Succeeded, 140 of 140 components.
- `RunLocalTests` with coverage: Failed, 79 of 81, with 99% org-wide coverage. Two tests failed:
  - `MappingDefinitionModelTest.mappedRepeatTypeMustRemainRepeatUntilUnlinked`, line 378: `Expected: 10, Actual: 6`.
  - `FieldMappingDefinitionModelTest.representsZeroFalseWhitespaceAndBlankConstantsExplicitly`, line 89: expected `'  exact literal  '`, actual `'exact literal'`.
- Probes: anonymous Apex, synthetic data, one rolled-back transaction per probe, 0 rows left. `Kusanya_Admin` was assigned to the scratch admin.
  - P1. A whole Form deletes in the HWWS shape: a reference mapping parenting two repeat mappings, shared once-only sources, a `false` constant and a skip rule. 6 questions, 3 mappings, 6 field mappings and 1 skip rule go to 0.
  - P2. Deleting version 1 directly keeps the sibling version's mapping and its question reference.
  - P3. Direct deletes are refused while a field mapping or repeat mapping references the question. A mixed batch with an unreferenced question is refused whole. After the field mapping is removed, the question deletes.
  - P4. Deleting a parent mapping is refused alone and with one child. It succeeds with every child in the batch.
  - P5. A mapped repeat cannot become a section. An unmapped one can. A repeat mapping cannot point at a text question.
  - P6. A two-cycle, a reversed edge in one batch, a lookup field without a parent, and a self-parent (`CIRCULAR_DEPENDENCY`) are all refused.
  - P7. Cross-version field-mapping questions, parent mappings and repeat questions are refused.
  - P8. Target Key overwrites a caller-supplied value. It refuses a case variant in the same mapping, a duplicate in the same batch, and a rename onto an existing field. The same field in another mapping is allowed.
  - P9. Source Kind rules hold. `0` is preserved. Null and empty constants are both stored as null blanks, and Match Status defaults to null.
  - P10. Traversal and expression identifiers, a raw record-type ID, a collector-stamp traversal, a fractional Order and kind mismatches are refused. `Account__r` and `Account__R` are accepted.
  - P11. The Mapping and Field Mapping owners are not writeable.
  - P12. Undeleting a Form restores its mappings and field mappings with their references intact, but not its skip rules (note 30).
  - P13. Error messages do not name dependants.
  - Trim probe. Salesforce trims leading and trailing whitespace before the triggers run. Identifiers `Account\n`, `Account` and `Account\t` are stored as `Account`. Constants `\nline\n` and `\tTab` are stored as `line` and `Tab`. A whitespace-only constant becomes null. Inner spaces are kept.
- The org is kept, not deleted, so a test-and-docs-only fix can be re-checked without a new daily slot. It expires on its own within one day. At this review 2 of 6 daily slots were left; this org used one of them.

Findings:

- Finding 32, blocker. The query-count assertion at `MappingDefinitionModelTest` line 378 fails. A fully rejected `allOrNone=false` update leaves no queries in `Limits.getQueries()`. The guard's behaviour is correct. Remove the assertion, or measure cost on a successful path.
- Finding 33, blocker. Constants do not keep surrounding whitespace, so the test at line 89 fails. ADR 0013, around lines 71 to 75, and `docs/data-model.md` line 137 wrongly promise literal, untrimmed constants. Correct the contract, and assert the trimmed storage and whitespace-only-as-blank behaviour.
- Note 34, non-blocking. The identifier rule is lexical and accepts `__r`-suffixed and 255-character names. The future publisher must describe-check the target and reject non-object suffixes, with a test.

`HOLD: run 34879906645 at head ca90e4a`. Do not approve it: it would end as a non-retryable failed-tests result and use a scarce daily slot. Cancel it.

`HOLD: PR #10, 2 findings` (32, 33)

## 2026-09-15: Pre-push verification of PR #10 local candidate `623378e`

Scope: the builder's unpushed candidate 623378e, whose parent is ca90e4a. It answers findings 32 and 33 and records note 34. Requested before push, so the remaining scratch capacity is kept for hosted Apex.

Identity and scope:

- The builder clone is at 623378e, one commit ahead of remote head ca90e4a. It was fetched read-only into `refs/remotes/codex/pr10`.
- Exactly four files change: `MappingDefinitionModelTest.cls`, `FieldMappingDefinitionModelTest.cls`, ADR 0013 and `docs/data-model.md`. Under `salesforce/`, only the two test classes differ.

Review:

- Finding 32. The rejected reverse-type update still asserts the rejection and the stored `repeat` type. The `+4` query assertion moves to the successful type change after unlinking: three fixed Question guard queries plus the mapped-repeat probe.
- Finding 33. The constant regression covers boundary spaces, tabs, `\r\n`, whitespace-only, empty, null, `0` and `false`. It expects trimmed boundaries, interior spaces kept, and whitespace-only or empty values as null. It checks insert and a rotated update.
- ADR 0013 and the data model now describe the normalized contract. Whitespace-sensitive constants need a lossless representation or explicit rejection before any C3.12 round-trip claim.
- Note 34 is recorded for publisher Describe validation.

Evidence:

- Daily capacity had reset to 6 of 6 by 07:44 UTC, consistent with a reset near 07:00 UTC.
- Kept verifier org 00DQL00000bbjnL2AQ, still Active with yesterday's ca90e4a metadata:
  - The first redeploy was refused by source tracking with `SourceConflictError`, and that test run executed the old classes only. It is not evidence.
  - The redeploy of the full 623378e source with `--ignore-conflicts` at 07:48 UTC succeeded, 140 of 140.
  - `RunLocalTests` passed 81 of 81, including both previously failing tests. Coverage was 473 of 475 lines, 99%.
- The org was deleted and shows Deleted, with audit `deleteScratchOrg` "00DQL00000bbjnL" at 07:49:15 UTC. ActiveScratchOrg has 0 rows, and daily capacity stays 6 of 6.
- Local, in detached worktrees that were removed afterwards: root tests 167 of 167, service 25 of 25, Prettier, the scaffold check and `git diff --check` all clean.
- The ca90e4a probes P1 to P13 remain valid, because handlers and metadata are unchanged.

Operational: run 34879906645 on ca90e4a was still waiting at 07:44 UTC. Bill cancels it. The builder then pushes exactly 623378e. The verifier confirms the pushed head and the new run's trust boundary before SAFE TO APPROVE.

`SAFE TO PUSH: 623378e (findings 32 and 33 answered)`

`HOLD: PR #10, 2 findings` (32, 33), pending hosted success on the pushed head.

## 2026-09-15: PR #10 pushed head `623378e` and run 34945663516 cleared for approval

- The PR head is exactly 623378e, with tree e04391c, identical to the verified local candidate. It is one commit on ca90e4a, based on main 5e4e681, from the same repository.
- Changed files from ca90e4a: the two test classes, ADR 0013 and `docs/data-model.md`. Workflows, harness scripts, packages, the project and scratch definitions are unchanged. The pin 1d0edc1 appears twice.
- Salesforce run 34945663516: `pull_request` event, exact head, attempt 1. The policy job succeeded (classification and exact-head budget). The Apex job is waiting with 0 steps. It is the only waiting run.
- Public CI 34945663738 succeeded on the exact head.
- Old run 34879906645 on ca90e4a completed after its rejection with no Apex steps. Its head differs, so it is outside this head's budget.
- At 08:16 UTC, 6 of 6 daily and 3 of 3 active scratch orgs were free. 0 were active.

`SAFE TO APPROVE: run 34945663516 at head 623378e`

`HOLD: PR #10, 2 findings` (32, 33), pending hosted success with an exact-head marker and a Deleted org.

## 2026-09-16: PR #10 hosted Apex evidence, run 34945663516 attempt 1 at `623378e`; PASS

Run and head:

- Attempt 1 succeeded on the exact head. The `salesforce-ci` approval was by cobitechsolutions. The policy, Apex and gate jobs all succeeded.
- The PR head is unchanged. It is up to date with main 5e4e681, the merge state is CLEAN, and all five checks are green.

Apex job 104304413061, full log of 531 lines:

- The confirm step printed the exact head, and the stale-head check passed.
- The in-job budget recheck returned `allowed: true, kind: initial`.
- Result: `81 passed; 473/475 executable lines (99.58%)`.
- There is exactly one marker: schema 1, role `ci`, run `34945663516-1`, full head 623378e, started 20:23:22.566Z, outcome `passed`, retryable false.
- Cleanup: 1 owned scratch org deleted, 0 already deleted. Tag `kusanya-ci-v1__34945663516-1__623378eec361__ab75e796a3d6`. The fallback cleanup was skipped after success, and logout succeeded.

Dev Hub:

- ScratchOrgInfo shows the tag as Deleted, for org 00DRu00000YJXgz, created 20:23:27 and last modified 20:24:27 UTC.
- Setup Audit Trail has `deleteScratchOrg` for "00DRu00000YJXgz" at 20:24:32 UTC. ActiveScratchOrg has 0 rows.

Credential hygiene: the scan found no `force://` URLs, org session IDs, bearer, access or refresh tokens, JWTs, private keys or email addresses. All 10 masks are GitHub redactions.

Note 35, non-blocking: the only warning is GitHub's Node.js 20 deprecation notice for the pinned `actions/checkout` and `actions/setup-node` SHAs, forced to Node 24. Updating those pins needs a separately reviewed workflow change.

Findings 32 and 33 are closed. Note 34 is recorded. Notes 24, 25 and 27 to 31 carry forward, and note 35 is added. This is a Phase 1 model unit, not the phase gate.

`PASS: PR #10 may be merged`

## 2026-09-16: PR #10 merged

Bill squash-merged PR #10 as f435129. Its tree, e04391c, is identical to the verified head 623378e, so the hosted Apex evidence from run 34945663516 and my kept-org run apply to main unchanged. Main CI 35024347296 passed.

Carried forward to later reviewed units, none blocking:

- Note 24: the ADR 0011 read policy and its effective-access tests, now including Mapping and Field Mapping, before any Phase 2 definition reader.
- Note 25: the untested insert path of the Current Version rule; the resolver handles only `__c`.
- Note 27: Author Notes exclusion must be proven at the compiler and delivery layer.
- Note 28: compile-time rejection of a repeat counted from its own subtree and of non-answerable skip sources.
- Note 29: working-directory executable discovery in the Windows launcher.
- Note 30: undelete restores a Form without its skip rules, and a lone child without its parent.
- Note 31: a single dropped GitHub API response fails the confirm step, and logout fails when the CLI is absent.
- Note 34: the target identifier rule is lexical and accepts names such as `Account__r`; the publisher must Describe-check targets.
- Note 35: the pinned `actions/checkout` and `actions/setup-node` target Node.js 20; updating them needs a separately reviewed workflow change.
- Whitespace-sensitive constants need a lossless form or explicit rejection before any C3.12 round-trip claim (ADR 0013).
- A namespaced suite run once `ksny` is linked, and C10 tests 10 and 12 before the Phase 1 gate.

## 2026-09-16: Source and security review of PR #12 head `1eace21`, the bounded XForm compiler

Scope: the first compiler unit. It adds `service/src/compiler` (types, definition decoding, expression parsing, compilation and rendering), its tests and fixtures, the optional offline `scripts/check-compiler-odk.mjs`, ADR 0014 and compiler documentation. The review was requested before Bill approves run 35060206558.

Trust boundary:

- No workflow, harness, Salesforce, permission, package or lockfile change, and no new dependency. The pin 1d0edc1 appears twice. The head is one commit on current main f5f4eb1.
- No verifier scratch org was created or needed: nothing under `salesforce/` changed since PR #10, which already has hosted and fresh-org evidence.

Local, in a detached worktree:

- Root tests 167 of 167, service 70 of 70, lint, typecheck, Prettier and the scaffold check.
- Public CI 35060206544 is green.

Independent probes, run against a locally built `compileForm` with synthetic input only:

- Author Notes and Regex Example never reach XML; Hint does. Diagnostics carry a code and a structural location only. This is the compiler half of note 27.
- XML injection attempts through title, label, hint, constraint message and choice values are escaped in text and attributes.
- A choice value containing both quote kinds compiles to a correct concat literal. Unknown functions, `instance()`, predicates, axes, foreign roots, wrong arity and comment syntax are refused.
- Sibling-repeat, deeper-repeat and non-answerable references are refused; same-repeat and root references work.
- Direct, self, inherited and repeat-count dependency cycles are caught, while self-referencing constraints remain allowed.
- A repeat counted from inside its own subtree is refused, which answers note 28 at the compiler.
- Accessors, proxies, a `__proto__` key, sparse and extended arrays and unknown fields are refused. `Object.prototype` stays clean and the input is not mutated.
- Control characters and lone surrogates are refused, astral characters survive, and CR is escaped.
- Reordered questions and choices produce identical bytes.
- Depth, question count, reused-list expansion, expression length and nesting stop at the documented limits.
- Reserved and malformed question names are refused.

Validator, reproduced independently: ODK Validate 1.20.0 was downloaded, its SHA-256 confirmed as the pinned `92756ea4`, and the script run with Java 21. Four fixtures valid, both negative controls rejected. My own nested repeat forms also parse.

Note 36, non-blocking: nested repeats emit relative counts, `jr:count="../n"` and `jr:count="../_ksny_count_x"`, while root repeats emit absolute paths. The ODK specification does not define the evaluation context for `jr:count`, and its example uses an absolute path. Validate parses both nested forms, but parsing is not evaluation. If a client evaluates against the repeat's parent, the relative path reads one level too high. Test nested counted repeats in ODK Collect and Enketo before any C10.2 or C10.3 claim, and record the gap in `docs/compiler.md`.

Capacity at 05:58 UTC: 5 of 6 daily and 3 of 3 active, with none in use.

`SAFE TO APPROVE: run 35060206558 at head 1eace21`

`HOLD: PR #12, 0 findings`, pending hosted success with an exact-head marker and a Deleted org.

## 2026-09-16: PR #12 hosted Apex evidence, run 35060206558 attempt 1 at `1eace21`; PASS

Run and head:

- Attempt 1 succeeded on the exact head. The `salesforce-ci` approval was by cobitechsolutions. The policy, Apex and gate jobs all succeeded.
- The PR head is unchanged and up to date with main f5f4eb1. Merge state is CLEAN, and all five checks are green.

Apex job 104678794852, full log of 531 lines:

- The confirm step printed the exact head, and the stale-head check passed.
- The in-job budget recheck returned `allowed: true, kind: initial`.
- Result: `Apex for 1eace21: 81 passed; 473/475 executable lines (99.58%)`, matching the PR #10 baseline because no Salesforce source changed.
- Exactly one marker: schema 1, role `ci`, run `35060206558-1`, full head 1eace21, started 06:08:05.265Z, outcome `passed`, retryable false.
- Cleanup: 1 owned scratch org deleted, 0 already deleted, tag `kusanya-ci-v1__35060206558-1__1eace21c9f62__1c4b56c183af`. Fallback cleanup skipped after success, logout succeeded.

Dev Hub, checked independently:

- ScratchOrgInfo shows the tag as Deleted, for org 00DEc00000liKHk, created 06:08:09 and last modified 06:09:06 UTC.
- Setup Audit Trail has `deleteScratchOrg` for "00DEc00000liKHk" at 06:09:09 UTC. ActiveScratchOrg has 0 rows, and 4 of 6 daily slots remain.

Credential hygiene: no `force://` URLs, org session IDs, bearer, access or refresh tokens, JWTs, private keys or email addresses. All 10 masks are GitHub redactions. The only warning is note 35's Node.js 20 deprecation notice.

The compiler evidence rests on the source review and probes recorded in the previous entry, together with the independently reproduced ODK Validate run.

Note 36 stays open for the runtime unit: nested `jr:count` evaluation must be tested in ODK Collect and Enketo before any C10.2 or C10.3 claim. Notes 24, 25, 27 to 31, 34 and 35 carry forward; notes 27 and 28 are answered at the compiler layer only, and delivery and publication still owe their own tests. This is a Phase 1 unit, not the phase gate, and no C10 acceptance test is claimed.

`PASS: PR #12 may be merged`

## 2026-09-16: PR #12 merged

Bill merged PR #12 as bff5791. Its tree, 329dfc7, is identical to the verified head 1eace21, so the hosted Apex evidence from run 35060206558, my source review, my compiler probes and my reproduced ODK Validate run all apply to main unchanged. Main CI 35062941552 passed.

Carried forward to later reviewed units, none blocking:

- Note 24: the ADR 0011 read policy and its effective-access tests, including Mapping and Field Mapping, before any Phase 2 definition reader.
- Note 25: the untested insert path of the Current Version rule; the resolver handles only `__c`.
- Note 27: Author Notes exclusion is answered in the compiler only. Delivery and publication still need their own regression that notes never reach collector output.
- Note 28: a repeat counted from its own subtree and non-answerable skip sources are now rejected by the compiler. Storage still accepts them, so authoring and import paths must keep reporting the compiler's rejection.
- Note 29: working-directory executable discovery in the Windows launcher.
- Note 30: undelete restores a Form without its skip rules, and a lone child without its parent.
- Note 31: a single dropped GitHub API response fails the confirm step, and logout fails when the CLI is absent.
- Note 34: the target identifier rule is lexical and accepts names such as `Account__r`; the publisher must Describe-check targets.
- Note 35: the pinned `actions/checkout` and `actions/setup-node` target Node.js 20; updating them needs a separately reviewed workflow change.
- Note 36: nested repeats emit relative `jr:count` paths whose evaluation context the ODK specification does not define. Test nested counted repeats in ODK Collect and Enketo, and record the gap in `docs/compiler.md`, before any C10.2 or C10.3 claim.
- Whitespace-sensitive constants need a lossless form or explicit rejection before any C3.12 round-trip claim (ADR 0013).
- A namespaced suite run once `ksny` is linked, and C10 tests 10 and 12 before the Phase 1 gate.

Phase 1 remains in progress. Publication, adapters, mapping execution, XLSForm round trips, print view and CLI publishing are still outstanding, and no C10 acceptance test is claimed by any unit so far.

## 2026-09-16: Source and security review of PR #14 head `17bf838`, client-engine regressions and draft metadata

Scope: the compiler's metadata fix, new repeat-runtime fixtures and tests, the optional `scripts/runtime` probe package for Enketo and JavaRosa, ADR 0015 and the runtime runbook. The review was requested before Bill approves run 35065752715.

Trust boundary:

- No workflow, credentialed harness, Salesforce metadata, permission, namespace, project or package change. Root and service manifests and lockfiles are untouched, and the pin 1d0edc1 appears twice. The head is one commit on current main f8bf523.
- `scripts/runtime` carries its own manifest and lockfile. Nothing in the service, CI or a root install pulls it in.

Product change: `render.ts` emits `orx:meta` and `orx:instanceID` in the already declared OpenRosa namespace, binds `/data/orx:meta/orx:instanceID`, and wraps the generated calculation in `once()`. The rest of the diff is tests, fixtures, optional probes and documentation.

Local, in a detached worktree:

- Root tests 167 of 167, service 75 of 75, lint, typecheck, Prettier and the scaffold check. A Prettier warning during my run came from my own scratch file; the tracked tree is clean.
- Public CI 35065752630 is green.
- My PR #12 compiler probes still pass at this head: no author-only leakage, no XML or XPath injection, deterministic bytes, hostile input refused.

Reproduced independently:

- ODK Validate 1.20.0, jar hash `92756ea4`: four fixtures valid, both negative controls rejected. The metadata change does not break parsing.
- JavaRosa 6.0.0, the engine pinned by Collect v2026.3.4. All four jars were downloaded and each SHA-256 matched the manifest. The probe passed with Zulu 21:
  - Nested counts start `[0,0]`, become `[2,3]` independently per outer instance, with the fixed inner helper at `[3,3]`.
  - A serialized draft reloads with `[2,3]`, 11 distinct answers and the once-only answer.
  - The instance ID is stable across reload, and the old-metadata negative control reproduces ID regeneration.
  - The wrong-count-path negative control is detected: `[2,2]` where `[0,0]` was expected.
  - Section-scoped and root-sourced counts behave, and a reduction retains existing instances.

Not reproduced: the Enketo browser probe. Running it requires installing optional packages whose tree carries five advisories, two high. The script reads safely: it asserts pinned versions, uses a fresh throwaway browser profile, aborts every page request, is watchdogged, and asserts zero attempted requests. The builder's Enketo result stands unreproduced until Bill authorizes that install.

Note 36 is narrowed, not closed. Nested relative `jr:count` now has engine evidence in both clients, and I reproduced the JavaRosa half. The outstanding gap is the actual Collect Android UI.

Note 37, non-blocking, for publication and ingestion: JavaRosa retains already-created instances when a count drops, while the builder's Enketo run removes a trailing answered row. The same form and action therefore produce different submitted data per client, so a submitted repeat count cannot be assumed to equal the answered count, and mapping execution would write different numbers of target records. Decide one rule before C10.2 or C10.3, test it in both engines, and make the compiler warning say the behaviour is client-specific.

Note 38, non-blocking, for dependency hygiene: the advisories are recorded and the isolation is real. Keep it that way with a test asserting the root and service lockfiles never contain these packages, and keep the networked `npm install` step explicit in the runbook. Deploying Enketo or processing customer XML with these packages needs its own security review.

On Bill's device question, my recommendation is a purpose-made emulator image rather than a phone in daily use, with a dedicated offline synthetic project, no client org data and no Collect upgrade. The decision is Bill's.

`SAFE TO APPROVE: run 35065752715 at head 17bf838`

`HOLD: PR #14, 0 findings`, pending hosted success with an exact-head marker and a Deleted org.

## 2026-09-16: PR #14 hosted Apex evidence, run 35065752715 attempt 1 at `17bf838`; PASS

Run and head:

- Attempt 1 succeeded on the exact head, approved for `salesforce-ci` by cobitechsolutions. The policy, Apex and gate jobs all succeeded.
- The PR head is unchanged and up to date with main f8bf523. Merge state is CLEAN, and all five checks are green.

Apex job 104695602752, full log of 531 lines:

- The confirm step printed the exact head, and the stale-head check passed.
- The in-job budget recheck returned `allowed: true, kind: initial`.
- Result: `81 passed; 473/475 executable lines (99.58%)`, matching the PR #12 baseline because no Salesforce source changed.
- Exactly one marker: schema 1, role `ci`, run `35065752715-1`, full head 17bf838, started 07:17:48.019Z, outcome `passed`, retryable false.
- Cleanup: 1 owned scratch org deleted, 0 already deleted, tag `kusanya-ci-v1__35065752715-1__17bf8389aceb__12a8a88fa564`. Fallback cleanup skipped after success, logout succeeded.

Dev Hub, checked independently:

- ScratchOrgInfo shows the tag as Deleted, for org 00DRL00000WHR7q, created 07:17:52 and last modified 07:18:57 UTC.
- Setup Audit Trail has `deleteScratchOrg` for "00DRL00000WHR7q" at 07:19:01 UTC. ActiveScratchOrg has 0 rows, and 5 of 6 daily slots remain.

Credential hygiene: no `force://` URLs, org session IDs, bearer, access or refresh tokens, JWTs, private keys or email addresses in the full log. All 10 masks are GitHub redactions. The only warning is note 35's Node.js 20 deprecation notice.

The runtime evidence rests on the previous entry: the source and security review, the reproduced pinned ODK Validate run, and the reproduced JavaRosa 6.0.0 probe with all four jar hashes matched.

Open items carried forward, none blocking this unit: note 36 narrowed to the actual Collect Android UI, pending Bill's device or emulator decision; note 37 on client-specific count reduction, which needs a publication or ingestion rule tested in both engines before C10.2 or C10.3; note 38 on keeping probe dependencies out of the service and root lockfiles; the unreproduced Enketo browser probe, which stays the builder's result until Bill authorizes that install; and notes 24, 25, 27 to 31, 34 and 35.

This is a Phase 1 unit, not the phase gate, and no C10 acceptance test is claimed.

`PASS: PR #14 may be merged`

## 2026-09-16: PR #14 merged

Bill merged PR #14 as 6356a87. Its tree, 0456ab1, is identical to the verified head 17bf838, so the hosted Apex evidence from run 35065752715, my source and security review, and my reproduced ODK Validate and JavaRosa runs all apply to main unchanged. Main CI 35069148632 passed.

Carried forward to later reviewed units, none blocking:

- Note 24: the ADR 0011 read policy and its effective-access tests, including Mapping and Field Mapping, before any Phase 2 definition reader.
- Note 25: the untested insert path of the Current Version rule; the resolver handles only `__c`.
- Note 27: Author Notes exclusion is proven in the compiler only. Delivery and publication still need their own regression.
- Note 28: the compiler rejects a repeat counted from its own subtree and non-answerable skip sources; storage still accepts them, so authoring and import paths must surface those rejections.
- Note 29: working-directory executable discovery in the Windows launcher.
- Note 30: undelete restores a Form without its skip rules, and a lone child without its parent.
- Note 31: a single dropped GitHub API response fails the confirm step, and logout fails when the CLI is absent.
- Note 34: the target identifier rule is lexical and accepts names such as `Account__r`; the publisher must Describe-check targets.
- Note 35: the pinned `actions/checkout` and `actions/setup-node` target Node.js 20; updating them needs a separately reviewed workflow change.
- Note 36, narrowed: nested relative `jr:count` now has engine evidence in Enketo and JavaRosa, and I reproduced the JavaRosa half. The actual Collect Android UI remains untested, pending Bill's device or emulator decision.
- Note 37: JavaRosa retains already-created instances when a repeat count drops, while Enketo removes a trailing answered row. Choose one publication or ingestion rule, test it in both engines, and make the compiler warning say the behaviour is client-specific, before C10.2 or C10.3.
- Note 38: keep the optional probe dependencies out of the root and service lockfiles, ideally enforced by a test, and keep their networked installation an explicit, separately authorized step.

Evidence limitation carried forward: I have not reproduced the Enketo browser probe, because it requires installing optional packages carrying five advisories, two of them high. That result remains the builder's alone until Bill authorizes the installation. The five advisories themselves remain disclosed and unremediated, and none of this tooling is cleared for production or customer XML.

Also outstanding: whitespace-sensitive constants need a lossless form or explicit rejection before any C3.12 round-trip claim (ADR 0013), a namespaced suite run once `ksny` is linked, and C10 tests 10 and 12 before the Phase 1 gate.

Phase 1 remains in progress. Publication, adapters, mapping execution, XLSForm round trips, print view and CLI publishing are still outstanding, and no C10 acceptance test is claimed by any unit so far.

## 2026-09-16: Source and security review of PR #16 head `21aa80b`, the reviewer-only print view

Scope: the extraction of `prepareForm` from `compile.ts`, the new `service/src/print` renderer, mapping-summary decoding and styles, the note 38 isolation tripwire, the synthetic export script, ADR 0016 and the print runbook. The review was requested before Bill approves run 35078524828.

Trust boundary:

- No workflow, credentialed harness, Salesforce, permission, namespace or package change. All four manifests and lockfiles are untouched, and the pin 1d0edc1 appears twice. The head is one commit on current main bb292e6.

Compiler equivalence, tested rather than assumed. I built both main and this head and compared their output directly:

- Six shared fixtures, the four ODK fixtures and both repeat-runtime fixtures, produce byte-identical XML and identical warnings.
- Seven verifier-built definitions, including trees, selects with hostile text, fixed and answer-driven repeats and three that must be rejected, produce identical result objects. The dependency-cycle, reference-scope and input-shape rejections keep the same codes and locations.

Print view, probed with hostile content in the title, labels, hints, author notes, constraint message, choice labels and a mapping constant:

- Tags in the output are limited to `a article aside body code dd div dl dt footer h1 h2 h3 h4 head header html li main meta nav ol p section span style title`. There is no `script`, `img`, `iframe`, `object`, `embed` or `form`.
- Attributes are limited to `aria-label aria-labelledby charset class href http-equiv id lang name`. No event handlers, and no supplied text reaches an attribute.
- Every `href` is a generated local anchor such as `#q-1` or `#m-1`. No `javascript:` and no external URL.
- One inline `<style>` and no `<link>`. The CSP `sha256` matches the actual stylesheet, so an altered stylesheet stops applying.
- The hostile payload appears only as escaped text.

Mapping summaries: proxies, accessors, a `__proto__` key, unknown fields, traversal target names, unknown or non-answerable question references, a constant and question supplied together, case-insensitive duplicate targets, parent cycles, a matching field on a main mapping and a repeat question on a main mapping are each refused with a specific code and location. `Object.prototype` stays clean.

Determinism and immutability: identical inputs give identical HTML; reversing questions, choice lists, mappings and field lists gives identical HTML; neither input is mutated; and a definition the compiler rejects is rejected identically by the print view, so there is no permissive preview.

Note 38 is answered, and I verified the tripwire fires. Adding `playwright-core` to the root manifest in my own worktree made `scripts/runtime-isolation.test.mjs` fail 2 of its 85 cases; restoring the manifest returned all 85 to passing. The test is explicit that it is a source-level regression check, not a security boundary.

Local, in a detached worktree: root tests 252 of 252, service 112 of 112, lint, typecheck, format check and scaffold. Public CI 35078524764 is green.

Note 39, non-blocking, for whichever unit first delivers this HTML: the output intentionally contains author-only content, and `audience: 'reviewer-only'` should gate delivery rather than merely describe it. Require reviewer authorization at the boundary, never a collector or public route, send `Cache-Control: no-store` with no shared cache, keep the CSP as a real response header with `X-Content-Type-Options: nosniff`, and test that a collector-scoped principal cannot fetch it. Record this in ADR 0016's consequences.

Notes 36 and 37 stay open, and the Enketo probe remains unreproduced by me pending Bill's decision.

Capacity at 09:27 UTC: 5 of 6 daily and 3 of 3 active, with none in use.

`SAFE TO APPROVE: run 35078524828 at head 21aa80b`

`HOLD: PR #16, 0 findings`, pending hosted success with an exact-head marker and a Deleted org.

## 2026-09-16: PR #16 hosted Apex evidence, run 35078524828 attempt 1 at `21aa80b`; PASS

Run and head:

- Attempt 1 succeeded on the exact head, approved for `salesforce-ci` by cobitechsolutions. The policy, Apex and gate jobs all succeeded.
- The PR head is unchanged and up to date with main bb292e6. Merge state is CLEAN, and all five checks are green.

Apex job 104736726647, full log of 531 lines:

- The confirm step printed the exact head, and the stale-head check passed.
- The in-job budget recheck returned `allowed: true, kind: initial`.
- Result: `81 passed; 473/475 executable lines (99.58%)`, matching the established baseline because no Salesforce source changed.
- Exactly one marker: schema 1, role `ci`, run `35078524828-1`, full head 21aa80b, started 09:46:01.566Z, outcome `passed`, retryable false.
- Cleanup: 1 owned scratch org deleted, 0 already deleted, tag `kusanya-ci-v1__35078524828-1__21aa80bb30ec__8179e442252f`. Fallback cleanup skipped after success, logout succeeded.

Dev Hub, checked independently:

- ScratchOrgInfo shows the tag as Deleted, for org 00DRK00000avp7c, created 09:46:06 and last modified 09:47:14 UTC.
- Setup Audit Trail has `deleteScratchOrg` for "00DRK00000avp7c" at 09:47:29 UTC. ActiveScratchOrg has 0 rows.

Credential hygiene: no `force://` URLs, org session IDs, bearer, access or refresh tokens, JWTs, private keys or email addresses in the full log. All 10 masks are GitHub redactions. The only warning is note 35's Node.js 20 deprecation notice.

The print-view evidence rests on the previous entry: proven byte-identical compiler output across the `prepare.ts` refactor, the enumerated inert HTML output, refusal of hostile mapping shapes, deterministic rendering and the note 38 tripwire verified by mutation.

Open items carried forward, none blocking this unit: note 39 on gating future delivery of the reviewer HTML, including an ADR 0016 consequences update; note 36 on the untested Collect Android UI; note 37 on client-specific count reduction; the Enketo probe still unreproduced by the verifier; and notes 24, 25, 27 to 31, 34 and 35. Note 38 is answered.

This is a Phase 1 unit, not the phase gate, and no C10 acceptance test is claimed.

`PASS: PR #16 may be merged`

## 2026-09-16: PR #16 merged

Bill merged PR #16 as fc64c38. Its tree, 7514ffb, is identical to the verified head 21aa80b, so the hosted Apex evidence from run 35078524828, my source and security review, my proven compiler byte equivalence and my print-view probes all apply to main unchanged.

Note 38 is answered: the optional probe dependencies are kept out of the root and service manifests, lockfiles, workflows and container build by `scripts/runtime-isolation.test.mjs`, whose 85 cases I verified by mutation.

Carried forward to later reviewed units, none blocking:

- Note 24: the ADR 0011 read policy and its effective-access tests, including Mapping and Field Mapping, before any Phase 2 definition reader.
- Note 25: the untested insert path of the Current Version rule; the resolver handles only `__c`.
- Note 27: Author Notes exclusion is proven in the compiler only. Delivery and publication still need their own regression.
- Note 28: the compiler rejects a repeat counted from its own subtree and non-answerable skip sources; storage still accepts them.
- Note 29: working-directory executable discovery in the Windows launcher.
- Note 30: undelete restores a Form without its skip rules, and a lone child without its parent.
- Note 31: a single dropped GitHub API response fails the confirm step, and logout fails when the CLI is absent.
- Note 34: the target identifier rule is lexical and accepts names such as `Account__r`; the publisher must Describe-check targets.
- Note 35: the pinned `actions/checkout` and `actions/setup-node` target Node.js 20; updating them needs a separately reviewed workflow change.
- Note 36: the actual Collect Android UI is still untested. Engine evidence exists for JavaRosa, which I reproduced, and for Enketo, which I have not. Bill's device or emulator decision is outstanding.
- Note 37: JavaRosa retains already-created instances when a repeat count drops, while Enketo removes a trailing answered row. Choose one publication or ingestion rule and test it in both engines before C10.2 or C10.3.
- Note 39: the first unit that delivers the reviewer HTML must gate on `audience`, require reviewer authorization, never reuse a collector or public route, send `Cache-Control: no-store` with no shared cache, keep the Content-Security-Policy as a real response header with `X-Content-Type-Options: nosniff`, and test that a collector-scoped principal cannot fetch it. ADR 0016's consequences should record this.

Evidence limitation carried forward: I have not reproduced the Enketo browser probe, because it requires installing optional packages carrying five advisories, two of them high. That result remains the builder's alone until Bill authorizes the installation, and none of that tooling is cleared for production or customer XML.

Also outstanding: whitespace-sensitive constants need a lossless form or explicit rejection before any C3.12 round-trip claim (ADR 0013), a namespaced suite run once `ksny` is linked, and C10 tests 10 and 12 before the Phase 1 gate.

Phase 1 remains in progress. Publication, adapters, mapping execution, XLSForm round trips and CLI publishing are still outstanding, and no C10 acceptance test is claimed by any unit so far.

## 2026-09-16: Source and security review of PR #18 head `b8989c5`, authoring bundles and the XLSForm table profile

Scope: `service/src/interchange/bundle.ts` and `xlsform-tables.ts`, their tests, the offline `check-interchange-fixtures.mjs`, ADR 0017, the interchange runbook, and ADR 0016's recording of note 39. The review was requested before Bill approves run 35087014934.

Trust boundary:

- No workflow, credentialed harness, Salesforce, permission, namespace or package change. All four manifests and lockfiles are untouched, as is the runtime probe package, and the pin 1d0edc1 appears twice. The head is one commit on current main 0f1b209.
- The compiler and print modules are unchanged, so nothing in this unit can alter collector XML.

Local, in a detached worktree: root tests 252 of 252, service 151 of 151, lint, typecheck, format check and scaffold. The interchange checker ran its eight round trips and refused each changed projection. Public CI 35087014933 is green.

Verifier probes, synthetic input only:

- Numbers at the JSON text boundary. `3`, `3.00e0` and `0.30e1` are accepted and stored as `3`. `1.0000000000000001`, `12345678901234567890`, `1e-400` and `1e400` are refused with `BUNDLE_INPUT_NUMBER`, so silent rounding and underflow cannot pass. `+3`, `03`, `0x3` and `3.` are syntax errors, and `-0` normalizes to `0` as ADR 0017 states.
- Strict parsing. Duplicate keys are refused rather than last-key-wins. `__proto__` and `constructor` keys, extra envelope keys, a wrong `kind`, a live object instead of a string, trailing commas, trailing text, comments and `NaN` each have their own rejection code. `Object.prototype` stays clean.
- Round-trip fidelity. An awkward definition re-imports to identical canonical JSON, compiles to byte-identical XML and is idempotent on re-export. It preserves an unused choice list, author notes, an empty-string default, the literal string `false`, a null constant and a title with double spacing and an accent, with no trimming or Unicode normalization.
- Table tampering. Editing a survey label, settings title or choice label; dropping a column; adding a row; renumbering a source index; editing a source chunk; swapping two distinct choice rows; blanking a cell; removing a row; adding an unknown sheet; and putting a number in a cell are all refused with a specific code and location. A clean import reproduces exactly the bundle JSON.
- Chunking. Twelve emoji-heavy annotations produced 7 chunks of at most 30,000 units. No chunk ends with a high surrogate or begins with a low surrogate, every chunk is well-formed UTF-16, the joined text parses, and the annotations survive exactly. A truncated middle chunk is caught.
- Hostile object shapes. Cycles, proxies, accessors, sparse arrays, over-deep nesting and oversize text are refused, and inputs are not mutated.

Note 40, non-blocking, for the first unit that writes a real workbook or CSV: cells are plain JSON strings here and nothing executes, and the profile correctly preserves author text verbatim, including cells beginning with `=`, `+`, `-` and `@`. My probe produced survey cells `=1+1`, `+cmd|calc`, `@SUM(A1)` and `-2+3`. Altering them here would break the projection comparison, so neutralization belongs in the future writer: write display cells as explicit text or prefix the dangerous leading characters, keep `kusanya_source` byte-exact, and reverse or mirror that transformation on import so the round trip still holds. Record it in ADR 0017's consequences beside the converter-equivalence gap.

Notes 36, 37 and 39 stay open, and the Enketo probe remains unreproduced by me pending Bill's decision.

Capacity at 11:12 UTC: 4 of 6 daily and 3 of 3 active, with none in use.

`SAFE TO APPROVE: run 35087014934 at head b8989c5`

`HOLD: PR #18, 0 findings`, pending hosted success with an exact-head marker and a Deleted org.

## 2026-09-16: PR #18 hosted Apex evidence, run 35087014934 attempt 1 at `b8989c5`; PASS

Run and head:

- Attempt 1 succeeded on the exact head, approved for `salesforce-ci` by cobitechsolutions. The policy, Apex and gate jobs all succeeded.
- The PR head is unchanged and up to date with main 0f1b209. Merge state is CLEAN, and all five checks are green.

Apex job 104764209775, full log of 531 lines:

- The confirm step printed the exact head, and the stale-head check passed.
- The in-job budget recheck returned `allowed: true, kind: initial`.
- Result: `81 passed; 473/475 executable lines (99.58%)`, matching the established baseline because no Salesforce source changed.
- Exactly one marker: schema 1, role `ci`, run `35087014934-1`, full head b8989c5, started 11:24:01.462Z, outcome `passed`, retryable false.
- Cleanup: 1 owned scratch org deleted, 0 already deleted, tag `kusanya-ci-v1__35087014934-1__b8989c5271dc__ba1d9ce00c35`. Fallback cleanup skipped after success, logout succeeded.

Dev Hub, checked independently:

- ScratchOrgInfo shows the tag as Deleted, for org 00DRL00000WHzuH, created 11:24:06 and last modified 11:25:00 UTC.
- Setup Audit Trail has `deleteScratchOrg` for "00DRL00000WHzuH" at 11:25:11 UTC. ActiveScratchOrg has 0 rows.

Credential hygiene: no `force://` URLs, org session IDs, bearer, access or refresh tokens, JWTs, private keys or email addresses in the full log. All 10 masks are GitHub redactions. The only warning is note 35's Node.js 20 deprecation notice.

The interchange evidence rests on the previous entry: exact-decimal JSON handling, duplicate-key refusal, byte-identical round trips, refusal of every table tamper tried, correct astral chunking and refusal of hostile object shapes.

Open items carried forward, none blocking this unit: note 40 on neutralizing spreadsheet formula prefixes in a future workbook or CSV writer, with an ADR 0017 consequences update; note 39 on gating reviewer HTML delivery; note 36 on the untested Collect Android UI; note 37 on client-specific count reduction; the Enketo probe still unreproduced by the verifier; and notes 24, 25, 27 to 31, 34 and 35. Note 38 is answered.

This is a Phase 1 unit, not the phase gate, and no C10 acceptance test is claimed.

`PASS: PR #18 may be merged`

## 2026-09-16: PR #18 merged

Bill squash-merged PR #18 as 3caea7a. Its tree, 5191040, is identical to the verified head b8989c5, so the hosted Apex evidence from run 35087014934, my source and security review, and my interchange probes all apply to main unchanged. Main CI 35092417058 passed.

Carried forward to later reviewed units, none blocking:

- Note 24: the ADR 0011 read policy and its effective-access tests, including Mapping and Field Mapping, before any Phase 2 definition reader.
- Note 25: the untested insert path of the Current Version rule; the resolver handles only `__c`.
- Note 27: Author Notes exclusion is proven in the compiler only. Delivery and publication still need their own regression.
- Note 28: the compiler rejects a repeat counted from its own subtree and non-answerable skip sources; storage still accepts them.
- Note 29: working-directory executable discovery in the Windows launcher.
- Note 30: undelete restores a Form without its skip rules, and a lone child without its parent.
- Note 31: a single dropped GitHub API response fails the confirm step, and logout fails when the CLI is absent.
- Note 34: the target identifier rule is lexical and accepts names such as `Account__r`; the publisher must Describe-check targets.
- Note 35: the pinned `actions/checkout` and `actions/setup-node` target Node.js 20; updating them needs a separately reviewed workflow change.
- Note 36: the actual Collect Android UI is still untested. Engine evidence exists for JavaRosa, which I reproduced, and for Enketo, which I have not. Bill's device or emulator decision is outstanding.
- Note 37: JavaRosa retains already-created instances when a repeat count drops, while Enketo removes a trailing answered row. Choose one publication or ingestion rule and test it in both engines before C10.2 or C10.3.
- Note 39: the first unit that delivers the reviewer HTML must gate on `audience`, require reviewer authorization, send `Cache-Control: no-store`, keep the CSP as a real response header with `X-Content-Type-Options: nosniff`, and test that a collector-scoped principal cannot fetch it. ADR 0016 records this.
- Note 40: the first unit that writes a real workbook or CSV must neutralize leading `=`, `+`, `-` and `@` in display cells, keep `kusanya_source` byte-exact, and mirror or reverse that transformation on import. ADR 0017's consequences should record this.

Note 38 remains answered by the isolation tripwire.

Evidence limitation carried forward: I have not reproduced the Enketo browser probe, because it requires installing optional packages carrying five advisories, two of them high. That result remains the builder's alone until Bill authorizes the installation, and none of that tooling is cleared for production or customer XML.

Also outstanding: whitespace-sensitive constants need a lossless form or explicit rejection before any C3.12 round-trip claim (ADR 0013), the table profile is not proven through an external XLSForm converter, a namespaced suite run once `ksny` is linked, and C10 tests 10 and 12 before the Phase 1 gate.

Phase 1 remains in progress. Publication, adapters, mapping execution and CLI publishing are still outstanding, and no C10 acceptance test is claimed by any unit so far.

## 2026-09-16: Source and security review of PR #20 head `4b275bf`, the strict XLSX adapter; one finding

Scope: `service/src/interchange/xlsx-workbook.ts` and its tests, `scripts/check-xlsx-fixture.mjs`, ADR 0018, and the ADR 0017, interchange, roadmap, architecture and licence-inventory updates. Bill asked for a source and security review before deciding on run 35096046148.

Base history and trust boundary:

- PR #19 merged as e90b05e, and main CI 35093462960 passed before this branch began. The head is one commit on that main.
- No workflow, credentialed harness, Salesforce, permission, namespace or root manifest change. The runtime probe package is untouched, and the pin 1d0edc1 appears twice.
- The service adds `fflate` 0.8.3 (MIT) and `saxes` 6.0.0 (ISC) with `xmlchars` 2.2.0 (MIT), pinned with integrity hashes and recorded in the licence inventory. `npm audit --omit=dev` reports zero vulnerabilities. No Enketo or probe package entered the root or service tree.

Local, in a detached worktree: root 252 of 252, service 157 of 157, lint, typecheck, format check, scaffold, `git diff --check` and the fixture checker. Public CI 35096046069 is green.

Verifier probes and independent inspection:

- The package holds exactly `survey`, `choices`, `settings` and `kusanya_source`, in that order. All 233 cells in my fixture are inline strings with the text number format, with no formula, cached value or other cell type.
- Excel 16.0 opened the checker's workbook, whose SHA-256 matched the manifest: four sheets, 233 cells, 0 formulas, every cell text-formatted, and `=1+1`, `+cmd|calc`, `-2+3` and `@SUM(A1)` read back as strings with no formula. Note 40 is answered at the XLSX boundary. A CSV writer, if ever built, still needs its own treatment.
- A clean import returns the same canonical bundle and byte-identical compiled XML. Editing one visible cell is refused.
- Refused with structural codes: a formula cell, a typed numeric cell, a shared-string cell, a cached value, a missing or general style, comment, macro and external-link parts, missing styles or sheet parts, altered content types, sheet order or styles, a DTD, an undeclared entity, a processing instruction, an XML comment, CDATA, a namespace-prefixed cell, a non-sequential cell, a duplicate row number, malformed XML, invalid UTF-8, a traversal entry name, a truncated archive, garbage bytes and a 12 MB + 1 input. Stored entries are accepted by design.
- A 64 MiB part is refused before inflation by its declared size. With the declared size forged to 1,000 bytes, fflate truncates to the declared allocation, the XML fails to parse, and the import fails in 151 ms with 9 MB of heap.
- Two exports are byte-identical, inputs are not mutated, an `ArrayBuffer` works, and zeroing the caller's buffer after import does not affect the result. Leading zeros, padded whitespace, tabs, newlines and astral characters round-trip exactly.
- Claims in ADR 0018, ADR 0017, the interchange runbook and the roadmap keep C10.10, C10.12, general edited-XLSForm import, converter equivalence, Salesforce persistence, delivery authorization and the Phase 1 gate open.

Finding 41, low severity, correctness: `escapeText` in `xlsx-workbook.ts` does not escape `\r`. Conforming XML parsers normalize a raw `\r` or `\r\n` in character data to `\n`, and saxes does: `a\rb` parses as `a\nb`, while `a&#13;b` parses as `a\rb`. A definition with a carriage return in a label, hint or note therefore exports but fails re-import with `XLSFORM_PROJECTION_MISMATCH`. The table profile keeps `\r` and `validXmlText` allows it, so only the XLSX path loses it, contradicting ADR 0018's exact round-trip and whitespace-preservation claims. Fix: `.replaceAll('\r', '&#13;')` in `escapeText`, as `render.ts` already does, plus a test with `\r` and `\r\n`. The import side needs no change.

Note 42, informational: the pre-expansion limits read attacker-controlled declared sizes. Memory stays bounded because fflate allocates at the declared size and truncates, and a mismatch fails closed; inflate work stays bounded by the 12 MB compressed cap. ADR 0018 could state that contract exactly.

Notes 36, 37 and 39 stay open, note 38 stays answered, and the Enketo probe remains unreproduced by me pending Bill's decision.

Capacity at 12:34 UTC: 3 of 6 daily and 3 of 3 active, with none in use.

`HOLD: run 35096046148 at head 4b275bf`. Approving it would spend a scratch slot on a head the fix will supersede. Cancel it once the fixed head is pushed.

`HOLD: PR #20, 1 finding` (41)

## 2026-09-16: PR #20 fix head `bb55c27`; finding 41 closed, run 35097677494 cleared

Head and ancestry: bb55c27 is the original adapter commit 4b275bf plus one corrective commit, both on main e90b05e. The delta touches only `service/src/interchange/xlsx-workbook.ts`, its test and ADR 0018. The trust boundary is unchanged, including service dependencies, and the pin 1d0edc1 appears twice.

Finding 41 closed: `escapeText` now emits `&#13;` for every carriage return. My probe placed CR, CRLF, LF, mixed and leading and trailing line endings in labels, hints, author notes, the title, a choice label and a mapping constant. The worksheets held 0 raw CR bytes and 16 `&#13;` references, the import returned every value byte-identical, the compiled XML was identical, and the workbook bytes were deterministic. The new regression test covers CR, CRLF and LF in a label and in author notes.

Unchanged behaviour re-checked: formula-prefix values remain literal text with no formula or cached-value elements; a formula cell is still refused; a raw CR injected by hand still fails closed. The fixture checker's workbook SHA-256 is unchanged at `e8aa7ba5`, as expected for a fixture without carriage returns. ADR 0018's note 42 wording matches the measured behaviour.

Local, in a detached worktree: root 252 of 252, service 158 of 158, lint, typecheck, production audit at zero, format check, scaffold, `git diff --check` and the fixture checker. Public CI 35097677475 is green. No new findings.

Runs: 35096046148 on the stale head 4b275bf is still waiting and should be cancelled, not approved. 35097677494 is on the exact head and pending behind it. Capacity at 12:54 UTC: 3 of 6 daily, none active.

`SAFE TO APPROVE: run 35097677494 at head bb55c27`, after run 35096046148 is cancelled.

`HOLD: PR #20, 0 findings`, pending hosted success with an exact-head marker and a Deleted org. Notes 36, 37 and 39 stay open; 38, 40 and 41 are answered.

## 2026-09-16: Failure review of run 35097677494 attempt 1 and retry clearance, PR #20 head `bb55c27`

Scope: read-only review of the failed hosted run, the Dev Hub and Salesforce Trust. No approval, cancellation, rerun, scratch org or credential change was made.

Run evidence: the Apex job ran 13:00:50 to 13:01:16 UTC. The confirm step printed the exact head, the in-job budget recheck allowed an initial attempt, and the pinned CLI installed. The authentication step printed only `Dev Hub authentication failed: RefreshTokenAuthError/other` and exited 1 about 1.5 s after starting. Verification, stale-head and cleanup steps were skipped, and logout failed because nothing was authenticated. No scratch org was created. The sanitized 489-line log holds no credential material; the masks are GitHub's own.

Dev Hub evidence: LoginHistory for the CI user shows four successful `Remote Access 2.0` logins today, the last at 11:24:00 for PR #18's run, and no row of any status at 13:01. The CLI's OAuth token row still exists, last used 11:24, use count 24, not revoked. The audit trail shows no security or connected-app change today. The refresh request therefore never registered at Salesforce as a login attempt.

Cause: Salesforce Trust incident 20004433, active since 07:50 UTC across all regions and 1,262 instances, with the Dev Hub's instance USA876 in the affected list and in status `MAJOR_INCIDENT_CORE`. Salesforce's stated root cause is requests stalling on an internal login service; the 12:39 UTC update says most instances are recovering and some still need a manual restart. The three successful logins earlier today fit an intermittent fault.

Retry budget: the pinned `apex-run-budget.mjs` and policy from 1d0edc1, run read-only against live history as attempt 2, returned `allowed: true, kind: infrastructure-retry`. Attempt 1 counts as `failed-infrastructure` because its verify step completed as skipped. The stale run 35096046148 on 4b275bf is filtered out by head.

Advice: retry once USA876 is out of the incident, because the retry is the only one left for this head today. If recovery does not come before 00:00 UTC, wait: the budget is per UTC day, so the head then gets a fresh initial attempt plus a retry.

Evidence to verify afterwards: attempt 2 success on bb55c27; one marker with run `35097677494-2`, the full head and outcome `passed`; `81 passed; 473/475`; one owned org deleted; the Dev Hub tag Deleted with its audit entry; no credential material; all five checks green; head unchanged.

`SAFE TO RE-RUN: ONE same-head infrastructure retry of run 35097677494 at bb55c27`, via "Re-run all jobs" with one environment approval, once USA876 is out of incident 20004433. The stale run 35096046148 should be cancelled if still waiting.

`HOLD: PR #20, 0 findings`, unmerged until exact-head Apex success, the trusted marker and the Deleted-org evidence are verified.

## 2026-09-17: PR #20 hosted Apex evidence, run 35097677494 attempt 2 at `bb55c27`; PASS

Run and head:

- Attempt 2, the single same-head re-run cleared after Salesforce incident 20004433, succeeded on the exact head. It started 11:10:02 UTC and was approved for `salesforce-ci` by cobitechsolutions. The policy, Apex and gate jobs all succeeded.
- The PR head is unchanged and up to date with main e90b05e. Merge state is CLEAN, and all five checks are green.

Apex job 105178947627, full log of 531 lines:

- The confirm step printed the exact head, the harness checkout is the pinned 1d0edc1, and the stale-head check passed.
- The in-job budget recheck returned `allowed: true, kind: initial`, because the retry ran on a new UTC day and the budget is per UTC day. That is the policy as designed.
- Result: `81 passed; 473/475 executable lines (99.58%)`, matching the established baseline because no Salesforce source changed.
- Exactly one marker: schema 1, role `ci`, run `35097677494-2`, full head bb55c27, started 11:13:31.967Z, outcome `passed`, retryable false.
- Cleanup: 1 owned scratch org deleted, 0 already deleted, tag `kusanya-ci-v1__35097677494-2__bb55c27a9dcb__32b23991836b`. Fallback cleanup skipped after success, logout succeeded.

Dev Hub, checked independently:

- ScratchOrgInfo shows the tag as Deleted, for org 00DcU00000H1IPM, created 11:13:36 and last modified 11:14:32 UTC.
- Setup Audit Trail has `deleteScratchOrg` for "00DcU00000H1IPM" at 11:14:37 UTC. ActiveScratchOrg has 0 rows.
- LoginHistory records the CI login at 11:13:30 as a success.

Credential hygiene: no `force://` URLs, org session IDs, bearer, access or refresh tokens, JWTs, private keys or email addresses in the full log. All 10 masks are GitHub redactions. The only warning is note 35's Node.js 20 deprecation notice.

The adapter evidence rests on the two earlier entries: the enumerated package structure, Excel's independent confirmation of literal text cells with zero formulas, every hostile package variant refused, deterministic bytes, and the carriage-return round trip proven at the fix head.

Open items carried forward, none blocking this unit: note 36 on the untested Collect Android UI; note 37 on client-specific count reduction; note 39 on gating delivery of reviewer HTML, which also covers authoring bundles and workbooks; the Enketo probe still unreproduced by the verifier; and notes 24, 25, 27 to 31, 34 and 35. Notes 38, 40 and 41 are answered, and note 42 is informational.

This is a Phase 1 unit, not the phase gate, and no C10 acceptance test is claimed.

`PASS: PR #20 may be merged`

## 2026-09-17: Source and security review of PR #23 head `6a670ae`, publication target-schema validation; one finding

Scope: the new pure module `service/src/publication/target-schema.ts`, its test, ADR 0019, and architecture and roadmap updates. Bill asked for a review before deciding on run 35221304075.

Preconditions and trust boundary:

- PR #20 merged as 2a4a1f1, whose tree 3cfdbfc is identical to the verified head bb55c27. PR #21 merged as 209e380, and main CI 35216027159 passed. This PR is one commit on that main.
- No workflow, credentialed harness, Salesforce metadata, permission, namespace, manifest, lockfile or runtime-probe change. The pin 1d0edc1 appears twice.
- Because nothing under `salesforce/` changed, no verifier scratch org was created.
- PR #22 is a closed duplicate log PR on a `docs/pr-20-verification-log` branch that I did not open; the PR #20 log went through PR #21.

Local, in a detached worktree: root 252 of 252, service 167 of 167, lint, typecheck, format check, scaffold, a production audit at the low threshold with zero results, and `git diff --check`. Public CI 35221304063 is green.

Verifier probes, synthetic input only:

- Hostile snapshots. A proxy, an accessor, a `__proto__` key, an extra key, a missing key, sparse and extended arrays, a non-boolean flag, a dotted name, case-variant duplicate objects, fields and lookup targets, 101 extra objects, a 256-character name, a wrong schema version and an array root are each refused with a specific code and structural location. `Object.prototype` stays clean.
- Leakage. With distinctive names in the snapshot and mappings, diagnostics contain codes and paths only.
- Resolution. `Account__r` as a target object fails with `PUBLISH_TARGET_OBJECT`, note 34's case at this boundary. Case variants of object, field, lookup and record-type names resolve. Reordering inputs gives an identical result, and no input is mutated.
- Access matrix. A main mapping on a non-createable object is refused; a query-only reference on a lookup-only object passes with the non-unique match warning; a reference with an upsert there is refused; a reference on a non-queryable object is refused; a main mapping may assign a create-only field but not a read-only one. Inactive and unknown record types, an upsert on a non-external-ID field, a parent lookup to the wrong object, stamp collisions in any case, an unreadable matching field and a missing field are refused. A polymorphic lookup passes only when it includes the parent's object.

Finding 43, low severity, correctness of the access matrix: on the reference-upsert path, where the object check correctly demands create and update access, the field-level checks for assignments, the collector and submission stamps and the parent lookup demand only `createable`. My probes show a reference mapping with an upsert external ID passes while assigning a field, or stamping a field, that is createable but not updateable. The first upsert that matches an existing record would then be rejected by Salesforce. It fails loudly rather than writing wrong data, but the validator exists to prevent that class of publication. Fix: when the reference writes, require `createable && updateable` on those fields, add tests for a create-only field and stamp under a reference upsert, and state the field-level rule in ADR 0019.

Notes 36, 37 and 39 stay open; note 34 stays carried until a reviewed Salesforce adapter supplies a fresh Describe snapshot, as ADR 0019 says; the Enketo probe remains unreproduced by me.

Capacity at 12:33 UTC: 5 of 6 daily and 3 of 3 active, with none in use.

`HOLD: run 35221304075 at head 6a670ae`. The fix changes the head, so approving now would spend a scratch slot on a superseded head. Cancel it once the fixed head is pushed.

`HOLD: PR #23, 1 finding` (43)

## 2026-09-17: PR #23 fix head `4610d3f`; finding 43 closed, run 35222254862 cleared

Head and ancestry: 4610d3f is the original commit 6a670ae plus one corrective commit, both on main 209e380. The delta touches only `service/src/publication/target-schema.ts`, its test and ADR 0019. The trust boundary is unchanged, the pin 1d0edc1 appears twice, and no verifier scratch org was needed.

Finding 43 closed. The fix adds a `canWrite` helper requiring create access and, when a reference may upsert, update access as well, applied to assignments, both stamps and the parent lookup. My probes:

- Reference upserts: a create-only assignment, collector stamp, submission stamp and parent lookup each return `PUBLISH_TARGET_FIELD_WRITE` at their own location. An update-only field is refused, a reference that writes assignments without an upsert field follows the same rule, and fully writable fields and lookups pass.
- Inserts: main and repeat mappings still accept a create-only assignment, stamp and parent lookup, and still refuse update-only and read-only fields.
- Unchanged: a query-only reference, a missing field, a parent lookup to the wrong object and an upsert on a non-external-ID field behave as before, and a create-only field beside a missing field reports both. The original probe set is otherwise identical.

ADR 0019 now states the insert versus reference-upsert field rule. Local, in a detached worktree: root 252 of 252, service 168 of 168, lint, typecheck, format check, scaffold, production audit at zero and `git diff --check`. Public CI 35222254900 is green. No new findings.

Runs: 35221304075 on the stale head 6a670ae is still waiting and should be cancelled. 35222254862 is on the exact head and pending behind it. Capacity: 5 of 6 daily, none active.

`SAFE TO APPROVE: run 35222254862 at head 4610d3f`, after run 35221304075 is cancelled.

`HOLD: PR #23, 0 findings`, pending hosted success with an exact-head marker and a Deleted org. Notes 36, 37 and 39 stay open, and note 34 stays carried.

## 2026-09-17: PR #23 hosted Apex evidence, run 35222254862 attempt 1 at `4610d3f`; PASS

Run and head:

- Attempt 1 succeeded on the exact head, started 12:38:22 UTC and approved for `salesforce-ci` by cobitechsolutions. The policy, Apex and gate jobs all succeeded.
- The PR is OPEN at 4610d3f, up to date with main 209e380, MERGEABLE and CLEAN, with all five checks green. The only runs on this head are public CI 35222254900 and this one; the stale run 35221304075 completed as failure on 6a670ae and is out of scope by head.

Apex job 105205108472, full log of 531 lines:

- The confirm step printed the exact head, and the trusted harness pin 1d0edc1 appears 6 times.
- The in-job budget recheck returned `allowed: true, kind: initial`, correct for a first attempt on a fresh head.
- Result: `81 passed; 473/475 executable lines (99.58%)`, matching the established baseline because this PR changes no Salesforce source.
- Exactly one marker, matching this attempt: schema 1, role `ci`, run `35222254862-1`, full head 4610d3f, started 12:54:41.065Z, outcome `passed`, retryable false.
- The stale-head rejection passed and logout succeeded.
- Cleanup: 1 owned scratch org deleted, 0 already deleted, tag `kusanya-ci-v1__35222254862-1__4610d3f5f3b7__34dcd95d05f0`. The fallback cleanup was correctly skipped after the primary cleanup confirmed.

Dev Hub, checked independently:

- ScratchOrgInfo shows the tag as Deleted, for org 00Dcf00000HoHaF, created 12:54:45 and last modified 12:55:47 UTC.
- Setup Audit Trail has `deleteScratchOrg` for "00Dcf00000HoHaF" at 12:55:50 UTC.
- ActiveScratchOrg has 0 rows.

Credential hygiene: no `force://` URLs, org session IDs, bearer, access or refresh tokens, JWTs, private keys or email addresses in the full log. All 10 masks are GitHub redactions. The only warning is note 35's Node.js 20 deprecation notice.

The validator evidence rests on the two earlier entries: hostile snapshots refused without running supplied code, diagnostics leaking no supplied names, case-insensitive resolution, deterministic results, unmutated inputs, `Account__r` refused, and the corrected access matrix where reference upserts require field update access while inserts do not.

Open items carried forward, none blocking this unit: note 34 stays carried until a reviewed Salesforce adapter supplies a fresh integration-user Describe snapshot and the publisher refuses on these diagnostics; note 36 on the untested Collect Android UI; note 37 on client-specific count reduction; note 39 on gated, uncached delivery of reviewer and authoring output; the Enketo probe still unreproduced by the verifier; and notes 24, 25, 27 to 31 and 35. Notes 38, 40, 41 and 43 are answered, and note 42 is informational. Datatype and picklist compatibility, polymorphic lookup policy, record-type namespace ambiguity, JavaRosa validation, immutable storage and CLI publication remain open, as ADR 0019 states.

This is a Phase 1 unit, not the phase gate, and no C10 acceptance test is claimed.

`PASS: PR #23 may be merged`

## 2026-09-17: Source and security review of PR #25 head `572a3cd`, publication field compatibility; one finding

Scope: the datatype, nullability and restricted-picklist checks added to `service/src/publication/target-schema.ts`, its tests, ADR 0020, and architecture and roadmap updates. Requested before Bill decides on run 35257489966.

Preconditions and trust boundary:

- PR #23 merged as b3db0c7, whose tree cb78493 is identical to the verified head 4610d3f. PR #24 merged as 8467e95, and main CI 35227196105 passed at that base. This PR is one commit on that main.
- No workflow, credentialed harness, Salesforce metadata, permission, namespace, manifest, lockfile or script change; the pin 1d0edc1 appears twice. Nothing under `salesforce/` changed, so no verifier scratch org was created.

Local, in a detached worktree: root 252 of 252, service 172 of 172, lint, typecheck, format check, scaffold, a production audit at the low threshold with zero results, and `git diff --check`. Public CI 35257489965 is green.

Verifier probes, synthetic input only:

- Direct `none`: all 16 question types against 12 target categories match ADR 0020. Text-like answers reach text, picklist and combobox fields; integer and decimal reach numeric fields; date, time and datetime reach only their own types; geographic answers reach text; media and calculate are refused without an explicit transform.
- All twelve transforms: each matching pair passes and each mismatched pair is refused, covering `picklist_match`, `multi_select_join`, `lookup_by_external_id`, `date_only`, `boolean_yes_no`, `number`, `text_truncate`, the three geopoint components and `file_url`.
- Restricted picklists: active values pass; missing, inactive and case-mismatched values give `PUBLISH_PICKLIST_VALUE`; multipicklist membership is per choice; unrestricted picklists do not require membership; and a text question to a restricted picklist fails closed.
- Strict decoder: unknown, numeric, capitalised and missing types; missing `nillable` or `picklistValues`; an extra field key; picklist metadata or `restrictedPicklist` on a non-picklist; `referenceTo` on a non-reference; duplicate values; accessor, extra-key, non-string, control-character and over-length values; proxy and sparse value arrays; 2,001 values on a field; and over 10,000 in a snapshot are each refused with a specific code and location. `Object.prototype` stays clean.
- Determinism, immutability and non-disclosure all hold, and success still returns `validation: 'target-schema-only'`.

Finding 44, low severity, correctness: `blankConstant` covers only `constantValue === null`, so an empty or whitespace-only constant skips the `nillable` check. Against a non-nillable string target, `null` correctly gives `PUBLISH_TARGET_FIELD_REQUIRED`, while `''`, `'   '` and `''` with `text_truncate` all return `ok`. Salesforce stores an empty string as null and trims boundary whitespace, which I proved in the PR #18 review, so each of those writes null into a required field and the insert is rejected at ingestion. It also contradicts ADR 0013 and ADR 0017, which define null or empty as an explicit blank, and which ADR 0020 line 55 cites. Fix: treat null, empty and whitespace-only constants as blank so they take the existing transform and `nillable` branches, with tests for each.

Note 45, informational: collector and submission stamp fields are checked for existence, write access and collisions but never datatype, so a stamp on a date, boolean or restricted picklist field passes. That is defensible while the ingestion stamp contract is undecided, but ADR 0020's future-work list should say so explicitly, and the check should land with that contract. A smaller observation: a nonblank constant with `none` is accepted for a picklist target and refused for a combobox one, while `picklist_match` accepts both; one ADR clause would settle whether that asymmetry is deliberate.

Notes 36, 37 and 39 stay open; note 34 stays open until a reviewed Describe adapter and refusing publisher exist, as ADR 0020 says; notes 24, 25, 27 to 31 and 35 carry forward; 38, 40, 41 and 43 are answered; 42 is informational. No Enketo install and no Collect device decision were made.

Capacity at 18:25 UTC: 4 of 6 daily and 3 of 3 active, with none in use.

`HOLD: run 35257489966 at head 572a3cd`. The fix changes the head, so approving now would spend a scratch slot on a superseded head. Cancel it once the fixed head is pushed.

`HOLD: PR #25, 1 finding` (44)

## 2026-09-17: PR #25 fix head `cefc34a`; finding 44 closed, note 45 recorded, run 35259416907 cleared

Head and ancestry: cefc34a is the original commit 572a3cd plus one corrective commit, both on main 8467e95. The delta touches only `service/src/publication/target-schema.ts`, its test and ADR 0020. The trust boundary is unchanged, the pin 1d0edc1 appears twice, and no verifier scratch org was needed.

Finding 44 closed. `blankConstant` now covers null and any `trim()`-blank string, and `none` accepts a nonblank constant for a combobox. My probes:

- Ten blank spellings, `null`, `''`, one space, several spaces, a tab, a newline, CRLF, mixed whitespace, a no-break space and an em space, all pass against a nillable target and all give `PUBLISH_TARGET_FIELD_REQUIRED` against a non-nillable one. `String.trim()` covers Unicode spaces, which is the conservative direction.
- Each blank spelling with `text_truncate`, `number` or `picklist_match` gives `PUBLISH_TARGET_FIELD_TYPE`.
- A blank against a required restricted picklist or combobox gives `PUBLISH_TARGET_FIELD_REQUIRED`; against an optional one it passes. Required numeric and textarea targets behave the same.
- Nonblank constants still require membership: active values pass for restricted picklists and comboboxes, while inactive, missing, case-mismatched and space-padded values give `PUBLISH_PICKLIST_VALUE`. Unrestricted picklists and comboboxes accept any value.
- Combobox rules match the ADR: a nonblank constant with `none`, a select-one question directly and through `picklist_match` all reach a combobox, and a text question reaches an unrestricted combobox but fails closed against a restricted one.

Note 45 is accurately recorded: ADR 0020 now states that stamp fields are checked for existence and write access only, with datatype and restricted-picklist compatibility deferred to the future ingestion stamp contract, which matches the behaviour I still observe. The ADR also now states the combobox rule.

Nothing else moved: re-running the whole earlier matrix on this head gives identical results for the direct `none` grid, all twelve transforms, picklist membership, the strict decoder, determinism, immutability and non-disclosure.

Local, in a detached worktree: root 252 of 252, service 173 of 173, lint, typecheck, format check, scaffold, production audit at zero and `git diff --check`. Public CI 35259416938 is green. No new findings.

Runs: the stale run 35257489966 on 572a3cd already completed as failure, so nothing remains to cancel. 35259416907 is on the exact head and waiting, with its policy job passed. Capacity at 18:36 UTC: 4 of 6 daily, none active.

`SAFE TO APPROVE: run 35259416907 at head cefc34a`

`HOLD: PR #25, 0 findings`, pending hosted success with an exact-head marker and a Deleted org. Notes 34, 36, 37 and 39 stay open; 45 is documented and informational; 38, 40, 41, 43 and 44 are answered; 42 is informational.

## 2026-09-17: PR #25 hosted Apex evidence, run 35259416907 attempt 1 at `cefc34a`; PASS

Run and head:

- Attempt 1 succeeded on the exact head, started 18:32:09 UTC and approved for `salesforce-ci` by cobitechsolutions. The policy, Apex and gate jobs all succeeded.
- The PR is OPEN at cefc34a, up to date with main 8467e95, MERGEABLE and CLEAN, with all five checks green. The only runs on this head are public CI 35259416938 and this one, and no push followed the re-verification.

Apex job 105331210682, full log of 531 lines:

- The confirm step printed the exact head, and the trusted harness pin 1d0edc1 appears 6 times.
- The in-job budget recheck returned `allowed: true, kind: initial`.
- Result: `81 passed; 473/475 executable lines (99.58%)`, matching the established baseline because this PR changes no Salesforce source.
- Exactly one marker, matching this attempt: schema 1, role `ci`, run `35259416907-1`, full head cefc34a, started 18:40:02.905Z, outcome `passed`, retryable false.
- The stale-head rejection passed and logout succeeded.
- Cleanup: 1 owned scratch org deleted, 0 already deleted, tag `kusanya-ci-v1__35259416907-1__cefc34a110ad__41ec4ed6650b`, with the fallback cleanup correctly skipped.

Dev Hub, checked independently:

- ScratchOrgInfo shows the tag as Deleted, for org 00DQL00000bw6nh, created 18:40:07 and last modified 18:41:25 UTC.
- Setup Audit Trail has `deleteScratchOrg` for "00DQL00000bw6nh" at 18:41:30 UTC.
- ActiveScratchOrg has 0 rows.

Credential hygiene: no `force://` URLs, org session IDs, bearer, access or refresh tokens, JWTs, private keys or email addresses in the full log. All 10 masks are GitHub redactions. The only warning is note 35's Node.js 20 deprecation notice.

The compatibility evidence rests on the two earlier entries: the full 16-question by 12-target `none` grid, all twelve transforms in matching and mismatched pairs, exact case-sensitive picklist and combobox membership, the strict decoder refusing every hostile snapshot shape, ten blank-constant spellings behaving identically against nillable and non-nillable targets, determinism, immutability and non-disclosing diagnostics.

Open items carried forward, none blocking this unit: note 34 until a reviewed Describe adapter and refusing publisher exist; note 36 on the untested Collect Android UI; note 37 on client-specific count reduction; note 39 on gated, uncached delivery; note 45 on stamp datatype checks arriving with the ingestion stamp contract; the Enketo probe still unreproduced by the verifier; and notes 24, 25, 27 to 31 and 35. Notes 38, 40, 41, 43 and 44 are answered, and 42 is informational. Length, precision and scale, lexical URL, email and phone rules, reference external-ID selection, compound fields, record-type-specific picklists, executable transforms, JavaRosa validation, immutable storage and CLI publication remain open, as ADR 0020 states.

This is a Phase 1 unit, not the phase gate, and no C10 acceptance test is claimed.

`PASS: PR #25 may be merged`

## 2026-09-17: Source and security review of PR #27 head `df9ba5d`, Salesforce Describe normalization; one finding

Scope: the new `service/src/publication/salesforce-describe.ts` loader, its tests, a four-line `isTargetFieldType` export in `target-schema.ts`, ADR 0021, and architecture and roadmap updates. Requested before Bill decides on run 35266899643.

Preconditions and trust boundary:

- PR #25 merged as 96998ad, whose tree a5aeb9d is identical to the verified head cefc34a. PR #26 merged as 1e7c966, and main CI 35263338139 passed. This head is one commit on that main.
- No dependency, lockfile, workflow, harness, `salesforce/`, Enketo or device change; the pin 1d0edc1 appears twice. No scratch org was needed or created.

Local, in a detached worktree: root 252 of 252, service 180 of 180, lint, typecheck, format check, scaffold, service integration 1 passed and 1 skipped without a disposable PostgreSQL URL, production audit at the low threshold with zero results, and `git diff --check`. Public CI 35266899599 is green.

Finding 46, medium severity: the adapter accepts a field type only if it already matches the canonical vocabulary exactly, performing no wire-to-canonical conversion, although ADR 0020 assigned that conversion to this adapter. Salesforce spells whole-number fields `int`, while the canonical list has `integer`, which never appears in a REST response. Read-only Describe calls against our own Dev Hub show `Account` returning 70 fields including one `int`, with `int` also on `User`, `Opportunity`, `Case`, `Attachment` and `ContentVersion`. One such field fails the whole object with `PUBLISH_DESCRIBE_TYPE`, so `Account`, the HWWS worked example's target, cannot be normalized. The documented camel-case spellings `anyType` and `dataCategoryGroupReference` are also rejected while their lower-case forms pass; I did not observe either in the 25 standard objects swept, so they are documented rather than demonstrated. Fix: either map wire spellings here, at minimum `int` to `integer`, case-folding before lookup, or change the canonical vocabulary to Salesforce's exact spellings and update `numericTargets` and ADR 0020. Add a test using real spellings and state the rule in ADR 0021.

Everything else verified:

- Wire shapes. Every property the adapter reads matches what the Dev Hub returns, and real extra properties such as `label`, `length`, `soapType`, `urls` and `custom` are ignored. `combobox`, `long`, `base64`, `address`, `encryptedstring` and `location` are accepted.
- Deduplication, ordering and counts. Five names collapsing to two objects spend 2 requests in canonical order; an invalid name up front spends 0; a rejected request mid-way reports 2; a malformed response after an earlier success reports 2 with the failing path; repeated calls are fresh and byte-identical; an empty list spends 0 and succeeds; a non-array input fails with 0.
- Identity. `Account__r` returned for a requested `Account` fails closed; a case-only difference matches by design.
- Hostile structures. Proxies on the response or field array, accessors on object or field properties, a symbol key, an exotic prototype, a class instance, sparse and extended arrays, duplicate fields, record types, references and picklist values, misplaced picklist and reference metadata, a missing required property, and null, array or string responses are each refused with a structural code and path. `Object.prototype` stays clean and no supplied code runs.
- Non-disclosure. A secret-looking object name, field name and provider error message do not appear in diagnostics.
- Bounds. Exact and plus-one behave correctly at 100 objects, 5,000 fields in one object and across two, 2,000 picklist values per field, 10,000 in aggregate, 100 reference targets, 1,000 record types and the 500,000 text-unit budget.
- No drift. A normalized snapshot feeds the ADR 0019 and 0020 validator and passes, and that validator still refuses an inactive picklist value from the same snapshot.
- Immutability, determinism and canonical ordering all hold.
- Only `isTargetFieldType` and `validatePublicationTargets` are exported, so the canonical array cannot be mutated by callers.
- Note 34 is correctly still open, and ADR 0021 does not overstate freshness, authentication, transport security or publisher refusal.

Note 47, informational: ADR 0021 states as fact that an integration-user REST Describe omits FLS-inaccessible fields, and the code hard-codes `readable: true` on that basis. I could not verify it: Salesforce's documentation pages are not publicly fetchable, and a real check needs a restricted-permission user in a scratch org, which this unit does not otherwise require and which is not authorized for a source review. If the claim is wrong, `readable` would be true for an unreadable field and ADR 0019's matching-field read check could never fire. Either soften the wording to an assumption pending a real-org check, or keep it and record the check as required work.

Capacity at 19:55 UTC: 3 of 6 daily and 3 of 3 active, with none in use.

`HOLD: run 35266899643 at head df9ba5d`. Finding 46 needs a code change, so approving now would spend a scratch slot on a superseded head. Cancel it once the fixed head is pushed.

`HOLD: PR #27, 1 finding` (46), with note 47 informational. Notes 34, 36, 37 and 39 remain open; 24, 25, 27 to 31 and 35 carry forward; 42 and 45 are informational; 38, 40, 41, 43 and 44 are answered. Enketo installation and the Collect device decision remain unapproved and untouched.

## 2026-09-17: PR #27 fix head `fafd444`; finding 46 closed, new finding 48 on dependent picklists

Head and ancestry: fafd444 is the original df9ba5d plus one corrective commit, both on main 1e7c966. The delta touches only `salesforce-describe.ts`, its test and ADR 0021. No dependency, lockfile, workflow, harness or `salesforce/` change; the pin 1d0edc1 appears twice; nothing outside those three files moved.

Local, in a detached worktree: root 252 of 252, service 181 of 181, lint, typecheck, format check, scaffold, integration 1 passed and 1 skipped without a disposable PostgreSQL URL, production audit at the low threshold with zero results, and `git diff --check`. Public CI 35268762178 is green.

Finding 46 closed. Case-folding plus the explicit `int` to `integer` mapping behaves correctly:

- `int`, `INT`, `Int`, `integer`, `INTEGER` and `Integer` all normalize to `integer`.
- All 27 documented Salesforce enum spellings normalize, including camel-case `encryptedString`, `dataCategoryGroupReference`, `anyType` and `complexValue`, and an upper-case `JSON`.
- Unknown, padded, tab- and newline-suffixed, empty, numeric, null, object, array, over-long and Unicode-lookalike types still fail closed with `PUBLISH_DESCRIBE_TYPE`, with no value leakage.
- Placement checks work on the canonical type: `PICKLIST`, `MultiPicklist`, `REFERENCE` and `ComboBox` behave, while `STRING` with picklist values, `INT` marked restricted and `String` with `referenceTo` are refused.
- Inputs are unmutated with original casing intact, output is deterministic and canonically ordered, and the text budget counts the canonical value.
- A snapshot containing an `int` field feeds the ADR 0019 and 0020 validator, which accepts an integer question into that target and refuses a text question.

Finding 48, medium severity, new: the duplicate picklist value check refuses real dependent picklists. Salesforce lists one entry per controlling value, distinguished by `validFor`, so a code repeats legitimately. Three real describes captured read-only from the Dev Hub:

- `Account.BillingStateCode` and `ShippingStateCode`: 384 entries, 277 distinct values; `AG` is Agrigento in Italy and Aguascalientes in Mexico. Account fails with `PUBLISH_DESCRIBE_SHAPE` at `objects[0].fields[11].picklistValues[2].value`.
- `Contact.MailingStateCode` and `OtherStateCode`, and `Lead.StateCode`: same shape, same failure. Country Code picklists have 235 distinct values and no duplicates, so this is specific to dependent picklists.
- With duplicates collapsed and nothing else changed, all three normalize cleanly and Account's real snapshot passes the ADR 0019 and 0020 validator for integer, text and restricted-picklist assignments. Deduplication is the only remaining blocker.

Fix: collapse by `value`, treating a value as active when any entry for it is active, keep the entry-shape checks, count collapsed values against the budget, add a test with two entries sharing a value under different `validFor`, and correct ADR 0021 line 47, which still says duplicate values fail closed. The validator's own decoder may keep rejecting duplicates, because a hand-authored snapshot has no `validFor` to justify them.

Note 47 is now accurately recorded: ADR 0021 presents the FLS omission as an unconfirmed assumption, states that fields are marked readable under it, and requires a restricted-user scratch-org check before publisher integration, with the consequence if disproved. The omitted-field test no longer claims FLS as the proven cause.

Note 49, informational: dependent-picklist `validFor` is modelled nowhere and is dropped from the snapshot. After finding 48 is fixed, a value valid only under one controlling value passes regardless of the controlling field; I confirmed a constant `AG` for `BillingStateCode` is accepted against Account's real metadata. List it in ADR 0021's intentional gaps beside record-type-specific picklists.

Note 34 remains open, and ADR 0021 still confines itself to normalization.

Runs: the stale run 35266899643 is still waiting on the superseded head df9ba5d and should be cancelled. The replacement 35268762285 stays unapproved, because finding 48 needs another code change. Capacity at 20:50 UTC: 3 of 6 daily, none active.

`HOLD: run 35268762285 at head fafd444`

`HOLD: PR #27, 1 finding` (48). Finding 46 is closed. Notes 47 and 49 are informational; notes 34, 36, 37 and 39 remain open; 24, 25, 27 to 31 and 35 carry forward; 42 and 45 are informational; 38, 40, 41, 43 and 44 are answered.

## 2026-09-17: PR #27 fix head `99ede85`; finding 48 closed, run 35273720037 cleared

Head and ancestry: 99ede85 is df9ba5d, then the finding 46 fix fafd444, then this finding 48 fix, all on main 1e7c966. The latest delta touches only `salesforce-describe.ts`, its test and ADR 0021. Across the whole PR six files change, none of them a dependency, lockfile, workflow, harness or `salesforce/` file, and the pin 1d0edc1 appears twice.

Local, in a detached worktree: root 252 of 252, service 182 of 182, lint, typecheck, format check, scaffold, integration 1 passed and 1 skipped without a disposable PostgreSQL URL, production audit at the low threshold with zero results, and `git diff --check`. Public CI 35273720026 is green.

Finding 48 closed, verified against real metadata:

- The unmodified Account, Contact and Lead describes captured read-only from the Dev Hub all normalize in one request each. `Account.BillingStateCode`, `Contact.MailingStateCode` and `Lead.StateCode` each collapse 384 wire entries into 277 values, all active. A real-shape fixture with `AC`, `AG` twice and `AL` twice collapses to three values.
- Active is a true OR and order-independent: false then true gives active, true then false gives active, all-false stays inactive, three mixed entries give active, and reversing entry order produces byte-identical output.
- Case-distinct values stay distinct: `AG`, `Ag` and `ag` survive separately with their own flags, deterministically sorted.
- Every duplicate entry is still validated rather than skipped. A later duplicate with a non-boolean or missing `active`, a non-string value, a control character, an over-long value, a null or array entry, an accessor entry, a proxy entry, or a sparse array all fail at their own index, and no supplied value leaks. Ordinary extra keys such as `label`, `validFor` and `defaultValue` are ignored.
- Bounds behave as documented: the per-field wire limit is still 2,000 with 2,001 refused; the aggregate picklist budget counts collapsed values, so six fields of 2,000 repeats collapse to six values and pass, five fields of 2,000 distinct values reach exactly 10,000 and pass, and six are refused; the text budget still trips on collapsed values.
- No performance amplification: 200 fields each carrying 2,000 duplicate 300-character values normalized in 796 ms with 9 MB of heap, because only collapsed values are retained. Work scales linearly with wire entries and stays bounded by the 2,000-per-field and 5,000-field caps.

Finding 46 remains closed: `INT` and `String` still canonicalize to `integer` and `string`, and an unknown type is refused. No regressions: duplicate object, field, reference target and record-type names are still refused, and caller responses are unmutated.

Validator hand-off on real metadata: Account's real normalized snapshot passes the ADR 0019 and 0020 validator for integer, text and restricted-picklist assignments, and an unknown state code is refused with `PUBLISH_PICKLIST_VALUE`. This is the first time the whole chain has run on genuine Salesforce metadata.

Note 47 remains accurate: the FLS omission is still an unconfirmed assumption requiring a restricted-user scratch-org check before publisher integration. Note 49 is accurately recorded: ADR 0021 now states that dependent picklists may repeat values across `validFor` entries, describes exact-value collapse and active-any behaviour, no longer claims duplicate picklist values fail closed, and lists dependent-picklist applicability in both the intentional gaps and the revisit section. Note 34 remains open.

No new findings.

Runs: the finding 46 head run 35268762285 is already cancelled. The original head run 35266899643 is still waiting and should be cancelled. The replacement 35273720037 is on the exact head with its policy job passed. Capacity at 21:00 UTC: 3 of 6 daily, none active.

`SAFE TO APPROVE: run 35273720037 at head 99ede85`, after run 35266899643 is cancelled.

`HOLD: PR #27, 0 findings`, pending hosted success with an exact-head marker and a Deleted org. Findings 46 and 48 are closed; notes 47 and 49 are informational; notes 34, 36, 37 and 39 remain open; 24, 25, 27 to 31 and 35 carry forward; 42 and 45 are informational; 38, 40, 41, 43 and 44 are answered.

## 2026-09-17: PR #27 run 35273720037 failed cleanup; one owned org needs reconciliation

Run 35273720037 attempt 1 at head `99ede85`: exact-head and trusted-workflow checks passed, the budget recheck returned `initial`, authentication succeeded, the org was created at 21:03:59 UTC, and Apex passed with 81 tests and 473 of 475 executable lines. The harness then reported that owned scratch cleanup failed, wrote `outcome: failed-cleanup, retryable: false` in its exact-head marker, and exited 1. The unconditional fallback step also declined to confirm cleanup. Logout succeeded and the gate failed correctly.

The cause is not determinable from the public log, by design. The strings that look like error classes, including `ENOTFOUND`, `ECONNRESET`, `socket hang up` and `INVALID_SFDX_AUTH_URL`, appear only inside the echoed workflow source of the authentication step's transient-error classifier, never as runtime output. Authentication, org creation and Apex all worked in the preceding seconds, so credentials and API access were healthy immediately before the delete. Salesforce Trust shows USA876 as OK with no incident at 21:04 UTC; incident 20004433 ended at 15:26 UTC on 16 September. No `deleteScratchOrg` audit entry exists for the org, so the deletion never took effect at Salesforce.

Dev Hub evidence, read-only, re-queried at 21:21 UTC: `ScratchOrgInfo` `2SRbm000004XxJxGAK`, OrgName `kusanya-ci-v1__35273720037-1__99ede856accc__bb0b89f88586`, Status Active, ScratchOrg `00DRK00000b6ouT`, created 21:03:59, last modified 21:04:09, expires 2026-09-18, `ErrorCode` null. Exactly one row carries that tag, with no duplicate and no Error row. `ActiveScratchOrg` has one row, `2ASbm0000016rx7GAA`, for the same org. The audit trail's most recent deletions are all earlier CI orgs, ending with `00DQL00000bw6nh` at 18:41:30. Capacity reads 2 of 3 active and 2 of 6 daily remaining.

Credential hygiene: all 529 log lines scanned with no `force://` URLs, session ids, bearer, access or refresh tokens, JWTs, private keys or email addresses. The nine masks are GitHub's own redactions. The only warning is note 35's Node.js 20 deprecation.

Manual reconciliation is required and is not yet confirmed. The narrowest action is to delete `ActiveScratchOrg` record `2ASbm0000016rx7GAA` in the Dev Hub, which deletes exactly this org; `sf org delete scratch` does not apply because the CI org was never authenticated locally. Confirmation requires Status Deleted, no `ActiveScratchOrg` row for `00DRK00000b6ouT`, a matching `deleteScratchOrg` audit entry, and capacity back to 3 of 3 active.

Retry budget, simulated read-only with the pinned scripts at 1d0edc1 against live history: a same-head attempt 2 returns `{"allowed":false,"kind":null,"reason":"Cleanup failure requires human recovery before another attempt."}`, the same denial applies on a later UTC day because `failed-cleanup` is not day-scoped, and a different head returns `{"allowed":true,"kind":"initial"}`. So head 99ede85 is permanently blocked and only a new head regains eligibility. The passing Apex does not satisfy the gate, because the trusted marker records `failed-cleanup`.

Run 35266899643 on the superseded head df9ba5d ended by itself at 21:03:04 with its protected job executing zero steps, the signature of a rejected deployment. It created no org, and the single Active row confirms there is no second stray org. Run 35268762285 on fafd444 remains cancelled.

Note 50, informational: the marker has no machine-readable way to record that a maintainer reconciled a cleanup failure, so any cleanup failure permanently blocks that head even after the org is removed and verified gone. That is safe but forces a new commit purely to regain eligibility. A future reviewed harness change could let a recorded, verified reconciliation clear one blocked head.

`DO NOT RE-RUN: run 35273720037 at head 99ede85`

`HOLD: PR #27, 0 source findings, hosted gate failed`. The source review at 99ede85 stands and only the hosted evidence is missing. Findings 46 and 48 are closed; notes 47, 49 and 50 are informational; notes 34, 36, 37 and 39 remain open; 24, 25, 27 to 31 and 35 carry forward; 42 and 45 are informational; 38, 40, 41, 43 and 44 are answered.

## 2026-09-17: PR #27 head `58aa6f7` is tree-identical; merge sequencing decided

Fresh head `58aa6f7a89702a5eede4d8b99945619f5b7c64df` carries tree `1ee83a8199bcac021029fe053005df1d059c2ac8`, exactly the tree of reviewed head 99ede85, with a single parent 99ede85, an empty diff in both directions and no files changed. The branch remains four commits on base 1e7c966 with unchanged attribution. The `salesforce` tree `146da0f` and `service` tree `06db88a` are identical to 99ede85, so no source re-review is required and the verdict at 99ede85 carries forward: findings 46 and 48 closed, zero open source findings, notes 47 and 49 informational, note 34 open.

Reconciliation of the previous failed-cleanup org is complete and verified: `ScratchOrgInfo` `2SRbm000004XxJxGAK` reads Status Deleted with `DeletedDate` 2026-09-17, the audit trail records `deleteScratchOrg` for `00DRK00000b6ouT` at 21:32:52 UTC, `ActiveScratchOrg` returns zero rows, and capacity is 3 of 3 active with 2 of 6 daily remaining before the reset near 07:00 UTC. No owned org from run 35273720037 remains.

Retry budget for the fresh head is allowed as an initial attempt, on the workflow's own evidence rather than a simulation: in the policy job of run 35277463109 the classifier returned `full-apex`, the headSha equality check passed, and the budget step ran the pinned `apex-run-budget.mjs` and reached `allowed=true` at 21:35:02, with the trusted pin 1d0edc1 present in that log. The `failed-cleanup` record against 99ede85 does not follow a new sha.

Sequencing decision: run 35277463109 must not be approved. Branch protection on main sets `strict: true` and `enforce_admins: true`, with required contexts Salesforce verification gate, Scaffold and lint, and Service and container tests, so PR #27 must be up to date before it can merge and there is no admin override. GitHub reports it BEHIND and MERGEABLE. Approving 58aa6f7 would still leave the branch needing an update, which creates another head on which all required checks must pass again, costing both remaining daily orgs instead of one. The protected job independently re-checks that the live PR head equals the reviewed sha, so a stale approval after an update refuses before creating an org, but that is a safety net rather than a plan.

The update was rehearsed locally in a throwaway worktree and then discarded: merging b24d8a3 into 58aa6f7 is clean, touches only `docs/verification-log.md` by adding the 120 lines that reached main through PR #28, and yields predicted tree `23e9f9ea7564fecbb8d19148f138a43ba1fed013` with the `salesforce` and `service` trees byte-identical and the pull request's diff against main still exactly the same six files. Merge is preferred over rebase, which would drop the empty commit and rewrite the reviewed shas out of the ancestry. Two cautions: the protected job uses a single concurrency group with `cancel-in-progress: false`, so the stale run should be cancelled before the update to avoid queuing behind an unresolved approval; and a merge queue must not be used, because this workflow has no `merge_group` trigger and the required gate would never report.

Agreed order: cancel 35277463109, update PR #27 from main by merge, verify the resulting head against the predicted tree and clear its run, approve exactly one hosted run, squash merge PR #27 while it is up to date, and merge this log branch only afterwards.

Process correction owned by the verifier: merging log PR #28 before the source pull request is what put main ahead and caused this sequencing problem. The established order, used for every earlier unit, is source pull request first and log second, and it will be held to.

`HOLD: run 35277463109 at head 58aa6f7`

`HOLD: PR #27, 0 source findings`, pending hosted success on the updated head with an exact-head marker and a Deleted org.

## 2026-09-17: PR #27 final head `94eae1f` cleared for one hosted run

The branch update landed exactly as predicted. Head `94eae1f8cdd36843aa12a7492eb5164c9c4d17ec` is a GitHub-generated merge with two parents in the expected order, reviewed identity `58aa6f7` then current main `b24d8a3`, and its tree is `23e9f9ea7564fecbb8d19148f138a43ba1fed013`, character for character the tree predicted from a throwaway merge before the update was performed.

Byte identity against reviewed source head 99ede85: the `service` tree `06db88a` and `salesforce` tree `146da0f` are identical, and so are the `.github` tree `58fff68` and `scripts` tree `01418bb`, so neither the workflow nor the harness directory moved under cover of the merge. The update changed exactly one file, `docs/verification-log.md`, adding 121 lines and removing none, all of it the already reviewed verifier log that reached main through PR #28. The pull request's footprint against main is still exactly six files: three docs and three service files. No source byte changed, so no source re-review was required and the verdict carries forward: findings 46 and 48 closed, zero open source findings, notes 47, 49 and 50 informational, note 34 open.

The stray org remains reconciled: `kusanya-ci-v1__35273720037-1__99ede856accc__bb0b89f88586` reads Status Deleted with `DeletedDate` 2026-09-17, `ActiveScratchOrg` returns zero rows, and capacity at 21:59 UTC is 3 of 3 active with 2 of 6 daily remaining. That record is the only one in the 3527 series, which independently confirms that no waiting or rejected run created an org. Run 35277463109 ended in failure with zero steps in its protected job, the signature of a rejected deployment, and created nothing.

The branch is now up to date, so BEHIND is cleared and GitHub reports MERGEABLE with only the Salesforce gate outstanding. Scaffold and lint and Service and container tests passed, and public CI 35279180570 passed at this head.

Attribution needs no rewrite. The merge commit is authored `cobitechsolutions <cobitechsolutions@gmail.com>` and committed by `GitHub <noreply@github.com>`, which is what the Update branch button produces, and it carries GitHub's web-flow signature, reported locally as unverifiable only because that public key is absent from the verifier's keyring. `required_signatures` is false, there are no rulesets, linear history is not required, and the trust boundary concerns content, which is byte-identical. Rewriting would invalidate the run and cost another org for no gain.

Retry budget for the final head is one attempt, authorised by the pinned script itself: in the policy job at 21:54:07 the trusted checkout resolved pin 1d0edc1, the reviewed sha was 94eae1f at every step, and `apex-run-budget.mjs` printed `{"allowed":true,"kind":"initial","reason":"No prior attempt consumed this head and UTC day."}`. The pin appears twice in the final head's workflow file. One org remains spare today for a cleared infrastructure retry.

Merge order for this unit: PR #27 squash merges first, then log PR #29, which will itself need a docs-only update from main and takes the documentation exemption at no scratch-org cost.

`SAFE TO APPROVE: run 35279180481 at head 94eae1f`

`HOLD: PR #27, 0 source findings`, pending that run's success with an exact-head marker, 85 percent coverage and a Deleted org with a matching deletion audit entry.

## 2026-09-17: PR #27 PASS at `94eae1f`; run 35279180481 verified end to end

Run 35279180481 attempt 1, no reruns. The trusted marker reads `{"schemaVersion":1,"role":"ci","runId":"35279180481-1","headSha":"94eae1f8cdd36843aa12a7492eb5164c9c4d17ec","startedAt":"2026-09-17T22:04:52.640Z","outcome":"passed","retryable":false}`, and the post-test guard re-confirmed the live pull request head had not moved during testing.

Apex: 81 passed, 473 of 475 executable lines at 99.58 percent, no C10 acceptance test claimed. That is the same count and coverage produced at 99ede85, which is what a byte-identical source tree should produce. Cleanup reported one owned scratch org deleted and none already deleted, no fallback step fired, and the Dev Hub logout succeeded.

Dev Hub confirmation, read-only: exactly one row carries the run's tag, `ScratchOrgInfo` `2SRbm000004Y0o5GAC`, OrgName `kusanya-ci-v1__35279180481-1__94eae1f8cdd3__5825ec3e64c6`, ScratchOrg `00Dcf00000HvRbC`, Developer edition, Status Deleted, `DeletedDate` 2026-09-17, `ErrorCode` null. The audit trail records `deleteScratchOrg` for that org at 22:06:32 UTC, matching the job's completion second for second. `ActiveScratchOrg` returns zero rows and capacity is 3 of 3 active with 1 of 6 daily remaining. The org's real lifetime was 22:04:56 to 22:06:32, so the deploy and all 81 tests ran inside a 96-second window on a genuine org that the Dev Hub independently records as created and then removed.

Credential hygiene: all 531 log lines scanned with no `force://` URLs, org session ids, access, refresh or bearer tokens, client secrets, private keys, JWTs or email addresses. The ten masks are GitHub's own redactions of `GH_TOKEN`, the checkout token, the git extraheader and `SF_DEV_HUB_AUTH_URL`. The only warning is note 35's Node.js 20 deprecation.

All five required checks passed on this head, GitHub reports the pull request CLEAN and MERGEABLE, and the head is unchanged at `94eae1f8cdd36843aa12a7492eb5164c9c4d17ec`.

Unit outcome: ADR 0021 and the Describe normalizer are accepted. Findings 46 and 48 are closed, both found against real Salesforce metadata read from the Dev Hub rather than fixtures, and this unit was the first to run the whole publication chain on genuine Describe output. Notes 47, 49 and 50 are informational; note 34 remains open; notes 36, 37 and 39 remain open; 24, 25, 27 to 31 and 35 carry forward; 42 and 45 are informational; 38, 40, 41, 43 and 44 are answered. Zero open findings.

`PASS: PR #27 may be merged`

## 2026-09-18: PR #30 publication preflight (ADR 0022) at `1658e35`; no findings, run 35378272021 cleared

Preconditions: head `1658e35879a09b2f5a1ee6ecbe20884723f7ddb6` is exactly one commit on accepted main `76c9a20`, attributed to Bill Owiti. Main CI 35280880673 passed and main has not moved. Five files change: `service/src/publication/preflight.ts`, its unit test, ADR 0022, architecture.md and roadmap.md. The `.github`, `scripts` and `salesforce` trees and all three package and lock files are byte-identical to main, and the pin 1d0edc1 appears twice.

Local, in a detached worktree: root 252 of 252, service unit 189 of 189, integration 1 passed and 1 skipped without a disposable PostgreSQL URL, lint, typecheck, format check, scaffold, production audit at the low threshold with zero results, and `git diff --check`. Public CI 35378272063 passed.

Adversarial probes, 72 of 72 plus two supplementary checks:

- Nine form and mapping refusals and a compile-only `OUTPUT_LIMIT` refusal all make zero Describe calls. The output limit was reached within the input budget by five-fold ampersand escaping.
- Mutating labels, types, names, questions, the title, targets, fields and the mapping list from inside the first Describe callback leaves the result byte-identical to an untouched control run and the request list unchanged. Throwing getters installed mid-flight are never read, and a mid-flight mutation can neither induce nor rescue a refusal.
- Flip-flop getters, proxies, function-valued keys and symbol keys are refused at decode with zero calls, so no caller code runs between decode and snapshot. Deep-frozen inputs succeed.
- 720 orderings of six mappings with four casings of one object give one output and one request order. Canonical-casing Describe answers are accepted.
- No cache across runs. Provider failure at call 1, 2 or 3 reports exactly that count and stops, a malformed second response reports 2, and a target refusal after three calls reports 3.
- Twelve hostile provider behaviours are refused as bounded failures with no secret disclosed.
- The unmodified Account Describe from the Dev Hub passes a valid lowercase mapping, and a missing field, text into an integer, `Id`, an unknown restricted state code, a blank into required `Name`, a provider 404 and a non-createable object each fail with the expected code and no XML.
- The hash equals SHA-256 over the UTF-8 bytes of the returned XML, is lowercase hex and deterministic, and lone surrogates are refused at input with `INPUT_TEXT`, so UTF-8 replacement cannot make two strings share a hash.
- Success and failure results are frozen to the record level with exactly the documented keys, arrays are fresh per run, inputs are unmutated on every path, empty mappings make zero calls with only the compiler's own warnings, and the preflight XML equals `compileForm` output.
- Form and target warnings both survive into one result, and the compiler adds no warnings beyond preparation.

Documentation matches the code. Non-blocking observation: roadmap.md names only log PR #29 for PR #27, although log PR #28 (`b24d8a3`) also carried that unit's log.

Note 51, informational: `targetObjects` and the snapshot's object names carry the code-unit-minimum mapping spelling, such as `account` or `VISIT__C`, not Salesforce's canonical spelling. This is deterministic, matches ADR 0022 and is accepted by Salesforce, but a future publisher or stored artifact should take canonical names from the Describe response if canonical spelling matters.

Note 52, informational: Describe latency is unbounded. A Describe promise that never settles left the preflight pending beyond a two-second observation window with nothing in the code to end it. The concrete transport should enforce a per-request timeout and an overall deadline, and note 34's closure should verify it.

Hosted run 35378272021 is on the exact head with its trusted checkout at pin 1d0edc1, and the pinned budget script printed `{"allowed":true,"kind":"initial","reason":"No prior attempt consumed this head and UTC day."}`. Zero active scratch orgs and 6 of 6 daily remaining at 18:18 UTC.

`SAFE TO APPROVE: run 35378272021 at head 1658e35`

`HOLD: PR #30, 0 findings`, pending hosted success with an exact-head marker, 85 percent coverage and a Deleted org. Note 34 advances but stays open; notes 36, 37 and 39 remain open; notes 47, 49, 50, 51 and 52 are informational; 24, 25, 27 to 31 and 35 carry forward; 42 and 45 are informational; 38, 40, 41, 43 and 44 are answered.

## 2026-09-18: PR #30 PASS at `1658e35`; run 35378272021 verified end to end

Run 35378272021 attempt 1, no reruns. The trusted marker reads `{"schemaVersion":1,"role":"ci","runId":"35378272021-1","headSha":"1658e35879a09b2f5a1ee6ecbe20884723f7ddb6","startedAt":"2026-09-18T18:21:04.930Z","outcome":"passed","retryable":false}`, and the post-test guard confirmed the head did not move during testing. Apex: 81 passed, 473 of 475 executable lines at 99.58 percent, no C10 test claimed, identical to the previous unit because the `salesforce` tree is unchanged. Cleanup deleted one owned org with none already deleted, and no fallback step fired.

Dev Hub, read-only: exactly one row carries the run's tag, `ScratchOrgInfo` `2SRbm000004ZR33GAG`, org `00Dcb00000OFcHG`, Status Deleted, created 18:21:09, `DeletedDate` 2026-09-18, `ErrorCode` null, with a matching `deleteScratchOrg` audit entry at 18:22:29 UTC. Zero active orgs; capacity 3 of 3 active and 5 of 6 daily.

Credential hygiene: all 531 log lines clean, with the ten masks being GitHub's own redactions and note 35's Node.js 20 notice the only warning. All five required checks passed on the unchanged head and the pull request is CLEAN.

Unit outcome: ADR 0022 and the publication preflight are accepted with zero findings. Note 34 advances but stays open; notes 51 and 52 are informational.

`PASS: PR #30 may be merged`

## 2026-09-18: PR #32 content-addressed publication package (ADR 0023) at `b129d81`; no findings, run 35382549745 cleared

Preconditions: head `b129d817927de35ea09c32e912a5414f05145ce7` is exactly one commit on accepted main `aab1c19`, with author and committer Bill Owiti <cobitechsolutions@gmail.com>. Main CI 35380800868 passed and main has not moved. Seven files change: `package.ts`, `preflight.ts`, two unit tests, ADR 0023, architecture.md and roadmap.md. The `.github`, `scripts` and `salesforce` trees and all four package and lock files are byte-identical to main, and the pin 1d0edc1 appears twice.

Local, in a detached worktree: root 252 of 252, service unit 197 of 197, integration 1 passed and 1 skipped, lint, typecheck, format, scaffold, production audit with zero results and `git diff --check`. The interchange checker passed all 8 fixtures and the XLSX checker reproduced `e8aa7ba59d675ce3dbad3aaa7c96a9c696ada1c92dcadb1157ed2339ae030931`. Public CI 35382549668 passed.

Adversarial probes, 99 of 99 plus targeted checks:

- Public ADR 0022 compatibility: main and head built side by side return byte-identical preflight results across eight scenarios, with the same keys and no `targetSchema`.
- Local refusals spend zero Describe calls, including a compile `OUTPUT_LIMIT`, an unsupported option and a table-only refusal. A 32,768-character label passes the public preflight with one call but is refused by the package with `XLSFORM_CELL_LIMIT` and zero calls, while 32,767 passes.
- Mid-flight mutation of labels, author notes, choices, questions, title, targets, field order and mappings leaves package bytes identical to a control run. The internal target schema is frozen at every level, deep-frozen inputs work and inputs are unmutated.
- Package targets and target-schema JSON read `Account` and `Visit__c` from Describe, the authoring JSON keeps `account` and `VISIT__C`, and the public preflight still reports mapping spelling.
- Package bytes are invariant under reversed definition records, mapping arrays, mapping fields and key order, and under three shuffles of the real Account Describe across fields, picklists, references and record types. Repeat runs match on every digest. No locale sort, clock or randomness, and no request count or operational identifiers in the manifest.
- The authoring JSON re-imports byte-stable, the decoded XLSX re-imports to the identical authoring JSON, and both compile to the exact packaged XML. Every digest recomputes, the XLSX digest is over decoded bytes, base64 is canonical, and the workbook has no formula elements with formula-prefix strings stored literally.
- The digest verifier accepts only the exact lowercase digest over an in-limit string, rejects every tampering, casing, length, type and over-limit case tried, never coerces objects and does not parse.
- Provider refusals match the public preflight's diagnostics with one request and no leak. Both size refusals are unreachable with valid input because upstream budgets cap local content well below 8,000,000 characters, so they were exercised through lowered-cap copies of the built module and each returned `PUBLICATION_PACKAGE_LIMIT` at `package` with `requestCount` 1.
- Empty mappings give a valid, verifiable package with zero calls. Warnings are invariant under mapping reordering and frozen. `publisher-only` appears in result and manifest, and author notes appear in the authoring JSON and XLSX but never the XML.

Documentation matches the code, and the roadmap now records log PR #28 before #29.

Correction to note 51 as recorded for PR #30: the statement that the Describe snapshot's object names carry mapping spelling was wrong. The ADR 0021 normalizer stores the response name, confirmed in the code and in the packaged target-schema JSON. The statement about the preflight's `targetObjects` was correct. Note 51 is now answered at the package boundary.

Note 53, informational, both pre-existing and failing closed: the ADR 0019 validator accepts at most 2,000 fields and 200 record types per object while the ADR 0021 normalizer accepts 5,000 and 1,000, so an object between those sizes is refused with `PUBLISH_SCHEMA_LIMIT` rather than `PUBLISH_DESCRIBE_LIMIT`, which was missed in the PR #27 review; and the definition text limit of 32,768 exceeds the XLSX cell limit of 32,767, so a label of exactly 32,768 can pass preflight but never be packaged. Align them when either boundary is next touched.

Hosted run 35382549745 is on the exact head with its trusted checkout at pin 1d0edc1, and the pinned budget script printed `{"allowed":true,"kind":"initial","reason":"No prior attempt consumed this head and UTC day."}`. Zero active orgs and 5 of 6 daily remaining at 19:15 UTC.

`SAFE TO APPROVE: run 35382549745 at head b129d81`

`HOLD: PR #32, 0 findings`, pending hosted success. Note 51 is answered at the package boundary; note 52 stays within note 34's closing conditions; note 34 stays open; notes 36, 37 and 39 remain open; notes 47, 49, 50 and 53 are informational; 24, 25, 27 to 31 and 35 carry forward; 42 and 45 are informational; 38, 40, 41, 43 and 44 are answered.

## 2026-09-18: PR #32 PASS at `b129d81`; run 35382549745 verified end to end

Run 35382549745 attempt 1, no reruns. The trusted marker reads `{"schemaVersion":1,"role":"ci","runId":"35382549745-1","headSha":"b129d817927de35ea09c32e912a5414f05145ce7","startedAt":"2026-09-18T19:18:41.882Z","outcome":"passed","retryable":false}`. Apex: 81 passed, 473 of 475 executable lines at 99.58 percent, no C10 test claimed. Cleanup deleted one owned org with none already deleted, and no fallback step fired.

Dev Hub, read-only: exactly one row carries the run's tag, `ScratchOrgInfo` `2SRbm000004ZSVNGA4`, org `00DEc00000lyX9N`, Status Deleted, created 19:18:46, `DeletedDate` 2026-09-18, `ErrorCode` null, with a matching `deleteScratchOrg` audit entry at 19:19:54 UTC. Zero active orgs; capacity 3 of 3 active and 4 of 6 daily.

Credential hygiene: all 531 log lines clean, the ten masks being GitHub's own redactions and note 35's Node.js 20 notice the only warning. All five required checks passed on the unchanged head and the pull request is CLEAN.

Unit outcome: ADR 0023 and the content-addressed publication package are accepted with zero findings. Note 51 is answered at the package boundary; note 53 is informational.

`PASS: PR #32 may be merged`

## 2026-09-21: PR #34 automatic ODK Validate gate (ADR 0024) at `5e9dfce`; finding 54, run 35619801600 on hold

Preconditions: head `5e9dfce57be48d1d521760060ea3219c545a1a92` is exactly one commit on accepted main `92ec5d3`, authored and committed by Bill Owiti. Main CI 35385815996 passed and main has not moved. Exactly the seven declared files change; the `.github`, `scripts` and `salesforce` trees and all four package and lock files are byte-identical to main; the pin 1d0edc1 appears twice.

Local, in a detached worktree: root 252 of 252, service unit 206 of 206, integration 1 passed and 1 skipped, lint, typecheck, format, scaffold, production audit with zero results, `git diff --check`, 8 interchange fixtures and the XLSX fixture digest. Public CI 35619801599 passed.

Finding 54, low severity: `decodeValidationResult` accepts an ordinary `Proxy`. Both `new Proxy({ ok: true }, {})` and a proxy whose `getPrototypeOf` trap returns `Object.prototype` over a null-prototype target produce a full package. The trap case defeats the decoder's own prototype check, and `Object.getOwnPropertyDescriptors` runs traps before that check. No security impact was found: values are snapshotted into descriptors and read once, so there is no time-of-check gap, and `code` and `location` must still match the fixed allowlist, so a proxy conveys nothing a plain object could not. It is reported because the brief requires refusing proxies and because `types.isProxy` is already the house rule at four other input boundaries, in `compiler/definition.ts` twice, `interchange/bundle.ts` and `interchange/xlsform-tables.ts` twice. Bounded fix: import `types` from `node:util`, add `types.isProxy(value)` to the first guard in `decodeValidationResult` and `types.isProxy(diagnosticDescriptor.value)` to the diagnostic guard, with two unit cases.

Everything else in the brief holds, across 173 probe checks plus mutation and genuine-tool runs. The string handed to the validator is the exact string embedded in package JSON and covered by `xformSha256`, and the validator runs once. Forty hostile result shapes are refused without running a getter or trap and without leaking a supplied value, while the five documented code and location pairs pass through as fresh frozen records. Every refusal returns only `ok`, `diagnostics` and `requestCount` with exact counts. Authoring, mapping, compile, workbook, provider and target refusals all precede validation; as ADR 0024 documents, an invalid XForm is refused after Describe and therefore costs one request per target.

Adapter: relative Java or JAR paths refuse before any process starts; a missing JAR, a directory, an empty file, one flipped byte, a truncated copy and a 65 MiB file all fail closed without disclosing paths or XML; configuration mutated after construction is ignored. Overwriting the configured JAR while validation was in flight did not affect the run, which completed from the verified copy, and the next call refused the replaced file with `PUBLICATION_VALIDATOR_PIN`. Exit 0 is valid, exits 1, 2, 3, 42 and 137 are invalid, and a missing executable, timeout, overflow and output split across both streams are infrastructure. With the cap lowered to 200 ms against the real JVM the adapter refused in 233 ms, removed its workspace and left no orphan Java process. A directory name full of shell metacharacters ran as one literal argument with no side effect. No temporary directory survived any path, and with `rm` forced to throw an otherwise valid form returned `PUBLICATION_VALIDATOR_CLEANUP`. Package bytes and digests are identical to those from accepted main, inputs are unmutated, and omitting the validator argument fails closed.

Genuine ODK Validate 1.20.0: the JAR available on this machine hashes to the pinned digest exactly. It accepted four compiled fixtures and the largest form the compiler will emit at 157,383 characters, in about half a second under the 256 MiB heap, and refused malformed XML, a non-XForm document, an empty string, an invalid XPath bind, a duplicate instance id and a truncated form.

Note 55, informational: on Windows an abnormally terminated JVM reports exit code 1 with no signal, so the classifier records an invalid XForm rather than an infrastructure failure. On Linux, where the service runs, the signal is reported and the classification is correct. Worth one sentence in the ADR.

Note 56, informational: on Windows libuv adds `HOMEDRIVE`, `HOMEPATH`, `LOGONSERVER`, `SYSTEMDRIVE`, `USERDOMAIN`, `USERNAME` and `USERPROFILE` to any child environment regardless of the code's allowlist, confirmed by a direct spawn carrying one variable. No credential-shaped variable reaches the child; the only exposure is the local account name to the pinned JAR.

Note 57, informational: the JAR on this machine matches the pin exactly, but both the file and the pin originate from the builder's download, and nothing outside the repository was fetched during this review. The digest should be confirmed once against ODK's published release checksum.

Note 58, informational: ODK Validate 1.20.0 accepts a bind that points at a node absent from the instance, so this gate proves JavaRosa parsing and XPath validity rather than structural completeness, consistent with what ADR 0024 already disclaims about runtime behaviour.

Documentation matches the code, and note 53 is correctly untouched.

`HOLD: run 35619801600 at head 5e9dfce`

`HOLD: PR #34, 1 finding` (54). Notes 55 to 58 are informational. Note 34 stays open with note 52 inside its closing conditions; notes 36, 37 and 39 remain open; notes 42, 45, 47, 49, 50 and 53 are informational; 38, 40, 41, 43, 44 and 51 are answered; 24, 25, 27 to 31 and 35 carry forward.

## 2026-09-21: PR #34 corrective head `3a2b4ce` closes finding 54; run 35638518820 cleared

Head `3a2b4ce711e7de919f03d3d2967240bcd9e84937` is the reviewed head `5e9dfce` plus one commit on base `92ec5d3`, authored and committed by Bill Owiti. The corrective delta touches only `package.ts`, its unit test and ADR 0024. Everything else is byte-identical to the previously reviewed head, including `odk-validate.ts`, `preflight.ts`, the adapter test, architecture.md, roadmap.md, the `.github`, `scripts` and `salesforce` trees and both lockfiles, and the pin appears twice, so the adapter review carries forward unchanged.

Local: root 252 of 252, service unit 207 of 207, integration 1 passed and 1 skipped, lint, typecheck, format, scaffold, production audit with zero results and `git diff --check`. Public CI 35638518629 passed.

Finding 54 closed. The `types.isProxy` guard is placed before any descriptor read, so a proxy is rejected before its traps can run, and the nested guard runs before the prototype check. Thirteen proxy shapes at both levels were refused as `PUBLICATION_VALIDATOR_FAILURE` at `validator`, with no package, exact request counts and no leakage: ordinary proxies over valid true and false results, the prototype-lying proxy that previously passed, a descriptor-forging proxy fabricating `ok` through `ownKeys` and `getOwnPropertyDescriptor`, revoked and trap-throwing proxies at the top level, ordinary, prototype-lying, revoked and trap-throwing proxies in the nested diagnostic, and proxies wrapping proxies at both levels. With every trap instrumented, the only trap that fired was a single `get` of `then`, which is the thenable lookup `await` performs on any value; the decoder touched nothing.

Plain results are unaffected: a valid result still succeeds with the `odk-validate-1.20.0` label, documented refusals still surface their own codes, a frozen plain object still succeeds and a null-prototype plain object is still refused. The full package suite passes 112 of 112 on this head.

Observation, not a defect: a validator may return a thenable, including a proxy acting as one, and `await` resolves it before decoding, so a proxy can only enter by resolving to a genuine plain object, which conveys nothing extra. A throwing `then` accessor is caught as `PUBLICATION_VALIDATOR_FAILURE`.

ADR 0024 now records note 55 accurately, including that adapter-initiated timeout and output-limit terminations remain infrastructure failures because the adapter records that it initiated them, which matches the `forcedFailure` flag. Notes 56, 57 and 58 remain informational, and note 57 still awaits one out-of-band confirmation of the pinned digest against ODK's published checksum.

Runs: 35619801600 is stale on `5e9dfce` and still waiting; 35638518820 is on the exact corrective head with pin 1d0edc1 resolved and a budget verdict of `{"allowed":true,"kind":"initial","reason":"No prior attempt consumed this head and UTC day."}`. The new run's protected job reads `pending` rather than `waiting` because the single non-cancelling concurrency group is held by the stale run, so the stale run must be cleared first. Capacity at 18:35 UTC: 0 active, 6 of 6 daily.

`SAFE TO APPROVE: run 35638518820 at head 3a2b4ce`, after the stale run is cleared.

`HOLD: PR #34, 0 findings`, pending hosted success with an exact-head marker, 85 percent coverage and a Deleted org.

## 2026-09-21: PR #34 PASS at `3a2b4ce`; run 35638518820 verified end to end

Run 35638518820 attempt 1, no reruns. The trusted marker reads `{"schemaVersion":1,"role":"ci","runId":"35638518820-1","headSha":"3a2b4ce711e7de919f03d3d2967240bcd9e84937","startedAt":"2026-09-21T19:01:30.170Z","outcome":"passed","retryable":false}`. Apex: 81 passed, 473 of 475 executable lines at 99.58 percent, no C10 test claimed, unchanged because the `salesforce` tree does not change in this unit. Cleanup deleted one owned org with none already deleted, and no fallback step fired.

Dev Hub, read-only: one row carries the run's tag, `kusanya-ci-v1__35638518820-1__3a2b4ce711e7__5a185eeb2233`, org `00DRL00000WhOMP`, Status Deleted, created 19:01:34, `DeletedDate` 2026-09-21, `ErrorCode` null, with a matching `deleteScratchOrg` audit entry at 19:03:13 UTC. Zero active orgs; capacity 3 of 3 active and 5 of 6 daily. The superseded run 35619801600 ended in failure with zero steps in its protected job and created no org.

Credential hygiene: all 531 log lines clean, the ten masks being GitHub's own redactions and note 35's Node.js 20 notice the only warning. All five required checks passed on the unchanged head and the pull request is CLEAN.

Unit outcome: ADR 0024 and the automatic ODK Validate publication gate are accepted. Finding 54 is closed. Notes 55, 56 and 58 are informational. Note 57 remains open until the pinned JAR digest is confirmed once against ODK's published release checksum.

`PASS: PR #34 may be merged`

## 2026-09-21: PR #36 bounded Salesforce Describe transport (ADR 0025) at `7997324`; no findings, run 35646852402 cleared

Preconditions: head `7997324d200ee60b42d768a626b33a885d5e5d79` is exactly one commit on accepted main `aa80c5c`, authored and committed by Bill Owiti. Main CI 35643486321 passed and main has not moved. Exactly the five declared files change; the `.github`, `scripts` and `salesforce` trees, all four package and lock files and `salesforce-describe.ts` are byte-identical to main; the pin 1d0edc1 appears twice.

Local, in a detached worktree: root 252 of 252, service unit 216 of 216, integration 1 passed and 1 skipped, lint, typecheck, format, scaffold, production audit with zero results and `git diff --check`. Public CI 35646852421 passed.

Probes, 149 checks plus targeted follow-ups:

- Configuration: fifteen hostile shapes refused at construction, including ordinary, prototype-lying and revoked proxies, null prototypes, class instances, extra and symbol keys, each missing key and an accessor-valued key whose getter never ran.
- Origins: three realistic origins accepted; twenty-four refused, including HTTP, trailing slash, explicit `:443`, path, query, fragment, credentials, `evilsalesforce.com`, `salesforce.com.evil.test`, a trailing-dot FQDN, loopback IPv4 and IPv6, `file:` and `javascript:`, whitespace padding, uppercase, a non-443 port, a punycode lookalike and a 2,100-character host.
- Timeouts: zero, negative, fractional, NaN, Infinity, string, unsafe-integer and over-cap values refused on both timers, an overall shorter than per-request refused, and the exact maxima and an equal pair accepted.
- Requests: the URL is exactly `/services/data/v64.0/sobjects/<name>/describe` and 64.0 matches `salesforce/sfdx-project.json` and the Apex metadata. GET with exactly `accept` and `authorization`, `cache: no-store`, `credentials: omit`, `redirect: manual`, an abort signal, no body and no retry. Seventeen malformed names, including traversal, slash, query suffix, leading digit, leading underscore, 256 characters and non-strings, are refused before token acquisition or network I/O; 255 characters is accepted; each call takes a fresh token and makes exactly one fetch.
- Tokens: empty, whitespace, newline, carriage return, tab, control character, non-ASCII, over-length, null, numeric and object values refused before the fetch, so Bearer header injection is unreachable; 4,096 characters accepted; a throwing provider gives a bounded silent failure.
- Responses: 201, 204, 301, 302, 401, 403, 500, missing content type, `text/html`, `application/json-patch+json`, `text/json`, `application/ld+json`, over-cap or malformed declared length, empty body, malformed JSON, trailing junk, invalid UTF-8 under fatal decoding, a forced `redirected` flag, a throwing fetch and a non-Response return are all refused. `application/json` with parameters, any case and surrounding whitespace is accepted. The size boundary is exact: 8,388,608 bytes succeed and 8,388,609 fail; a declared 8 MiB is accepted and one more refused; a 9 MiB chunked body is refused with an absent or falsely small declared length.
- Redirects: a 301 to `https://evil.test/` is refused after exactly one fetch, so no second request or Authorization header exists.
- Deadlines: hanging fetch, token provider and body read each refuse within the per-request budget; the timeout aborts the fetch signal and cancels a locked reader; the shared overall deadline lets two 500 ms calls through a 1,200 ms budget and refuses the third, a later call fails immediately with no I/O, and a fresh adapter starts a fresh deadline. Three concurrent calls each get their own controller. No unhandled rejection and no surviving timer handle. A fetch that ignores the abort and resolves 400 ms late still refused on time, and the orphaned continuation cancelled that late response's body itself because the signal was already aborted.
- Composition: real Account metadata flows through the transport into the ADR 0021 normalizer; hostile-but-parsable JSON is still refused by the normalizer rather than the transport; failures become `PUBLISH_DESCRIBE_REQUEST` at `objects[0]` and `objects[1]` with exact counts; repeated names refetch, so no result or token cache exists; frozen input names and the provider's object are unmutated.

Documentation matches the implementation. Note 52 is implemented at this HTTP boundary, and note 34 correctly stays open for tenant OAuth selection, encrypted credential persistence and rotation, restricted-user FLS proof, definition loading and the refusing publisher.

Note 59, informational: the per-request timer is unref'd, so in a process where nothing else keeps the event loop alive and the fetch registers no handle, the timer cannot fire and the call never settles. This matches the ODK adapter's deliberate pattern and is unreachable with the real `fetch` or inside the running service, but it matters for a future short-lived CLI publish command.

Two observations that are not defects: the declared `content-length` is parsed leniently, so values like `1e3` are accepted while the streamed counter remains authoritative; and nothing enforces the ADR's rule against reusing an adapter across attempts, though a reused adapter simply finds its deadline expired and fails closed.

`SAFE TO APPROVE: run 35646852402 at head 7997324`

`HOLD: PR #36, 0 findings`, pending hosted success with an exact-head marker, 85 percent coverage and a Deleted org. Note 34 stays open; notes 36, 37 and 39 remain open; notes 47, 49, 50, 53, 55, 56, 58 and 59 are informational; note 57 stays with Bill; 38, 40, 41, 43, 44, 51 and 54 are answered or closed; 24, 25, 27 to 31 and 35 carry forward.

## 2026-09-21: PR #36 PASS at `7997324`; run 35646852402 verified end to end

Run 35646852402 attempt 1, no reruns. The trusted marker reads `{"schemaVersion":1,"role":"ci","runId":"35646852402-1","headSha":"7997324d200ee60b42d768a626b33a885d5e5d79","startedAt":"2026-09-21T20:41:17.183Z","outcome":"passed","retryable":false}`. Apex: 81 passed, 473 of 475 executable lines at 99.58 percent, no C10 test claimed, unchanged because the `salesforce` tree is untouched in this unit. Cleanup deleted one owned org with none already deleted, and no fallback step fired.

Dev Hub, read-only: one row carries the run's tag, `kusanya-ci-v1__35646852402-1__7997324d200e__21238f12c9b0`, org `00DRt00000XJawZ`, Status Deleted, created 20:41:21, `DeletedDate` 2026-09-21, `ErrorCode` null, with a matching `deleteScratchOrg` audit entry at 20:42:20 UTC. Zero active orgs; capacity 3 of 3 active and 4 of 6 daily.

Credential hygiene: all 531 log lines clean, the ten masks being GitHub's own redactions and note 35's Node.js 20 notice the only warning. All five required checks passed on the unchanged head and the pull request is CLEAN.

Unit outcome: ADR 0025 and the bounded Salesforce Describe transport are accepted with zero findings. Note 52 is implemented at this concrete HTTP boundary; note 34 remains open for tenant OAuth selection, encrypted credential persistence and rotation, restricted-user FLS proof, definition loading and the refusing publisher; note 59 is informational.

`PASS: PR #36 may be merged`

## 2026-09-23: ODK Collect runtime evidence; notes 36 and 37 tested, finding 60 on empty instanceID

Bill approved and prepared an Android emulator, so the Collect half of notes 36 and 37 finally has real runtime evidence. Environment: BlueStacks 5 instance `Pie64`, Android 9, ODK Collect v2026.3.4 installed by Bill, driven over the ADB that BlueStacks ships. No package was installed by the verifier and nothing was fetched from the network. Forms were compiled with the merged compiler at main `d9fce7e` and pushed into the local demo project. This is emulator evidence, not a physical-handset result; both questions concern JavaRosa evaluation rather than device hardware.

Note 36 is answered for ODK Collect: nested relative `jr:count` evaluates per repeat instance. The compiler emits `jr:count="/data/house_count"` for the root repeat and `jr:count="../person_count"` for the nested one. With two houses whose own counts were 1 and 3, Collect produced exactly one person row in house 1 and three in house 2, and the finalized submission contained one `people` element under the first house and three under the second. A second run with counts 2 and 1 produced two and one. The relative path is therefore evaluated against the repeat instance, not one level too high, so the feared off-by-one-level reading does not occur in Collect. The Enketo half of note 36 remains untested by the verifier, because the browser tooling is still uninstalled, so it rests on the builder's evidence alone.

Note 37 is confirmed for ODK Collect, and the divergence between engines is real. Three rows were answered, the count was then reduced from 3 to 2, and Collect continued to show `Rows > 3` holding `ROW-3`. The finalized submission contained `<row_count>2</row_count>` with three `rows` elements, including `ROW-3`. The submitted repeat count therefore does not equal the answered count, exactly as the note predicted, while the builder's Enketo run removed the trailing answered row. A publication or ingestion rule must be decided before any C10.2 or C10.3 claim, and the compiler warning must say the behaviour is client-specific.

Finding 60, high severity for the product, in merged compiler output rather than any open pull request: a finalized submission can carry an empty `instanceID` when the form has nested counted repeats and a nested count is changed during entry. The compiler emits the submission metadata as `<orx:meta><orx:instanceID/></orx:meta>` with the bind `/data/orx:meta/orx:instanceID` and `calculate="once(concat('uuid:', uuid()))"`. Observed in Collect v2026.3.4:

- The note 36 form finalized twice with `<orx:instanceID />` empty. In both runs a nested count was changed during entry.
- The single-repeat note 37 form populated `instanceID` normally, including when its count was reduced, so one repeat is not enough to trigger it.
- Four minimal forms with no repeats, covering the prefixed metadata, unprefixed metadata, `jr:preload="uid"` and a visible calculate, all populated `instanceID` normally, so neither the prefix nor `once(concat('uuid:', uuid()))` is broken on its own.
- The decisive comparison used two forms identical except for the metadata namespace, each run through the same sequence with a nested count changed from 1 to 3. With `orx:meta/orx:instanceID` the submission had an empty `instanceID` while an unprefixed root calculate in the same submission held its uuid. With `meta/instanceID` the submission carried `uuid:8d396042-3245-4d35-8acf-46e5a6a940d9`.

The observable rule is that changing a nested repeat count clears the value of the namespace-prefixed metadata node, while an unprefixed root calculate in the same form keeps its value. Consequence: submissions for any form using nested counted repeats can reach a server with no submission identity, which breaks OpenRosa deduplication and edit semantics and would make ingestion unreliable. Bounded correction: emit the metadata block unprefixed as `<meta><instanceID/></meta>` with the bind `/data/meta/instanceID`, which is what XLSForm and pyxform produce, and add a compiler test asserting the unprefixed nodeset. Verified fix behaviour is recorded above. A runtime regression test should drive a nested counted repeat whose count changes and assert a non-empty `instanceID`.

Notes ledger: note 36 is answered for Collect and still open for Enketo; note 37 is confirmed on the Collect side and stays open until a publication or ingestion rule is decided and tested in both engines; finding 60 is new and open. Notes 34, 39 remain open, note 52 is implemented, note 57 stays with Bill, and notes 47, 49, 50, 53, 55, 56, 58 and 59 remain informational.

## 2026-09-23: PR #40 corrects finding 60; finding 61 raised and closed; PASS at `b90b29f`

Preconditions: the unit began as head `0175795`, exactly one commit on accepted main `b62b8c9`, authored and committed by Bill Owiti, with the declared tree. Eighteen files changed. No dependency, lockfile or Salesforce metadata change; `scripts` differed only in the three optional runtime probes, while all eleven harness and policy scripts stayed byte-identical and the protected workflow never runs `scripts/runtime`; the pin appears twice. Public CI passed at each head.

Local checks reproduced at both heads: root 252 of 252, service 216 of 216, integration 1 passed and 1 skipped, lint, typecheck, format, scaffold, production audit with zero results, `git diff --check`, the 8 interchange fixtures, and the XLSX fixture digest unchanged at `e8aa7ba5…0931`.

The correction itself was verified rather than accepted. Across five fixtures covering nested, fixed and open repeats, the compiler emits exactly one `<meta><instanceID/></meta>`, exactly one bind `/data/meta/instanceID` carrying `once(concat('uuid:', uuid()))`, no `orx:meta` or `orx:instanceID`, and the block last inside the instance data element. Compiling every fixture at the base head and at the corrected head showed that, after rewriting only the metadata element and its bind in the base output, the two are byte-identical with unchanged warning locations, so the change is surgical. The warning rename to `DYNAMIC_REPEAT_CLIENT_SPECIFIC` is complete in preparation, compilation and the reviewer view, with fixed and open repeats emitting none. The reviewer text states the divergence and that a publication or ingestion rule is still required, choosing no trimming, deletion or cardinality policy, and note 37 stays open. Inputs are unmutated, output is deterministic and a deep-frozen definition compiles. Probes: 50 of 50.

Two external confirmations were run by the verifier rather than taken from the builder's report. The pinned ODK Validate 1.20.0, whose digest was confirmed against ODK's published release when note 57 closed, accepted all five corrected fixtures in about 400 milliseconds each, with an invalid-XPath negative control still refused. The tracked JavaRosa probe was executed here after checking all four jars against `scripts/runtime/javarosa-dependencies.json`: it printed `nested-count-change preserved nonempty instanceID=true`, `instanceID stable across reload=true`, `negative-instanceID-control detected regeneration across reload`, and the count-reduction results. That independently confirms the required nested-count, draft-reload and negative-control behaviours on JavaRosa 6.0.0. The corrected structure is also exactly the variant that populated a proper identity in Collect during the finding 60 investigation.

Finding 61, medium, raised at head `0175795` and closed at head `b90b29f`: the first corrective head deleted the project's only recorded evidence that Enketo rejects the structure now emitted, without retest or disclosure. At the base head, ADR 0015 stated that Enketo's transformer did not recognize unqualified metadata below `<data xmlns="">`, and `scripts/runtime/check-enketo.mjs` asserted that variant must fail initialization with `Invalid XML`. Both disappeared while the compiler began emitting precisely that structure, with Enketo uninstalled so no corrected bytes had been run, and no current document disclosing the contradiction. The correction restores the record in ADR 0015's context, stating the earlier Transformer 4.2.0 rejection, that corrected bytes have not been rerun in Enketo, that the contradiction must be resolved before any Enketo-based claim, and that notes 36 and 37 remain open on the Enketo side; its consequences section now separates settled Collect evidence from the outstanding Enketo verification. The probe asserts that every compiled fixture matches `<meta><instanceID/></meta>` before initialization and yields exactly one `instanceID` after, alongside the existing empty-initialization-errors assertion, and the snapshot helper counts only unprefixed nodes. The version attribution was checked: the tracked runner recorded as passing on 16 September used Core 9.0.1 with Transformer 4.2.0 and included that very negative control, so the observation was neither misattributed nor a one-off. The corrective delta touched only those two files, with everything else byte-identical to the reviewed head and the emitted XML untouched.

Hosted run 35848268869 attempt 1 at `b90b29f`: marker `{"schemaVersion":1,"role":"ci","runId":"35848268869-1","headSha":"b90b29f2072ede1cd9beab664984e55eb48a343f","startedAt":"2026-09-23T17:18:23.138Z","outcome":"passed","retryable":false}`, 81 Apex tests passing with 473 of 475 executable lines at 99.58 percent, and cleanup deleting one owned org with none already deleted. The Dev Hub shows `kusanya-ci-v1__35848268869-1__b90b29f2072e__8632c5a97578`, org `00DRK00000bYrG2`, Status Deleted, created 17:18:27, `DeletedDate` 2026-09-23, `ErrorCode` null, with a matching `deleteScratchOrg` audit entry at 17:19:38 UTC, zero active orgs and capacity 3 of 3 active with 5 of 6 daily. All 531 log lines were clean of credential material, the ten masks being GitHub's own redactions and note 35's Node.js 20 notice the only warning. All five required checks passed on the unchanged head. The superseded run 35840864982 ended with zero steps in its protected job and created nothing.

`PASS: PR #40 merged as 1abdb66`, with squash tree `83ff162` identical to the verified head.

Ledger: findings 60 and 61 are closed. Note 36 is answered for the Collect nested-count context and open for Enketo; note 37 is confirmed on the Collect side and open until a publication or ingestion rule is decided and tested in both engines; the corrected bytes still owe one Enketo run, now recorded in ADR 0015 and enforced by the probe. Note 34 remains open, note 52 is implemented, note 57 is closed, and notes 47, 49, 50, 53, 55, 56, 58 and 59 remain informational.

## 2026-09-23: PR #42 scoped definition snapshots (ADR 0026); findings 62 and 63 closed, note 24 closed, PASS at `d9787a1`

The unit began at head `1ef3565`, one commit on accepted main `d2bf3a3`, authored and committed by Bill Owiti, and reached `d9787a1` after two corrections. Fourteen files changed. No dependency, lockfile or workflow change; the two changed scripts were the root tripwires `definition-snapshot.test.mjs` and `form-model.test.mjs`, while all nine harness and policy scripts stayed byte-identical and the pin appeared twice throughout. Local checks reproduced at each head: root 254 of 254, service 216 of 216, integration 1 passed and 1 skipped, lint, typecheck, format, scaffold, both production audits at zero and `git diff --check`.

Source review of the reader and the permission change found nothing. The class is `public with sharing` with no `@RestResource`, `@AuraEnabled`, `@InvocableMethod` or `webservice` member, carries seven queries all in `WITH USER_MODE`, and contains no DML keyword. Both permission sets contain only the nine definition objects, flip `viewAllRecords` to true on exactly those, keep `modifyAllRecords` false everywhere, and add no system permissions and no Apex class access; Supervisor stays read-only and Kusanya Admin is untouched.

Behaviour was verified in the verifier's own scratch orgs with a probe class deployed only there, never committed. A cross-owner read by a different Integration principal succeeded; one snapshot cost seven queries and zero DML; two calls produced byte-identical output; no Salesforce record ID and no version ID appeared in the envelope; a Supervisor could read but was denied a definition write; an ungranted principal, a null identifier, a User identifier and a non-existent Form Version identifier each produced only `DEFINITION_SNAPSHOT_REFUSED`; 502 questions were refused at the bound. Relationship translation and local keys behaved as documented, with `parent`, `sourceQuestion` and `question` carried by name, `choice_list_1` and `mapping_1` assigned deterministically, a `form_` digest identity, and a null constant round-tripping as `"constantValue": null`.

Finding 62, high, raised at `1ef3565` and closed at `aef2583`: `emitsPortableDeterministicBundleWithoutRecordIds` failed in any fresh scratch org. It was the only test without `System.runAs`, so it ran as the deploying administrator, who holds no field-level security on the optional definition fields because a metadata deploy grants none. The Tooling API listed all 34 custom fields on `Question__c` while a describe as that user returned only the master-detail and required fields, so every user-mode query was rejected and the reader refused exactly as designed. Assigning `Kusanya_Integration` to that administrator made the class pass 4 of 4 with no code change, which established the cause. The correction wrapped the test in `System.runAs` with a granted principal, matching its two siblings, and a fresh org then ran the full suite at 85 passing and 0 failing with nothing granted to the administrator.

Finding 63, high, raised after both hosted runs failed and closed at `d9787a1`: the unit could not pass the pinned gate while its test class used `@TestSetup`. The hosted log showed only `Verification failed; unrecognized exception details withheld`, because the pinned coverage checker throws a plain `Error`, which the harness does not classify and therefore suppresses, recording `failed-tests`. Reproducing the harness's own sequence locally, `sf project deploy start --source-dir force-app --wait 5` followed by `sf apex run test --test-level RunLocalTests --code-coverage --result-format json --wait 5` and then the pinned `apex-coverage.mjs`, showed the checker rejecting the report because `result.tests.length` was 84 while `summary.testsRan` was 85. This unit introduced the repository's first `@TestSetup`, and the platform counts that setup method in the summary but omits it from the detailed rows. Removing the annotation, calling the fixture builder first in each test and isolating the setup-object DML inside `System.runAs(new User(Id = UserInfo.getUserId()))` produced 84 rows against 84 and an accepted report at 701 of 715 executable lines, 98.04 percent. The corrective head was confirmed to be that same variant line for line, differing only by an explicit `private` modifier that Apex applies by default.

The verifier's earlier clearance had missed this because the Apex suite was run without the harness's flags and its coverage checker was never applied. The procedure is now to reproduce the harness sequence and run the pinned checker before clearing any Salesforce unit.

Orphan accounting across the unit: the superseded run 35898071269 created no scratch org, run 35910898641 created and successfully deleted its own, and all three verifier orgs were deleted and confirmed in the Dev Hub. No reconciliation was required at any point.

Hosted run 35914995417 attempt 1 at `d9787a1`: marker `{"schemaVersion":1,"role":"ci","runId":"35914995417-1","headSha":"d9787a1e0d7d09a5f1e32ec2f6b4dab0a7fa1f4c","startedAt":"2026-09-23T20:30:54.281Z","outcome":"passed","retryable":false}`, with `84 passed; 701/715 executable lines (98.04%)`, matching the verifier's reproduction exactly. Cleanup deleted one owned org; the Dev Hub shows `kusanya-ci-v1__35914995417-1__d9787a1e0d7d__f08c1f5447a1`, org `00DRt00000XWsYb`, Status Deleted with `ErrorCode` null and a matching `deleteScratchOrg` audit entry at 20:33:19 UTC, zero active orgs and a fully spent daily budget. All 525 log lines were clean of credential material, and all five required checks passed on the unchanged head.

Note 64, informational: the pinned coverage checker's equality rule is stricter than the property it protects and its message is withheld although it contains no provider data, which made a deterministic failure undiagnosable from the public log and cost two hosted attempts. A future reviewed harness change could compare against the detailed rows, or accept a summary count at least equal to them, and could surface the checker's own message. The constraint is now recorded in `salesforce/README.md`.

`PASS: PR #42 merged as 77bc353`, with squash tree `f65d61d` identical to the verified head.

Ledger: findings 62 and 63 are closed. **Note 24 is closed**: the ADR 0011 read policy is decided and documented, and its effective-access behaviour is proven in a real org with distinct principals over cross-owner data. Note 34 advances through definition loading but remains open for tenant OAuth selection, encrypted credential persistence and rotation, restricted-user target-object FLS proof and the refusing publisher. Note 36 remains open for Enketo, note 37 until the client-specific count-reduction rule is chosen and tested, and note 39 remains open. Notes 47, 49, 50, 53, 55, 56, 58, 59 and 64 are informational. Notes 25, 27 to 31 and 35 carry forward.
