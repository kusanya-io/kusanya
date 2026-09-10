# Verification log

Every review and gate verdict, newest first. Written by the verifier only. The protocol is in `docs/verification.md`.

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
