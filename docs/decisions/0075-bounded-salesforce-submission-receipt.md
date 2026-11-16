# ADR 0075: Persist raw submissions through a bounded Salesforce receipt

- Status: Accepted
- Date: 2026-11-16
- Brief sections: C2, C7 steps 2 and 7 foundation, C8, C11 Phase 2
- Decision owner: Cobitech Solutions

## Context

ADRs 0073 and 0074 retain exact raw XML in a tenant-scoped PostgreSQL relay,
revalidate the Salesforce connection while loading its encrypted credential, and
recover abandoned work. The delivery capability was injected because no
Salesforce ingestion endpoint existed. `Submission__c` and its raw-XML File field
already exist, but acknowledging the relay before the bytes are durable in the
customer org would lose the only mapping source.

The synchronous Apex REST request has a bounded body. A logical dispatcher batch
may contain 200 rows, while arbitrary 200-by-5-MiB payloads cannot fit one request.
Media is a separate C7 manifest and must not be hidden in this XML boundary.

Verifier notes O to T also identified six dispatcher properties that should be
settled before the transport becomes reachable: unreferenced deadline timers,
late OAuth rotation after a dispatcher timeout, application-clock lease recovery,
lost terminal failure evidence, overlapping run counters and reliance on a store's
frozen-array implementation detail.

## Decision

Add an integration-only `POST /services/apexrest/{namespace}/v1/submissions/ingest`
resource protected by `Ingest_Kusanya_Submissions`. One request carries schema 1
and at most 200 relay-owned items. Every item has only the relay identity, published
or superseded Form Version identity, canonical instance UUID, channel, lowercase
SHA-256 and canonical base64 raw XML. The resource rejects duplicate JSON keys,
unknown fields, duplicate relay or instance identities, draft/missing versions,
non-canonical base64 and any digest mismatch before DML.

New submissions and their private raw-XML `ContentVersion` records are written
under one savepoint with user-mode DML. `FirstPublishLocationId` creates the File
link to `Submission__c`; `Raw_XML_Version__c` pins the exact version. A replay with
the same instance, definition, channel, hash and File is idempotent. Any mismatch
is a terminal instance conflict. The response contains only the relay id, a closed
status and a fixed code; it returns no Salesforce record id or exception text.

The service resolves the namespace from the selected connection and makes one
Salesforce request per dispatcher invocation. It fills the request in relay order
up to 1,500,000 UTF-8 bytes and returns local retry outcomes for the untransmitted
suffix. Raw XML is capped at 750,000 bytes so at least one valid relay always fits
after canonical base64 and envelope overhead while leaving synchronous Apex heap
headroom for the request Blob, JSON string, decoded XML and DML records. This is a
deliberate service limit, not an ODK transformation; stored XML remains byte-exact.

`received` is not `mapped`. The transport maps only Salesforce's `mapped` status to
the dispatcher's `committed` disposition. A new or already-received row remains a
retry until the mapping engine is added. The scheduler therefore remains unmounted
in this unit: mounting a receipt-only transport would create a deliberate retry
loop and would misrepresent C7 completion.

The dispatcher hardening is part of the same boundary:

- OAuth and delivery deadline timers remain referenced until their `finally`
  blocks clear them. An otherwise idle one-shot process cannot exit before release.
- The credential deadline aborts the session's token exchange. A late response
  cannot persist a rotated token or expose access after the relay was requeued.
  Salesforce may still count a request already received; C10.15 must measure calls.
- Lease expiry and retry time use PostgreSQL `clock_timestamp()`, never caller time.
- Attempt 100 retains the actual final fixed failure code; the attempt count proves
  that no further claim is possible.
- A run reports `touched`, the unique union of recovered and claimed relay ids.
  `recovered` and `claimed` remain separate gauges and must not be summed.
- The dispatcher validates and snapshots every recovered identity and claimed row,
  copies raw bytes and freezes its own row array before credentials or transport.

## Alternatives considered

- Acknowledge receipt as committed. Rejected because C7 commits only after mapping
  and target DML complete.
- Put raw XML in PostgreSQL only and send parsed answers. Rejected because C7 makes
  Apex authoritative for parsing and requires the raw source in the customer org.
- Upload one File per standard REST request. Rejected because it destroys the
  one-call batch shape and makes C10.15 impossible to budget sensibly.
- Send all 200 rows regardless of bytes. Rejected because the platform body limit
  is a real boundary; the suffix policy makes progress without silent truncation.
- Use the application host's clock for lease age. Rejected because clock skew can
  recover live work and cause duplicate delivery.
- Mount the scheduler now. Rejected because receipt is not mapping and an accepted
  receipt intentionally returns retry.

## Consequences and verification

The integration permission set gains one Apex resource and one custom permission.
It gains no customer-object access, setup privilege, sharing bypass or collector
Salesforce identity. Collectors still never require Salesforce licences.

Apex tests must prove exact bytes are stored and linked, exact replay creates no
second Submission or File, a mapped replay is successful, a changed replay is
terminal, malformed/oversized/ungranted calls fail before authorised DML and errors
contain no XML. Service tests must prove empty and `ksny__` paths, one request for a
bounded prefix, deferred suffix retry, closed response parsing, fixed failures,
deadline cancellation, database-clock recovery, unique run accounting and local
claim snapshots.

This unit does not parse Answers, execute Mapping records, write customer targets,
resolve Tasks or Collectors, ingest media, expose an OpenRosa route, mount a
scheduler, set the C10.15 budget or claim a C10 acceptance test. Those are explicit
remaining Phase 2 work, not implied by the receipt name.

## Revisit when

The answer parser and mapping engine land, media manifests are transported, the
scheduler is mounted, a real valid XML approaches 750,000 bytes, or C10.15
measurements require a different request-size or count policy.
