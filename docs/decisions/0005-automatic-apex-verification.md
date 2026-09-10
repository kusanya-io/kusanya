# ADR 0005: Automatic Apex verification with an approval gate

- Status: Accepted by Bill; implementation pending independent verification and maintainer setup
- Date: 2026-09-10
- Brief sections: C8, C11 Phase 0, C12, C13
- Decision owner: Cobitech Solutions
- Supersedes: ADR 0004's manual-only trigger and default-branch harness selection

## Context

Claude's PR #3 finding 1 identified that manual-only Apex testing did not meet the
automatic PR gate. Bill explicitly approved the guarded same-repository PR trigger,
protected environment, retained manual dispatch and maintainer configuration in the
builder conversation on 2026-09-10. That approval is also recorded in the reply to
[finding 1](https://github.com/kusanya-io/kusanya/pull/3#discussion_r3979834440).

Only maintainers can push repository branches, and GitHub does not provide ordinary
fork PR runs with repository secrets. A same-repository guard is useful, but not
sufficient: the PR can also modify its workflow. The environment approver must
inspect that workflow and the exact source SHA before releasing the Dev Hub secret.

## Decision

Trigger Apex verification on PR open, reopen, synchronization and readiness for
review, targeting main. The credentialed job runs only for same-repository PRs or
explicit manual dispatch. Keep `salesforce-ci` approval, read-only GitHub permissions
and GitHub-hosted runners. Never use `pull_request_target`.

Pin the scratch harness to immutable commit
`7974e25e8fa5855ca015bf01123282b744367f2e`, inspected during Claude's first review.
Its scratch/coverage scripts are unchanged from the later reviewed `5e22782` head.
Check out PR Salesforce metadata separately and never execute PR scripts or install
PR npm packages in the credentialed job. This pin permits the first PR to be tested
without merging it to bootstrap the harness. Future harness upgrades require an
explicitly reviewed pin change; changes in a PR do not silently replace the runner.

Validate the live PR number, open state, source repository, target branch and exact
head. Check the actual checkout and live head again before authentication; reject
a head changed during testing. Serialize runs per PR without cancelling an active
scratch lifecycle. Keep exact-line >=85% coverage and cleanup checks.

Require `Salesforce verification gate`, an always-running job that fails unless the
Apex job succeeded. Do not require the conditionally skipped Apex job alone: GitHub
treats skipped jobs as successful required checks.

Retain dispatch from main for explicitly reviewed same-repository source. Fork
contributions must be reviewed and staged in a same-repository PR; their automatic
credentialed job is skipped and their gate fails. A manual run on main is separate
evidence, not a status attached to a fork head. Direct fork merge support through
trusted status publication is deferred rather than adding write-token privileges.

## Alternatives considered

Manual-only testing leaves the C11/C13 gap. Trusting all PR executable code or using
`pull_request_target` broadens credential exposure. Requiring a skipped job falsely
signals verification. Loading the harness only from main would unnecessarily block
this first PR even though an immutable, previously inspected harness is available.

## Consequences and verification

Automatic triggering still requires a human environment approval. The approver must
review YAML as well as source and must not approve a stale run. Missing secrets or
an unconfigured/denied environment do not count as passing Apex tests. Environment
rules must permit main and `refs/pull/*/merge`; a main-only rule blocks PR runs.

Node tests execute the actual workflow shell guards against synthetic GitHub/Git
responses, including forks, stale SHA, invalid input and skipped-job cases. These
are policy regressions, not real Apex evidence. Hosted scratch execution and the
maintainer's required-check settings must also be verified before the phase passes.
The builder never approves its own environment run, publishes a gate verdict,
changes main or merges a PR to get past missing configuration.

## Revisit when

The trusted harness changes, direct fork merging is needed, merge queues are
introduced, or the repository's maintainers/credential trust boundary changes.

## References

- [GitHub environment protection and secret access](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
- [GitHub skipped-job and required-check behavior](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)
