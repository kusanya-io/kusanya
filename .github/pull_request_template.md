Describe the concrete change and behavior a reviewer should verify.

Brief sections implemented:

Acceptance tests claimed (brief C10): list each number and evidence, or `none — Phase 0 scaffold`.

Validation performed: exact commands, results, CI links, tested commit and coverage.
Separate local evidence from CI evidence and identify unrun checks.

Decisions recorded: link each ADR added or changed.

Known gaps and deviations from the brief:

Security/data review: changes to credentials, tenant isolation, collector access or
retention; `none` when unchanged. Never paste credentials or production payloads.

Verifier focus: the riskiest parts and reproduction steps.

The builder must not merge this PR. Follow `docs/verification.md` for the hand-off.
