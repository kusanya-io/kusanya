# ADR 0076: Normalize retained XML into bounded Answer graphs

- Status: Accepted
- Date: 2026-11-17
- Brief sections: C7 steps 1 and 3 foundation, C8, C11 Phase 2
- Decision owner: Cobitech Solutions

## Context

ADR 0075 durably stores a byte-attested raw XForm instance and deliberately returns
`received`, not `mapped`. Its receipt does not yet create the Answer graph required
by C7. Mounting ADR 0074's scheduler at that boundary would repeatedly deliver an
already-received submission until the attempt ceiling made it terminally dead.

The Salesforce model already preserves portable Question names, explicit question
parents, repeat modes and the `submitted-count-v1` contract from ADR 0029. Answer
already has textual and typed projections, repeat position, parent Answer and an
optional Question lookup for unknown XML nodes. No Task, Collector, Device or Form
Link model exists yet, so this unit cannot safely execute target mappings or close
Tasks.

## Decision

Normalize raw XML as part of the bounded receipt transaction. A new inherited-
sharing `SubmissionAnswerParser` locks each pending Submission, loads only its Form
Version's Question graph in user mode, parses the retained bytes and writes Answer
rows in parent-before-child levels with user-mode DML. `Submission__c.Parsed_At__c`
is the idempotency marker and is written only after the complete Answer graph and
any warning row have committed. Existing Answers with a null marker are refused as
partial state rather than duplicated.

The parser accepts at most 200 Submission identities, 8,000 Answer nodes in the
whole call, nesting depth 32 and repeat count 1,000 unless the stored Question has
a lower `Repeat_Max__c`. XML is still capped at 750,000 bytes per item and entity or
doctype declarations are refused before DOM parsing. Text is capped at the Answer
field boundary. Errors expose only `SUBMISSION_PARSE_FAILED` or the receipt's fixed
`PARSE_FAILED`; exception text and XML never enter a response.

Question placement is structural. A known node name under the wrong stored parent
is refused rather than silently downgraded to unknown. Unknown nodes are retained
as Answers with a null Question lookup, and at most 50 distinct names are recorded
in one bounded `UNKNOWN_NODE` warning. The raw XML remains the authoritative audit
source.

For `from_answer` repeats, the submitted source answer is resolved in the enclosing
repeat context. It must be one canonical nonnegative integer and cannot exceed the
stored maximum. Fewer physical repeat instances than the submitted count is a
refusal; trailing physical instances are excluded from Answers exactly as ADR 0029
requires. Repeat paths and indices are retained on the container and descendants,
and each descendant points to its enclosing Answer.

Integer, decimal, date, datetime and `select_one` answers receive typed projections.
The exact normalized text remains in `Value__c`. An unmatched choice remains text
and creates the same bounded warning rather than inventing a Choice identity.
Numeric projections refuse values outside the stored field's precision and scale.
Media values remain text only; File ingestion is a later C7 boundary.

A content refusal is isolated to its Submission. Its raw Submission and File stay
durable, its marker stays null and its relay outcome is retryable `PARSE_FAILED`.
Other valid items in the same receipt batch commit normally. An unexpected query,
permission or DML failure still rolls back the receipt savepoint and returns fixed
retry outcomes for the affected batch. This distinction prevents one malformed
instance from poisoning unrelated relay rows without pretending infrastructure
failure is content failure.

The scheduler remains unmounted. Target mapping and the scheduler must land
together: only a completed mapping may turn the relay disposition into `committed`.

## Alternatives considered

- Mount the scheduler after parsing. Rejected because `received` is still not the
  C7 mapped state and would still exhaust attempts after successful parsing.
- Parse in the service and send Answers to Salesforce. Rejected because C7 makes
  the customer-org transaction authoritative and the Salesforce definition graph
  is the trusted version boundary.
- Reject the whole batch when one XML item is malformed. Rejected because a poison
  item would repeatedly block valid submissions sharing its bounded prefix.
- Delete trailing physical repeats. Rejected because the raw XML is immutable audit
  evidence; only the normalized graph follows the submitted-count contract.
- Create placeholder Task or Collector text fields. Rejected because those are
  security-bearing relationships and must arrive with their owning models.

## Consequences and verification

Only Integration can edit Parsed At; Admin and Supervisor can read it. No
permission set gains a customer-object grant, sharing bypass, setup privilege or
collector Salesforce identity. The integration resource remains the only mounted
caller and continues to require `Ingest_Kusanya_Submissions`.

Apex tests must prove parent links, repeat paths, typed values, unknown retention,
choice resolution, dynamic-repeat trimming and deficit refusal, wrong placement,
doctype refusal, partial-state refusal, idempotency, isolation of one invalid item,
and a 200-Submission/6,000-Answer batch. The receipt test must prove a malformed
item cannot roll back a valid sibling and that replay does not duplicate raw or
normalized state. Static tests pin the three bounds, the fixed error contract and
the absence of target DML or scheduler mounting.

This unit does not execute Mapping records, describe or write customer objects,
resolve references, Tasks or Collectors, ingest media, expose OpenRosa, mount a
scheduler, close C10.15 or claim any C10 acceptance test or Phase 2 gate.

## Revisit when

The mapping engine and scheduler land together, Task and Collector identities are
available, media manifests arrive, malformed instances need an operator repair
flow, or a measured valid submission approaches a parser bound.
