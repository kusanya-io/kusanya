# ADR 0069: Prove the unexpected-exception classifier on a controlled live run

- Status: Accepted and live-proven; proof hook retired from the merge candidate
- Date: 2026-11-05
- Decider: Bill Owiti
- Brief sections: C8, C11

## Context

ADR 0006 and PR #133 added a bounded classifier for exceptions outside the
verification harness's three public error classes. Unit tests and mutations proved
that hostile error shapes could not invoke accessors or disclose their source
values. Healthy protected runs proved that the classifier did not disturb the
normal path. Neither proved that the hosted credentialed workflow could reach the
unexpected-exception branch and publish its bounded diagnostic and outcome marker.

Waiting for an organic failure would leave the evidence unbounded in time and
could repeat the diagnostic blackout that prompted note 148. Triggering the branch
after scratch allocation would spend capacity and create needless recovery risk. A
permanent diagnostic switch would add an unacceptable production control surface
to the trusted harness.

## Decision

Use one deliberately non-mergeable proof pull request followed by a separate clean
merge candidate.

The proof workflow supplied the exact value
`KUSANYA_LIVE_CLASSIFIER_PROBE=unexpected-error-v1` only to the verification step.
The trusted harness recognized it after run identity, input validation, Dev Hub
authentication and empty-journal creation, but before discovery, preflight,
scratch-org allocation or any Salesforce verification command. It threw a
message-free native `Error`. Every other supplied value failed closed as invalid
input without reflection.

The proof was bootstrapped in two commits: the first held the reviewed harness and
the second moved both immutable workflow pins to it and enabled the exact value.
Claude reviewed the head and pin before Bill approved the protected run. The proof
head was nonretryable and could not satisfy the required gate.

The clean merge candidate starts again from accepted `main`. It contains this
decision and the live evidence, but neither the hook nor its workflow value. Its
harness commit also contains every related test change; a later pin-only commit may
therefore change only the workflow while preserving exact scripts-tree equality
between the reviewed head and the pinned harness. A repository tripwire rejects
the proof pin and both proof literals.

Because the proof review established that workflow linting was manual rather than
CI-enforced, public CI now downloads actionlint 1.7.12 from its official release,
verifies the Linux amd64 archive against the published SHA-256 digest, and runs it
with the hosted runner's ShellCheck executable. The versions and digest are visible
in the public job log; no linter enters the product or credentialed runner.

## Live evidence

GitHub Actions run
[42083654271](https://github.com/kusanya-io/kusanya/actions/runs/42083654271)
on the reviewed proof head authenticated successfully and emitted exactly:

```text
Verification failed (unexpected-error); exception details withheld.
```

Its single result marker recorded `failed-infrastructure` and `retryable: false`
for the exact run and head. Logs contained no discovery, preflight, creation, Apex
or scratch-org command. Independent Dev Hub readings before and after remained at
three signup rows for the day, zero active orgs and zero tags for the run. The
always-running fallback cleanup executed for the first time and made zero
Salesforce calls against the empty journal. The proof consumed no scratch org.

## Alternatives considered

- Wait for an organic unexpected exception: rejected because it gives no bounded
  schedule and may again destroy the evidence needed to diagnose a burned head.
- Trigger after allocation: rejected because proving a log classifier does not
  justify consuming or recovering a scratch org.
- Keep a permanent switch: rejected because the credentialed harness must not ship
  a caller-controlled failure mechanism.
- Reuse the proof pull request for the clean head: rejected because its body and
  review correctly state that its head must never merge. A separate pull request
  keeps that historical assertion true.
- Keep actionlint manual: rejected because rare workflow changes have high impact
  and a pinned public check is cheap, noncredentialed evidence.

## Consequences

- The first live firing owed by ADR 0006 is discharged.
- The proof PR remains closed and unmerged as historical evidence.
- The merged tree may name the retired mechanism only in this historical ADR. The
  executable harness and workflow must contain neither proof literal nor proof pin.
- The final clean head still needs independent review and one ordinary healthy
  protected run before merge.
- This supplies operational evidence only. It makes no C10, phase-gate or product
  behavior claim.
