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
- Run the Salesforce package tests in a fresh scratch org from the Dev Hub; Apex coverage must be 85 percent or better and every test must pass. ADR 0051 permits an ordinary non-C10, non-phase-gate PR to use the trusted Salesforce-identical exemption instead: independently confirm that the pinned policy bound the exact head to accepted `main` and the same complete `salesforce/` tree, and report explicitly that Apex did not run.
- Run the service test suite locally in the container.
- Run every acceptance test the pull request claims, from a clean state.
- Try to break it with the real forms in `seed/`: the 144-question observation, the HWWS observation with mixed once-only questions and repeats, the interview with exactly five repeat instances.
- Check the four things the brief says nobody should rediscover: the collector stamp on every mapped record, no Salesforce user or sharing created for a collector, API-call batching under the stated budget, and tenant isolation.
- Read every new object and field for a description, every Apex class for a responsibility header, and every decision for an ADR.
- Confirm nothing stores collector credentials, Salesforce tokens or submission data outside the customer's org and the service database, and that tokens are encrypted at rest.

## What the verifier does at a phase gate

- Runs the full acceptance list for the phase, plus every earlier phase's list, so nothing has regressed.
- Requires a real exact-head Apex run; neither trusted exemption is phase-gate or C10 evidence.
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

The builder and the verifier do not share a session, and neither reads the other's messages. **The pull request is the only transport between them.** The builder writes its verification request into the pull request body; the verifier reads it there and replies in pull request comments. Bill is not a copy-paste channel: he approves protected runs and merges, and nothing in the hand-off depends on him relaying text.

1. When a pull request is ready, the builder ends its message to Bill with one line in this exact form, so it is never missed:
   `READY FOR CLAUDE VERIFICATION: PR #<number> <title> — claims tests <list>`
   Bill's whole instruction to the verifier is then `verify PR #<number>`. The builder must not expect anything else to be carried across.
2. The builder may continue on the next branch while a review is pending, but it never merges its own pull request and never opens more than two pull requests awaiting review at once.
3. At a phase gate the builder stops entirely and ends with:
   `PHASE <n> GATE: awaiting Claude verification` and waits for the verdict.
4. When the verifier's findings come back, the builder answers each one in the pull request, then ends its message with:
   `READY FOR CLAUDE RE-VERIFICATION: PR #<number>`
5. When the builder must ask a question under the brief's "ask" rules, it ends with:
   `QUESTION FOR BILL:` followed by the question and the options it sees.
6. The verifier's comments on the pull request are the verdict of record. Before answering a finding, re-verification or a merge, the builder reads them from the pull request itself, for example with `gh pr view <number> --comments`. A verdict relayed in chat is a convenience copy; the comment is the artefact.

The verifier, in turn, posts findings as pull request review comments and ends its report to Bill with either `PASS: PR #<number> may be merged` or `HOLD: PR #<number>, <count> findings`, and at a gate with `PHASE <n>: PASS` or `PHASE <n>: HOLD`.

## What stays with Bill, and why

Two actions are deliberately his and are never automated:

- **Approving a protected Salesforce run.** It is the only human gate on credentialed execution against the Dev Hub, and ADR 0006 places it there on purpose.
- **Merging.** `main` is strict and enforced for administrators, and the merge order between a source pull request and its verification log matters.

Neither agent may approve a run, merge, or run the verifier inside the pipeline it verifies. A verifier holding repository or organisation credentials inside CI would lose the independence that is the whole point of the role.

## The verification request the builder writes

The hand-off line is the trigger. The request itself goes in the **pull request body**, where the verifier reads it directly; it is not pasted into chat. It must be self-contained: the verifier starts from it with no other context from the builder's session. Exact shape:

```
VERIFICATION REQUEST
Phase: <n> of brief C11
Brief sections implemented: <list, e.g. C4 data model (Form, Form_Version, Question), C5 print view>
Acceptance tests claimed (brief C10): <numbers and one line each on how each was exercised>
How to run it:
  - scratch org: <command or script>
  - service: <command, with the Compose project name on cobitech-edge if deployed there>
  - tests: <commands for Apex tests, service tests, acceptance tests>
What changed: <five to fifteen lines, by folder>
Trust-boundary declaration:
  - .github/: <"unchanged", or every file and why>
  - scripts/: <"unchanged", or every file and why>
  - salesforce/: <"unchanged", or every file and why>
  - manifests and lockfiles: <"unchanged", or every change and why>
  - permission sets, profiles, namespace: <"unchanged", or every change and why>
Decisions recorded: <ADR numbers and titles>
Known gaps and deviations from the brief: <list, or "none">
What the verifier should look at hardest: <the two or three riskiest parts, in the builder's own judgement>
Questions for Bill: <list, or "none">
```

The pull request number, title, branch and head commit are deliberately absent: the verifier takes them from the pull request, not from a claim in its body. A head sha written into prose is stale the moment the builder pushes again, and the verifier would then be reviewing one commit while believing it reviewed another.

Rules for the request: every path and command must be real and copy-pasteable; every test claimed must have been run by the builder before the request is written; a deviation from the brief that is not listed under "known gaps" is a blocker when the verifier finds it; an undeclared change inside the trust boundary is a blocker, because the declaration is what the verifier checks the repository against. Re-verification requests keep the same shape, with the heading `RE-VERIFICATION REQUEST`, a section `Findings answered:` listing each finding and what changed, and a refreshed trust-boundary declaration. The builder updates the request in place by editing the pull request body; it does not open a new pull request to restate it.
