# ADR 0030: Safe superseded Salesforce verification cancellation

- Status: Proposed; implementation awaiting independent verification
- Date: 2026-09-25
- Brief sections: C8, C11 Phase 1, C12, C13; verification protocol
- Decision owner: Cobitech Solutions
- Amends: ADR 0006's pending-run replacement policy

## Context

The credentialed Apex job deliberately uses one repository-wide concurrency group
with `cancel-in-progress: false`. That protects an active scratch-org lifecycle but
also lets an older protected job that is merely waiting for environment approval
hold the group. A replacement head then remains pending. This required Bill to
cancel a zero-step stale run manually on PRs #42, #47 and #49.

Changing the concurrency expression to cancel automatically is too broad: GitHub
could interrupt an authenticated job after scratch allocation. Giving the
PR-controlled Salesforce workflow `actions: write` would also let untrusted head
code rewrite its own cancellation authority. The replacement must distinguish a
zero-step approval wait from every active or ambiguous state, while keeping the
Salesforce workflow, immutable harness pin, approval, retry budget and cleanup
policy unchanged.

## Decision

### Use a default-branch-owned cancellation workflow

Add a separate `pull_request_target` workflow triggered only by `synchronize` for
`main`. GitHub loads this workflow from the default branch. It checks out only the
event's exact base SHA with credentials disabled and only the `scripts` path. It
never checks out, imports or executes PR-head code and receives no Salesforce
secret or environment. Repository permissions default to none; its one job has
only `actions: write`, `contents: read` and `pull-requests: read`.

The workflow handles same-repository PRs only. Its trusted script validates the
repository, PR number, full new head SHA and default branch, then reads the live PR
and requires it to remain open, same-repository, on the same head and target.

### Cancel only positive zero-allocation evidence

Read the complete bounded list of waiting `pull_request` runs for
`salesforce-verify.yml`. A candidate must be older than the live head and match the
same repository and head branch. The candidate commit must be uniquely associated
by GitHub with this exact PR, repository, source branch and target branch.

Exactly one candidate may proceed. Its run must identify the Salesforce workflow,
the same-repository pull-request event, its exact head and attempt, and status
`waiting` with no conclusion. Its exact-attempt Jobs API response must contain
exactly one protected `Scratch org tests and 85 percent coverage` job. That job
must match the run, head and attempt; remain `waiting` with no conclusion; contain
zero steps; and have no runner. This is positive evidence that authentication and
scratch allocation never began.

Immediately before the cancellation request, reread the live PR, exact run,
commit-to-PR association and exact-attempt jobs and require the same proof again.
Only then call GitHub's run-cancellation endpoint. Output is a fixed success or
no-candidate sentence and contains no API response data.

GitHub offers no conditional cancel operation, so a theoretical race remains
between the last read and the cancellation request. The repeated reads minimize
that interval; the standing operator rule not to approve a superseded head remains
part of the control. The policy does not represent this as an atomic guarantee.

Zero candidates is a successful no-op. Multiple candidates, pagination drift,
missing or duplicate identities, changed state, incomplete data and all other
ambiguity fail closed without mutation. In particular, the policy never cancels:

- the current head or any same-head retry;
- `workflow_dispatch` or a run for another PR, repository or branch;
- queued, pending, in-progress or completed work;
- a job with any step or assigned runner; or
- an active scratch lifecycle.

The existing Apex job retains the repository-wide non-cancelling concurrency
group. Environment approval, exact-head guards, immutable harness pin
`1d0edc1818e1eda0c42f752aca19eb3ec9a15894`, per-day attempt budget, cleanup and
required gate are unchanged. Cancellation does not approve or rerun anything and
cannot make the cancelled head's gate pass.

## Alternatives considered

- Set `cancel-in-progress: true` on the Salesforce concurrency group: can interrupt
  an authenticated run and strand a scratch org.
- Give the PR workflow write access and cancel from its policy job: PR code controls
  that workflow, so this crosses the trust boundary.
- Cancel by branch, SHA or `waiting` status alone: insufficient proof of PR identity
  and zero allocation.
- Keep manual cancellation: safe when performed carefully, but it has repeatedly
  blocked successors and depends on an operator reconstructing the same evidence.
- Cancel all matching stale runs: hides an unexpected state; more than one requires
  manual investigation.

## Consequences and verification

The source PR can prove the trusted workflow shape and policy behavior with
injected API fixtures, but the new `pull_request_target` workflow does not run from
the PR that introduces it. Its first live cancellation can occur only after this
unit is reviewed and merged, on a later same-repository synchronize event. That
later run is operational evidence, not authority to weaken these guards.

Tests cover exact success with two independent state reads; no candidate; current
head; dispatch, active and completed states; foreign branch/repository/PR;
ambiguous and changing history; malformed identities; started jobs; assigned
runners; duplicate Apex jobs; and head drift before cancellation. The ordinary
Salesforce workflow tests continue to require global `cancel-in-progress: false`.

This unit changes no dependency, lockfile, Salesforce metadata, product code,
harness pin, retry budget or Salesforce secret boundary. It consumes no scratch
org locally. Its PR still requires the normal exact-head hosted gate and Claude's
explicit workflow/security review before Bill approves that gate.

## Revisit when

GitHub changes the Actions run/job states or API shapes, the protected job name or
workflow filename changes, more than one protected environment is introduced, or
the repository gains a separately reviewed trusted status publisher.
