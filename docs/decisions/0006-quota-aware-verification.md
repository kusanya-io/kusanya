# ADR 0006: Quota-aware development and independent verification

- Status: Approved by Bill; Phase 0 passed; issue #5 amendments await Claude verification
- Date: 2026-09-10
- Brief sections: C8, C10, C11 Phase 0, C12, C13; verification protocol
- Decision owner: Cobitech Solutions
- Amends: ADR 0005's allocation, concurrency and every-PR Apex policy

## Context and approval

The shared Developer Edition Dev Hub exhausted its six daily creations on
10 September: one setup smoke test, three builder runs and two verifier runs.
All were deleted, but deletion restored active capacity,
not daily capacity. Hosted run `34499943255` authenticated successfully and then
failed before scratch creation. No hosted Apex evidence resulted.

Correction (issue #5 note 16, 11 September): the daily limit is **not** a rolling
24-hour allocation. At 09:00 UTC the hub reported six of six remaining while the
previous six creations were less than 24 hours old. The actual reset time is not
confirmed. Neither this ADR nor the tooling assumes midnight Pacific or another
reset time; live remaining counts are authoritative and next-slot time is unavailable.

Claude's [design review 5171295026](https://github.com/kusanya-io/kusanya/pull/3#pullrequestreview-5171295026)
recommended adjustments A1–A11 and identified finding 10. Bill explicitly approved
those adjustments, a dedicated CI Dev Hub and the strict documentation-only
exemption in the builder conversation on 10 September. This records a decision,
not a claim that the new Dev Hub or its credential has been provisioned.

## Decision

### Development is not verification (A1–A3, A11)

Run formatting, service tests and synthetic tooling tests before spending scratch
capacity. Maintain at most one reusable, builder-only scratch org per development
Dev Hub, expiring within seven days. Repeated development work uses that org, not
the fresh verification harness. It has a fixed ownership marker, reserved alias,
local ownership receipt and explicit lifecycle commands. Never deploy product
source into the Dev Hub itself or a customer org.

The development tool uses only explicitly selected local builder authentication;
it refuses CI execution and the CI secret. It prints development-only output, not
the verification harness's Apex evidence format. Nothing from the reused org is
submitted as verification evidence. Its release operation may remove only an org
whose ownership is positively verified. Local locking does not provide a
cross-machine distributed lock: only the designated builder checkout operates it.

The builder's Apex evidence is the hosted CI run on the exact PR head, not another
fresh local builder run. Claude independently uses its own commands and one fresh
org per final Salesforce-relevant head. Security/design reviews and intermediate
heads consume no scratch orgs. Fresh verification has no existing-target input:
the harness and CI always create run-unique orgs and never adopt the development
org. Tests must prove rejection of target-org inputs.

### Separate capacity and controlled scheduling (A4–A10)

Provision a dedicated CI-only Developer Edition Dev Hub and privately configure
only its authorization in the protected `salesforce-ci` environment. Builder and
verifier credentials stay outside CI. Provisioning/authentication require their
own explicit operator authorization; this ADR does not create accounts or move a
secret. Namespace registration and multi-hub linking remain a prerequisite to
namespaced Phase 1 objects and must be checked in the namespace ADR.

Serialize the credentialed Apex job across all PRs sharing the CI hub, not merely
per PR. Do not cancel an active scratch lifecycle. GitHub's pending-run replacement
can discard a run before it consumes a slot; a discarded/skipped job is not a
passing Apex result. Bill approves only the latest exact head marked READY after
review. Keep the automatic PR trigger and human environment approval.

Run the complete applicable suite in one fresh org, or one fresh pair when test 14
requires two tenants. Never allocate an org per test. Pair acquisition requires
two active and two daily slots; if the second creation fails, immediately clean
the first. Clean up a CI pair before a verifier pair uses a shared three-slot hub.
The Phase 0 runner still tests its one-org scaffold: pair lifecycle fixtures are
not implementation or evidence of C10 test 14.

Permit at most one explicitly requested infrastructure retry per head per UTC day.
Never automatically retry. A failing test or insufficient coverage requires a fix
and a new head, not a rerun. Successful evidence is not rerun just to obtain another
pass. Unknown failures and failed cleanup require investigation, not an automatic
classification as transient. Known capacity blocks can be retried after capacity
returns, within the same retry budget and only after another preflight. Read
complete GitHub attempt history and the exact run/head's sanitized harness outcome;
missing or contradictory history is not permission to retry. A quota check is
advisory, never a reservation against other operators.
Count the UTC day of the trusted harness's actual start timestamp, not GitHub's
workflow or job start metadata (both can include waiting for approval). Manual
dispatch evidence must bind its reviewed head from the trusted
subject log, not confuse it with main's dispatch SHA. Ambiguous legacy logs and
history beyond the bounded complete reader require investigation, not exemption.

Issue #5 amendment: repeat the immutable budget reader inside the Apex job after
its exact-head recheck and before authentication, using its actual admission UTC
day. The early policy job remains a fast check, not authorization for a later
partial rerun or next-day approval. The Apex job receives only read permissions
for contents, pull requests and Actions; its GitHub token remains step-scoped.
Completed, identity-validated zero-step skipped/cancelled Apex jobs consume no
allocation and need no unavailable log. Executed, incomplete or ambiguous jobs
are not covered by that exemption, including manual dispatches.

Until CI has its separate hub, coordinate live available slots between CI and
Claude, reserving room for explicitly authorized infrastructure recovery. The
original 11 September slot estimates were withdrawn by note 16. Phase 0 CI and
independent verification have finished; no development org is created merely to
exercise this hardening PR. Recheck live limits before any authorized allocation.

### Safe diagnostics and cleanup

Read remaining active/daily allocations before creating anything. On insufficient
capacity, report `BLOCKED` and exit 75, naming the limiting allocation, maximum,
remaining count, required count and next daily slot as unavailable. Creation
timestamps do not establish the daily reset. Do not add a forecast until an
independently confirmed reset rule is recorded in an ADR. The preflight does not
need a creation-history query to read live limits. Malformed limits, failed queries and unknown
errors fail closed. Never print raw Salesforce output, usernames or authorization.

`BLOCKED` fails the required gate. It never becomes a successful skip and never
falls back to an existing org. A recognized creation-time quota error follows the
same diagnostic path, since capacity can change after preflight.

Recognized creation rejection is distinct from a pending/unknown request or cleanup
failure. A terminal provider rejection with a confirmed absent exact request, or
a terminal Error record explicitly showing no org, is nonretryable
`failed-creation-rejected`. Narrowly recognized quota rejection remains `BLOCKED`.
Unknown errors, missing timeout records and pending requests require reconciliation;
absence alone never proves rejection. Sanitized codes omit raw provider messages.
No deliberate quota exhaustion is permitted to test this classification.

Tag disposable orgs with role, run ID, short head SHA and a unique suffix. After a
creation timeout, reconcile the exact job ID or ownership tag before another
creation. Delete only positively owned orgs. A janitor requires both its own role's
tag and authoritative evidence that that run has ended; unknown, active or foreign
runs are not deletion targets. Cleanup failures fail verification and require
operator attention. Never cache authentication as a CI artifact.
The Phase 0 janitor is an injected, default-dry-run lifecycle helper, not an
automatic scheduler or complete administrative command. Its caller must establish
authoritative ended-run evidence; pending unknown creations require private
operator reconciliation before new allocation. This operational gap is explicit.

### Bounded verification and current-attempt recovery (issue #5)

Keep the 45-minute Apex job, with explicit step deadlines totalling 40 minutes and
five minutes of job slack. Verification has 20 minutes, fallback cleanup five, and
logout one. Each create/deploy/test CLI wait is five minutes. The CLI adapter also
enforces six-minute direct-process timeouts for those stages and 30 seconds for
reads and deletes. The hosted Linux job runs `sf` directly; this does not promise
termination of every descendant or a remote Salesforce request. In particular,
Windows uses a `cmd.exe` wrapper and cannot claim a process-tree kill guarantee.

The primary harness still cleans up in `finally`. Before creation it durably
records each exact role/run-attempt/full-head/tag intent in a small, private JSON
file at the fixed runner-temp path `kusanya-scratch-intents.json`. Exclusive initial
creation rejects stale files; fsync and atomic replacement preserve an earlier
valid intent if interrupted. The journal contains no credentials, org usernames,
submission data or raw CLI output and is never cached or uploaded.

A separate pinned `cleanup-salesforce.mjs` step uses `always()` after authenticated
verification failure/cancellation only, before logout. It accepts no target-org
input. It binds the CI identity to GitHub's run ID and attempt, validates the complete
journal identity and tag allowlist, then rechecks each exact remote ownership record
and active-org ID before deleting. It cannot discover and sweep another run, role
or attempt. An already deleted org is a no-op; an absent request is safe only with
an explicitly recorded, confirmed rejection. Missing/malformed journals, pending
or ambiguous requests, and failed deletions fail the job. Recovery never turns
failed tests or an interrupted run into a pass.

Finding 17 amendment: skip the fallback when verification succeeded. Success
already requires primary cleanup in `finally`; an additional read can introduce
an eventually-consistent or transient failure after the passed marker and create
a contradiction in retry history. Preserve the primary success evidence without
this redundant read. The fallback remains mandatory after failure/cancellation.

Note 18 amendment: failure to initialize the journal precedes allocation by this
invocation. Label it `JOURNAL_UNAVAILABLE` and report nonretryable infrastructure
failure, not failed cleanup. Persistence failures during acquisition and errors
reading the recovery journal remain reconciliation failures. No retry is granted
and no potentially stale ownership evidence is discarded.

This is a current-attempt finalizer, not the ended-run janitor: the workflow itself
establishes the verification step ended and the job is still alive to clean up.
It does not falsely mark a running job completed. Runner loss or force cancellation
can prevent any finalizer; private ownership-based reconciliation is still required
then. ShellCheck-enabled actionlint and synthetic interruption fixtures verify the
implementation before Claude reviews it; only a later approved hosted run can
establish live execution evidence for the changed harness.

### Narrow documentation-only exception to C13

Bill approved a deviation from C13's acceptance-suite-on-every-PR wording: an
explicitly classified, documentation-only PR can complete its required check with
`Apex not run—approved documentation-only exemption`. This is not measured Apex
evidence and cannot close a phase gate that requires actual Apex execution.

Use a positive allowlist: root `README.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`
and ordinary Markdown under `docs/`. Exclude the brief, verification protocol, CI
runbook, threat model and all ADRs from that allowlist. These policy changes still
require Apex and explicit verifier review. Code, service/mobile changes, workflows,
scripts, manifests/lockfiles, runtime configuration, API contracts, unknown paths,
binary files and non-regular file modes are never exempt.

Classify the complete PR diff at the exact head, checking old and new paths for
renames/deletions and both sides' file modes/content. Verify pagination and reject
incomplete or ambiguous evidence. A docs follow-up commit cannot hide code changes
earlier in the same PR. Any uncertainty requires full verification. PR #3 is not
documentation-only. Claude will update its verification protocol to reflect the
approved policy through the verifier-owned review/log PR.

### Finding 10: the check is a tripwire, not a security boundary

`Salesforce verification gate` is defined in PR-controlled YAML and runs without
environment approval. A PR can change it to report success without running Apex.
Requiring this check detects ordinary failures; it does not make that YAML trusted.
With one GitHub account holding all roles, a green check, CODEOWNERS or the
environment reviewer identity cannot prove independent review.

Any change to the gate job, triggers, guards, harness pin,
`scripts/verify-salesforce.mjs`, `scripts/apex-coverage.mjs` or their policy,
allocation, client and cleanup dependencies **blocks merge unless Claude explicitly
reviewed it**. The same applies to exemption and retry logic. Bill must inspect the
exact reviewed head before approval and merging. Claude's PASS must cite the actual
Apex run ID and confirm that Apex executed on that exact head, with coverage and
cleanup evidence; a documentation exemption must instead be named explicitly.
The builder never approves its own run, publishes a verifier PASS or merges its PR.

Harness updates are proposed as immutable source pins and require independent
security review before their first credentialed execution. Public fixture tests
can run before that review; they do not confer trust or prove hosted behavior.

## Alternatives considered

- Repeatedly replace Dev Hubs: adds capacity without controlling waste or ownership.
- Reuse the builder org as merge evidence: loses clean-state and independent checks.
- Disable Apex or turn quota blocks into passing skips: hides missing verification.
- Exempt everything outside Salesforce source: misses service, contract and tooling
  changes that can affect acceptance tests; the positive allowlist is narrower.
- Buy capacity immediately: not authorized or needed to implement this discipline;
  sustained demand can still require a separately approved capacity decision.

## Consequences and verification

Ordinary final heads need CI plus independent verifier capacity; test-14 heads need
two orgs for each. Reuse reduces development churn but does not remove allocation
limits. Provider outages and failed cleanup remain real blockers. The approved
dedicated CI hub and main's required checks must be verified as operator settings.

Unit tests exercise policy, preflight, ownership, lifecycle failures and input
rejection using synthetic clients. Actual fresh creation, deployment, Apex coverage,
timeout recovery and cleanup require reviewed hosted evidence when capacity is
available. No C10 product test is claimed by this tooling change.

## Revisit when

Test 14 is implemented, namespace/package ownership is selected, the team adds
another builder, retries exhaust capacity, GitHub identities are separated, or a
trusted external required-workflow/check mechanism becomes available.
