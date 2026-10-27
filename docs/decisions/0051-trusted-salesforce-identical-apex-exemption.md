# ADR 0051: Trusted Salesforce-identical Apex exemption

- Status: Proposed; implementation awaiting independent verification
- Date: 2026-10-27
- Brief sections: C8, C11 Phase 1, C13; verification protocol
- Decision owner: Bill Owiti / Cobitech Solutions
- Extends: ADRs 0004 and 0006

## Context

Fifteen consecutive service-focused units produced the same hosted Salesforce result:
101 tests passed and 1428 of 1473 executable lines were covered. In each unit the
complete `salesforce/` tree was byte-identical to accepted `main`, so the fresh
scratch org, protected environment approval and cleanup audit supplied a repeated
negative control rather than evidence about the changed service code. That fixed
per-PR cost limits throughput under the Dev Hub's daily allocation.

The existing documentation-only exemption proves that the required Salesforce gate
can stay present while a trusted classifier explicitly decides that Apex is not
evidence for a particular change. Bill approved extending that pattern to ordinary
application changes whose Salesforce tree is cryptographically identical to
accepted `main`. Claude recommended keeping the policy change itself small and
reviewing it as a new trust boundary.

## Decision

### Compare immutable directory trees, not PR assertions

The immutable pinned `apex-pr-policy.mjs` remains the only producer of an exemption.
It reads the repository's live default-branch ref, the open same-repository PR and
the exact reviewed head through authenticated, read-only GitHub APIs. The PR's base
SHA must equal that live accepted-main commit. The classifier reads the complete
file list and complete, untruncated recursive Git trees for both commits, then reads
the default-branch ref and PR again before returning.

The base and reviewed entries named exactly `salesforce` must both be ordinary Git
directory trees (`040000`, type `tree`) with the same full tree SHA. Git tree
identity covers names, modes, object identities and every descendant byte. The
classifier additionally refuses the exemption if either side of any changed or
renamed path is `salesforce` or begins `salesforce/`. A PR body, label, workflow
input, changed-file claim or artifact cannot assert equivalence.

The positive decision is `salesforce-identical-exemption` and carries the exact
reviewed head, accepted-main SHA and Salesforce tree SHA. The unconditional gate
rechecks the live PR head, base branch, base commit and accepted-main ref before
accepting the decision, requires the Apex job to be intentionally skipped and prints all three identities with the fixed
label `Apex not run—trusted salesforce tree identical to accepted main`.

### Preserve the verification boundary

Any `.github/` or `scripts/` change requires `full-apex` even when Salesforce is
unchanged. This prevents a PR from changing the workflow, classifier, harness,
budget, coverage calculation or its tests and simultaneously benefiting from the
new exemption. This ADR's own implementation therefore requires independent source
review, a new immutable harness pin and one protected hosted Apex run before merge.

Any changed Salesforce path, different/missing/non-directory Salesforce tree,
fork, stale head, nondefault base, moving accepted-main ref, incomplete pagination,
truncated tree, malformed identity or unknown event fails closed. Depending on how
much trusted identity was established, that produces `full-apex` or a failed policy
job; neither can make the gate green without successful Apex.

Manual `workflow_dispatch` always produces `full-apex`. A phase gate or PR claiming
any C10 acceptance test still needs a real exact-head Apex run and may use the
reviewed manual-dispatch path when its automatic PR check was exempt. Neither the
documentation exemption nor the Salesforce-identical exemption is Apex evidence,
coverage evidence, phase-gate evidence or proof of namespaced behaviour.

### Retain required checks and human review

`Salesforce verification gate` remains a required main-branch check. A trusted
exemption satisfies that check only for the exact head and accepted base described
above; policy failure, an unknown decision, a non-skipped exempt Apex job or a
skipped/cancelled/failed `full-apex` job still fails it. GitHub's strict required
checks continue to require a fresh result after accepted `main` advances.

The workflow remains a tripwire rather than an authorization boundary because it
is defined in the PR. Any workflow, guard, pin or trusted-harness change still
requires Claude's explicit review before Bill approves credentialed execution.

## Consequences and verification

Most service/mobile/documentation product units can now avoid a scratch org and
protected Salesforce approval while retaining an explicit, auditable negative
control. Salesforce metadata, CI/harness work, phase gates and C10 claims retain the
existing full path. This removes repeated quota and approval overhead without
weakening the points where new Salesforce evidence is material.

Synthetic tests mutate each side of the accepted/head identities, file pagination,
tree completeness, Salesforce path and subtree SHA. They prove that one changed
Salesforce path or a hidden subtree difference restores full Apex; workflow/script
changes and manual dispatch do the same. Inline workflow tests exercise the actual
gate and refuse absent, malformed, failed, cancelled or contradictory evidence.

This unit changes only verification policy, workflow tests and documentation. It
claims no C10 acceptance test and no Phase 1 product capability.

## Revisit when

GitHub changes its Git tree or pull-request API contract, the repository moves
Salesforce source outside `salesforce/`, a phase-gate workflow is automated, the
required-check strictness changes, or the trusted harness is repinned.
