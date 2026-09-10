# Verification protocol

Kusanya is built by a coding agent and verified by a second, independent agent working from this protocol. The builder never marks its own work as done. This file is the contract between the two.

## Ground rules

1. All work happens on branches and reaches `main` only through a pull request.
2. Every pull request names the brief section it implements and the acceptance tests from `docs/brief.md` section C10 it claims to satisfy.
3. The verifier checks the claim against the brief and against the running code, not against the pull request description.
4. A phase is closed only when the verifier has run every acceptance test listed for that phase in section C11 and recorded the result in `docs/verification-log.md`.
5. Findings go back as pull request review comments. The builder answers each one with a change or a reasoned rejection; an unanswered finding blocks merge.

## What the verifier does on every pull request

- Pull the branch; read the whole diff against the relevant brief sections.
- Run the Salesforce package tests in a fresh scratch org from the Dev Hub; Apex coverage must be 85 percent or better and every test must pass.
- Run the service test suite locally in the container.
- Run every acceptance test the pull request claims, from a clean state.
- Try to break it with the real forms in `seed/`: the 144-question observation, the HWWS observation with mixed once-only questions and repeats, the interview with exactly five repeat instances.
- Check the four things the brief says nobody should rediscover: the collector stamp on every mapped record, no Salesforce user or sharing created for a collector, API-call batching under the stated budget, and tenant isolation.
- Read every new object and field for a description, every Apex class for a responsibility header, and every decision for an ADR.
- Confirm nothing stores collector credentials, Salesforce tokens or submission data outside the customer's org and the service database, and that tokens are encrypted at rest.

## What the verifier does at a phase gate

- Runs the full acceptance list for the phase, plus every earlier phase's list, so nothing has regressed.
- Reviews the ADRs written during the phase against the brief's "decide" and "ask" rules.
- Publishes a short gate report in `docs/verification-log.md`: date, commit, tests run, results, open findings, and a pass or hold verdict.

## What the builder must provide for a review to start

- A green CI run.
- Instructions to reproduce the acceptance tests the pull request claims, if they differ from the standard runbook.
- Updated docs for anything the change touches: data model, API contract, administrator guide.

## Severity of findings

- **Blocker:** a brief requirement is violated, a test claimed passing does not pass, data can leak between tenants, or a design needs a Salesforce licence per collector.
- **Must fix before phase gate:** a defect the brief lists in C3 has been reintroduced, a governor limit is hit on the stated volumes, or a security check in C8 is missing.
- **Should fix:** anything else that would embarrass the product in front of a customer.
- **Note:** style and naming.

## Hand-off between builder and verifier

The builder and the verifier do not share a session. Bill relays between them. So the builder must make every hand-off explicit:

1. When a pull request is ready, the builder ends its message to Bill with one line in this exact form, so it is never missed:
   `READY FOR CLAUDE VERIFICATION: PR #<number> <title> — claims tests <list>`
2. The builder may continue on the next branch while a review is pending, but it never merges its own pull request and never opens more than two pull requests awaiting review at once.
3. At a phase gate the builder stops entirely and ends with:
   `PHASE <n> GATE: awaiting Claude verification` and waits for the verdict.
4. When the verifier's findings come back, the builder answers each one in the pull request, then ends its message with:
   `READY FOR CLAUDE RE-VERIFICATION: PR #<number>`
5. When the builder must ask a question under the brief's "ask" rules, it ends with:
   `QUESTION FOR BILL:` followed by the question and the options it sees.

The verifier, in turn, posts findings as pull request review comments and ends its report to Bill with either `PASS: PR #<number> may be merged` or `HOLD: PR #<number>, <count> findings`, and at a gate with `PHASE <n>: PASS` or `PHASE <n>: HOLD`.
