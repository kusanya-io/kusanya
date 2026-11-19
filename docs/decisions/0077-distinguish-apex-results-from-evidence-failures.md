# ADR 0077: Distinguish Apex results from evidence failures

- Status: Proposed for Bill and verifier review
- Date: 2026-11-19
- Brief sections: C8, C11 Phase 0 verification foundation, C13
- Decision owner: Cobitech Solutions

## Context

The protected harness historically set one `testing` Boolean immediately before
invoking `sf apex run test`. Its catch block then labelled every later exception
`failed-tests`, including exceptions raised after the CLI had returned a report in
which every Apex test passed. Because `failed-tests` is permanently nonretryable,
two infrastructure-shaped report refusals burned reviewed heads even though fresh
orgs later reproduced passing suites at those exact heads. PR #160's first hosted
run was the second occurrence.

The harness already holds enough bounded structure to distinguish the cases. A
real suite failure is reported by the CLI as a status-100 envelope with a failed
summary, or by the returned summary/detail rows. The coverage checker separately
knows whether executable-line evidence is incomplete or the measured ratio is
actually below the required 85 percent.

## Decision

Replace the positional Boolean with typed results at both boundaries:

- `SalesforceCommandError.apexTestsFailed` is true only for the exact
  `apex-tests` stage, a top-level status of 100 and a summary whose outcome is
  `Failed` or whose integer failing count is positive. It retains no report,
  message, class, method, org identifier or provider text.
- `ApexVerificationError` exposes one closed internal kind:
  `test-failure`, `coverage-below-threshold`, `evidence-incomplete` or
  `configuration-invalid`.
- Reported test failures and measured coverage below 85 percent map to terminal
  `failed-tests`, as before.
- A successful suite followed by missing, contradictory, malformed or incomplete
  coverage evidence maps to `failed-infrastructure`, `retryable: true`. It still
  fails the required gate and can receive only the existing one same-head
  infrastructure retry per UTC day.
- Invalid local source inventory and Apex command failures without positive suite
  failure evidence remain `failed-infrastructure`, `retryable: false`. This unit
  does not add the Apex stage to the Salesforce client's transient-stage allowlist.
- Owned-org cleanup still runs in `finally`. Any cleanup failure supersedes the
  earlier result as nonretryable `failed-cleanup`.

No raw Salesforce output is logged. Existing bounded exception classification and
result-marker formats are unchanged.

## Alternatives considered

- Move `testing = true` to a narrower position: rejected because position still
  cannot distinguish a reported test failure, an incomplete successful report and
  a genuine below-threshold result.
- Make every post-test exception retryable: rejected because an actual failing
  suite and coverage below 85 percent require a changed head, not another org.
- Keep all evidence failures nonretryable: rejected because it repeats the two
  observed permanently burned heads even when the suite passed.
- Make Apex transport timeouts retryable in the same unit: rejected because that
  widens the Salesforce client's stage policy and needs separate evidence.

## Consequences and verification

Fixture tests cover the exact status-100 failure signal, near-miss statuses and
transport errors without exposing their payloads. Coverage tests assert every
closed error kind. Wrapper tests prove that a reported failure and sub-85 coverage
remain terminal, incomplete post-pass evidence becomes retryable infrastructure,
generic Apex command failure remains nonretryable infrastructure, and cleanup still
supersedes all earlier states.

Mutation checks must show that restoring the positional `testing` branch makes the
new post-pass test fail, and that relabelling either real test failure or sub-85
coverage as evidence makes its terminal assertion fail. The final harness commit is
reviewed before a second commit changes only the two immutable workflow pins. The
first credentialed run must reproduce the current healthy control of 121 tests and
2,719 of 2,914 executable lines at 93.31 percent; a healthy run does not claim to
live-prove the new failure branch.

No C10 acceptance test or Phase 2 gate is claimed.

## Revisit when

The CLI changes its Apex failure envelope, the report schema changes, a protected
run first exercises the new post-pass retry path, or the team separately reviews
retry authority for Apex-stage transport failures.
