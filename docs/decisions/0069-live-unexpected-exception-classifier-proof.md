# ADR 0069: Prove the unexpected-exception classifier on a controlled live run

- Status: Accepted for controlled execution; the proof hook must not be merged
- Date: 2026-11-05
- Decider: Bill Owiti
- Brief sections: C8, C11

## Context

ADR 0006 and PR #133 added a bounded classifier for exceptions outside the
verification harness's three public error classes. Unit tests and mutations prove
that hostile error shapes cannot invoke accessors or disclose their source values,
while healthy protected runs prove that the classifier does not disturb the normal
path. Neither form of evidence proves that the hosted credentialed workflow can
reach the unexpected-exception branch and publish its bounded diagnostic and
outcome marker.

Waiting for an organic failure would leave the evidence unbounded in time and
would repeat the diagnostic blackout that prompted note 148. Triggering the branch
after scratch-org allocation would spend capacity and create needless recovery
risk. A permanent diagnostic switch would add an unacceptable production control
surface to the trusted harness.

## Decision

Use one deliberately non-mergeable proof head followed by one clean merge
candidate.

The proof head adds the exact environment value
`KUSANYA_LIVE_CLASSIFIER_PROBE=unexpected-error-v1` to the protected verification
step. The trusted harness recognizes only that exact value after run identity,
input and Dev Hub authentication have succeeded and after the empty cleanup journal
has been created, but before discovery, preflight, scratch-org allocation or any
Salesforce verification command. It throws a message-free native `Error`, which
must produce only:

```text
Verification failed (unexpected-error); exception details withheld.
```

The outcome marker must be `failed-infrastructure` with `retryable: false`. The
always-running finalizer must accept the empty journal without making an org call.
No scratch org is created and the required gate remains red. An absent probe takes
the ordinary path; every other supplied value is rejected as invalid input without
echoing it.

The proof head changes the harness first, then pins the workflow to that reviewed
commit and enables the exact probe. Claude reviews the head and immutable pin before
Bill approves its protected run. The proof head is never merged.

After the live log and marker are independently verified, a clean commit removes
the workflow value and harness hook. A separate pin-only commit advances both
workflow pins to that clean commit. Claude reviews the resulting head before Bill
approves one ordinary healthy run. Only that clean, green head may merge.

## Alternatives considered

- Wait for an organic unexpected exception: rejected because it gives no bounded
  schedule and may again destroy the evidence needed to diagnose a burned head.
- Trigger after allocation: rejected because proving a log classifier does not
  justify consuming or recovering a scratch org.
- Keep a permanent switch: rejected because the credentialed harness must not ship
  a caller-controlled failure mechanism.
- Treat unit tests as sufficient: rejected because the outstanding claim is the
  first firing in the hosted workflow, not local classifier behaviour.

## Consequences

- The controlled proof needs its own review and Bill approval but consumes no
  scratch-org allocation.
- The final clean head needs a second review and normal approval and consumes the
  ordinary single verification org.
- The immutable-pin bootstrap makes the reviewed harness bytes the executed bytes
  on both heads.
- The proof supplies operational evidence only. It makes no C10, phase-gate or
  product-behaviour claim.
- A merged tree containing the proof hook or workflow value violates this decision.
