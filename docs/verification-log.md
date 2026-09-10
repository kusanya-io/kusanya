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
