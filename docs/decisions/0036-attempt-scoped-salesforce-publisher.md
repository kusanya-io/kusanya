# ADR 0036: Attempt-scoped Salesforce publisher composition

- Status: Proposed; implementation awaiting independent verification
- Date: 2026-10-09
- Brief sections: C2, C3.5/.11/.16/.20, C4, C5 publish, C8, C11 Phase 1
- Decision owner: Cobitech Solutions
- Extends: ADRs 0019-0023, 0026, 0032, 0034 and 0035

## Context

Kusanya has separately reviewed boundaries for loading a portable Salesforce
definition, obtaining fresh target Describe metadata, compiling and validating a
content-addressed package, uploading and reading back its exact artifacts, and
committing immutable version identifiers. Nothing yet forces a caller to execute
those boundaries in that order, as one Salesforce principal, or to stop before
commit after any diagnostic. Note 69 is answered at the storage boundary only;
its byte evidence becomes meaningful to publication only when the attested result
is passed immediately to the commit operation.

This unit must remain reviewable. Tenant selection, encrypted refresh-token
storage and rotation, CLI presentation, artifact delivery and ingestion remain
separate boundaries.

## Decision

Add `publishSalesforceDefinition`, one attempt-scoped service operation. It accepts
exactly one trusted Salesforce instance origin, one fresh-token capability, bounded
request and overall deadlines, and one Form Version ID. It never accepts a tenant,
username, owner, token or target object in the request value and never persists a
credential.

The operation performs these steps in order:

1. POST the strict ADR 0034 definition request and decode only its exact portable
   snapshot envelope;
2. build the ADR 0023 package using fresh API 64.0 Describe calls through the same
   origin and token capability, then run the supplied bounded ODK validator;
3. pass the exact package JSON and digest directly to ADR 0035, which uploads both
   files and returns immutable version IDs only after byte-for-byte readback; and
4. POST those returned IDs, the same Form Version ID, package digest and canonical
   warning JSON to the ADR 0032 commit endpoint.

No later stage runs after an earlier refusal. The operation returns success only
when the commit response repeats the exact package digest. A retry that reaches an
already committed publication preserves the endpoint's `alreadyCommitted` result.
The commit POST is attempted at most twice inside the same publication attempt.
The second request, if needed, reuses the byte-identical body and therefore the
same attested ContentVersion IDs; it never recompiles or uploads replacement files.
The token capability is invoked afresh for every Salesforce request. The caller is
responsible for binding it to one org and one integration principal for the whole
attempt; swapping principals would violate this contract and, because Files are
private to their uploader, can make the commit refuse. This explicitly carries
note 83 into composition.

The publishing principal must also hold record-level write access to the selected
Form Version. `Kusanya_Integration` can read cross-owner definitions through the
scoped View All Records grants in ADR 0026, but `Form__c` is private and its
master-detail Form Versions are controlled by the parent. View All Records does not
grant update access, and `modifyAllRecords` deliberately remains false. A definition
owned by another principal can therefore be read, compiled and attested yet refuse
at the final user-mode update unless it has been shared for write. This unit does
not add sharing rules, groups, roles or Apex managed sharing and does not weaken
that refusal.

All direct REST responses require status 200, JSON media type, fatal UTF-8 and
bounded streaming bodies. Requests disable ambient credentials and caching and
refuse redirects. Definition responses are capped at 5,000,000 bytes and commit
responses at 65,536 bytes. One shared deadline includes direct token acquisition,
definition, Describe, artifact and commit work. Results contain only the package
digest, idempotency flag and request count on success, or frozen structural
diagnostics and the request count on refusal. Provider bodies, tokens, origins,
Salesforce IDs and definition values never appear in failures.

A commit refusal after successful artifact attestation can leave two unlinked,
private Files. The first uncertain response is retried with the exact same commit
body so a completed first request can return `alreadyCommitted`; if both responses
remain uncertain, this unit does not delete the files because the commit may have
succeeded. A later reconciliation/retention unit must distinguish committed
artifacts from abandoned uploads. Claiming transactional rollback across REST calls
would be false.

## Consequences and verification

Unit tests prove the exact definition, Describe, upload/readback and commit order;
fresh token use per request; exact commit linkage to the attested versions and
digest; zero-I/O hostile-input refusal; no artifact upload after definition,
Describe, package or validator refusal; no commit after attestation failure;
mismatch cleanup; commit refusal without a success claim; shared token deadlines;
bounded strict responses; a lost first commit response retried with byte-identical
IDs and body and no second upload; request counts, immutability and non-disclosure.

Independent verification must run the composed operation in a fresh org as a
non-administrator Integration principal. A cross-owner definition proves that the
ADR 0034 read succeeds and that a target field hidden from that principal is absent
from Describe and refuses before artifact upload. It must not be treated as a
successful-publication fixture unless the principal also has record-level write
access to that Form Version. Successful publication must instead use a definition
owned by the Integration principal or explicitly shared to it for write, and prove
that both committed ContentVersion IDs are owned and readable by that same
principal, stored bytes equal the local package, and a deliberately lost first
commit response makes the internal retry report `alreadyCommitted` without changing
the committed artifact identities or uploading a second pair. A cross-owner commit
without write access must refuse without changing the Form Version; the resulting
unlinked private Files remain subject to the reconciliation obligation above.

This unit makes note 69's storage evidence mandatory immediately before commit and
answers it for the same-principal path that can reach commit; it does not claim a
cross-owner path can commit without write sharing. It advances note 34 through
publisher composition and restricted-principal target-FLS proof. Note 34 remains
open for tenant connection selection, encrypted credential persistence and
rotation, the publish CLI, and the product decision that grants a publishing
principal scoped record-level write access to administrator-authored definitions.
Note 39 remains open for gated, uncached delivery. No dependency, lockfile,
workflow, harness, Salesforce metadata, sharing configuration, delivery route,
ingestion path, C10 acceptance test or Phase 1 completion claim is included.

## Revisit when

Adding tenant connection storage, CLI publication, reconciliation of uncertain or
abandoned uploads, artifact retention, publisher API exposure, or scoped sharing
for administrator-authored definitions.
