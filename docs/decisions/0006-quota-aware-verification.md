# ADR 0006: Quota-aware development and independent verification

- Status: Approved by Bill; implementation and phase gate await Claude verification
- Date: 2026-09-10
- Brief sections: C8, C10, C11 Phase 0, C12, C13; verification protocol
- Decision owner: Cobitech Solutions
- Amends: ADR 0005's allocation, concurrency and every-PR Apex policy

## Context and approval

The shared Developer Edition Dev Hub exhausted its six successful creations in a
rolling 24-hour window on 10 September: one setup smoke test, three builder runs
and two verifier runs. All were deleted, but deletion restored active capacity,
not daily capacity. Hosted run `34499943255` authenticated successfully and then
failed before scratch creation. No hosted Apex evidence resulted.

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

Until CI has its separate hub, reserve the first returning 11 September slot
(11:33 UTC) for Phase 0 CI and the second (13:20 UTC) for Claude. Hold the next two
for infrastructure recovery. No builder org is created before those verification
runs finish. Recheck actual limits before relying on the estimated times.

### Safe diagnostics and cleanup

Read remaining active/daily allocations before creating anything. On insufficient
capacity, report `BLOCKED` and exit 75, naming the limiting allocation, maximum,
remaining count, required count and estimated next daily slot. Compute slot times
from creation history plus 24 hours; explicitly report unavailable estimates when
history cannot establish a time. Malformed limits, failed queries and unknown
errors fail closed. Never print raw Salesforce output, usernames or authorization.

`BLOCKED` fails the required gate. It never becomes a successful skip and never
falls back to an existing org. A recognized creation-time quota error follows the
same diagnostic path, since capacity can change after preflight.

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
