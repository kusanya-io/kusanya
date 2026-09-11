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
