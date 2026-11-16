# ADR 0073: Establish a durable tenant-scoped submission relay

- Status: Accepted
- Date: 2026-11-13
- Brief sections: C2, C4, C7, C8, C10.5, C10.8, C10.14, C11 Phase 2
- Decision owner: Cobitech Solutions

## Context

Phase 2 must accept OpenRosa submissions without acknowledging a device before
Salesforce commits, preserve exact raw XML for retry and error review, prevent a
duplicate instance from creating records twice, and keep every operation bound to
the authenticated tenant. The service already has an encrypted, immutable tenant
connection tuple but has no collector route or submission persistence. Salesforce
has the authoring model but not the Submission, Answer, Error Log or Sync Log
records required by C4.

The service must not infer a tenant from an HTTP header or normalize away evidence.
Untrusted XML also cannot be expanded through a DTD or used to allocate unbounded
memory before it is durable. The later Apex mapping transaction, media store,
collector credential and OpenRosa response still need their own reviewed units.

## Decision

Add `tenant_submission_relays` to the existing customer service PostgreSQL schema.
The row contains one exact raw XML byte sequence, its SHA-256, the server-selected
tenant/org/form-version tuple, the ODK form key/version and canonical `uuid:`
instance identity. A database trigger admits rows only while that exact tenant
connection tuple is current and connected. `(tenant_id, instance_id)` is unique.
An exact replay returns the existing relay; the same identity with different XML,
form, channel or org is a conflict. PostgreSQL independently verifies that the
stored SHA-256 is the digest of the stored raw bytes. Connection-admission failure
uses its own fixed `SUBMISSION_RELAY_ADMISSION` boundary code rather than being
reported as an identity conflict or generic storage failure.

The relay state machine is database-enforced:

`queued -> dispatching -> committed | dead`, with `dispatching -> queued` only for
a scheduled retry. A retry retains its last fixed failure code; queued rows are
therefore either new with zero attempts and no failure, or scheduled after a real
failure with both retry time and failure evidence. A row that has already used 100
attempts is moved to terminal `dead` with `ATTEMPT_LIMIT_EXHAUSTED` before claim
candidates are selected, so it cannot poison the tenant's claim transaction.
Identity, tenant, raw bytes, digest and received time are immutable. Claims use one
tenant-keyed `FOR UPDATE OF relay SKIP LOCKED` statement, lock only relay rows,
increment the attempt atomically and are bounded to 200 rows. A committed row
carries the acknowledgement time; no HTTP boundary may acknowledge before that
state exists.

Use the already pinned `saxes` streaming parser to extract only routing identity.
It rejects DTDs, processing instructions, comments, malformed XML, multiple roots,
noncanonical instance UUIDs, and inputs beyond 5 MiB, 10,000 nodes or 64 levels.
The exact bytes are never rewritten. Answer parsing and definition matching remain
the Apex engine's responsibility, so this parser cannot silently drop unknown
nodes or claim mapping success.

Add the C4 Salesforce objects `Submission__c`, `Answer__c`, `Error_Log__c` and
`Sync_Log__c`. Submission identity is unique/external, raw XML is represented by
an exact ContentVersion pin plus SHA-256, unknown answer nodes can be stored without
a Question lookup, and errors point to the parent whose File contains the XML.
Integration and Admin receive scoped model access; Supervisor receives read-only
cross-owner visibility. Collectors receive no Salesforce user or permission.

## Alternatives considered

- Acknowledge after PostgreSQL enqueue and map asynchronously. Rejected because C2
  requires acknowledgement only after Salesforce commits; durable enqueue is a
  prerequisite, not success.
- Use an in-memory queue or a second broker. Rejected because it loses restart
  durability or adds an operational dependency before measurements justify it.
- Store only parsed answers. Rejected because C3.13 and C7 require exact raw XML for
  audit, retry and newly understood nodes.
- Treat instance ID as globally unique. Rejected because tenant isolation is the
  authority boundary; the same device identity in another tenant must not disclose
  or collide with the first.
- Parse and map in the service. Rejected because C7 assigns transactional target
  writes and Salesforce record lifecycle to Apex under the integration principal.

## Consequences and verification

This unit creates no collector or public HTTP route, makes no Salesforce API call,
uploads no media and cannot map a target record. It therefore claims no C10 test.
The API-call budget, media blob driver, retry schedule, retention deletion and
OpenRosa status/header contract remain due before their corresponding boundaries.
Raw XML exists only in the customer service database and, after intake, the customer
Salesforce org; no third storage location or Salesforce licence per collector is
introduced.

Unit tests attack executable object shapes, duplicate identities, changed payloads,
cross-tenant claims, stored-byte tampering, XML active content and all bounds.
PostgreSQL integration tests must prove the trigger rejects a disconnected or
mismatched tuple, two tenants can retain the same instance identity independently,
one relay cannot be claimed twice, retry increments attempts and direct payload or
terminal-state rewrites fail with `23514`. They also prove an attempt-100 row becomes
dead without blocking a healthy row, admission has a distinct code, the raw-byte
digest check is enforced and retry evidence is retained. Apex accepts only canonical
lowercase `uuid:` instance identities so the case-sensitive external ID cannot store
case variants of one logical UUID. Apex tests must prove duplicate instance IDs fail,
raw unknown nodes are representable, answer/error children follow the submission
lifecycle and a submission prevents deleting its definition version.

Direct SQL deletion and a retention policy for relay rows are deliberately not part
of this foundation. Until that reviewed lifecycle exists, privileged database roles
remain capable of deletion; application code exposes no deletion operation.

Notes D, E and F from the Phase 1 gate are corrected in the same documentation
change: the namespaced-org working directory is explicit, evidence attribution is
narrowed, and the automatic exemption is named accurately.

## Revisit when

Measured raw instances exceed the row limit, media storage is selected, retention
is implemented, or the Phase 2 API-call budget requires a different batch boundary.
