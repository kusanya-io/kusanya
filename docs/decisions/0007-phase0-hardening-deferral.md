# ADR 0007: Limited deferral of verification hardening after Phase 0

- Status: Accepted by Bill; findings remain open until independently verified
- Date: 2026-09-11
- Brief sections: C8, C11 Phase 0, C13; verification protocol
- Decision owner: Cobitech Solutions
- Follow-up: https://github.com/kusanya-io/kusanya/issues/5
- Source review: https://github.com/kusanya-io/kusanya/pull/3#pullrequestreview-5171802883

## Context at the time of deferral

Claude cleared PR #3 head `8e1e2b7c984298c19ae61d1ddf5609c58a635d4c`
for Bill to approve run `34523564584` after daily scratch capacity became
available. Finding 10 was closed; finding 1 still needed hosted Apex evidence and
the three required checks on main. New findings 11-13 concern partial-rerun budget
enforcement, zero-step cancelled jobs, and timeout/cleanup reliability.

Claude explicitly allowed Bill to defer findings 11-13 to the first PR after
Phase 0. On 11 September Bill approved that limited deferral and asked that the
work not be forgotten. Issue #5 records the approval and acceptance checklist.

## Decision

Preserve the security-reviewed head and waiting run. Implement findings 11-13 in
the first builder PR after Phase 0, before Phase 1 product work. Deferral changes
sequencing only: it is not a fix, rejection, waiver, closure, or Phase 0 PASS.

- Finding 11: repeat the trusted history/budget check inside the Apex job after
  the head check and before authentication, including partial reruns and changes
  in UTC day while waiting for approval.
- Finding 12: completed zero-step skipped/cancelled Apex jobs consume no scratch
  allocation; cover the observed no-log shape and dispatch-history behavior.
- Finding 13: reserve a clear timeout margin for cleanup and add trusted always-run
  cleanup restricted to this exact CI role/run/attempt's positively owned tags.

Keep notes 14 and 15 visible in the same follow-up: use ShellCheck with actionlint
and improve rejected-creation classification without exposing raw provider output.
No deliberate quota-exhaustion test is authorized by this decision.

Claude subsequently added note 16 to issue #5: remove the incorrect rolling
24-hour next-slot estimate and correct ADR 0006 and the CI runbook. Until a reset
rule is independently confirmed, report next-slot time as unavailable and retain
the live capacity gate.

Neither agent approves, cancels or reruns the waiting run. Bill approves it only
when capacity is available. Stop for diagnosis if it fails; this deferral grants
no automatic or partial retry permission. Do not acquire a builder development
org until the CI and independent verifier Phase 0 runs finish.

This ADR was prepared locally while PR #3 remained frozen. Commit it with the
follow-up PR, not by changing the already approved head. The durable issue and PR
comments communicate Bill's decision immediately without triggering another run.

## Alternatives considered

- Fix all findings on PR #3 now: would change the head and invalidate its existing
  security clearance; Bill chose the explicitly permitted limited deferral.
- Defer without tracking or a deadline: rejected; issue #5 is the first follow-up
  and remains open until Claude verifies the changes.
- Treat the findings as closed: rejected; the technical defects remain present.

## Consequences and verification

The existing protections are not strengthened by this decision. Partial reruns
can bypass the current policy-job budget, zero-step cancellations can block later
attempts, and long waits can leave insufficient cleanup time. These risks require
the temporary operating restrictions above and the prompt follow-up work.

The follow-up must run synthetic regression tests, formatting, scaffold checks and
actionlint with ShellCheck enabled. Claude must explicitly review changes to the
workflow, guards, pin and credential-adjacent dependencies before Bill approves a
new protected run. C10 tests claimed by this sequencing ADR: none.

At the time of deferral, Phase 0 remained on hold pending the hosted Apex run,
coverage, scratch cleanup, independent verification and required checks under
the verification protocol.
The builder never merges its own PR or writes the verifier's PASS.

## Follow-up after the phase gate

Claude recorded Phase 0 PASS in
[review 5177252674](https://github.com/kusanya-io/kusanya/pull/3#pullrequestreview-5177252674).
Bill merged PR #3 on 11 September as `f579da94f4e49b6d5a1d33dc0447f9c316268447`.
This ADR is committed in the first builder follow-up, as required by the deferral.
ADR 0006 records the implementation choices for repeated admission checks, bounded
execution, a durable run-intent journal and exact-run recovery. Their tests are
synthetic until a new exact-head hosted run is explicitly security-reviewed and
approved by Bill. Issue #5 remains open until Claude verifies the fixes. No Phase 1
product work or namespace claim is included in this follow-up.

## Revisit when

The current run fails, Bill changes the sequencing decision, or the first
post-Phase-0 hardening PR is ready for Claude's verification. Do not begin Phase 1
product work with this follow-up forgotten or silently waived.
