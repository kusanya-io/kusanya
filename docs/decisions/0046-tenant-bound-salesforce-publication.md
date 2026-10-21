# ADR 0046: Tenant-bound Salesforce publication composition

- Status: Proposed; implementation awaiting independent verification
- Date: 2026-10-21
- Brief sections: C1.3a, C2, C3.5/.11/.16/.20, C4, C5 publish, C8, C11 Phase 1
- Decision owner: Cobitech Solutions
- Extends: ADRs 0036, 0039, 0043 and 0045

## Context

ADR 0036 composes definition loading, fresh Describe, compilation, validation,
artifact attestation and immutable commit, but deliberately accepts an abstract
access-token capability. ADR 0039 creates that capability from an encrypted tenant
connection, but accepts only a trusted tenant UUID. Calling those boundaries
separately could bypass the immutable administrator provisioning tuple or supply a
different token source. The final internal service composition must make that
misuse unrepresentable.

Publication also crosses several Salesforce REST requests. Once exact artifacts
have been uploaded, a commit refusal or two uncertain commit responses can leave
unlinked private Files. There is no transaction spanning those requests, and the
service does not yet have a local publication record that could truthfully make the
operation atomic.

## Decision

### Use the attempt-scoped tenant session as the only credential path

`publishTenantSalesforceDefinition` accepts the live, strictly decoded
`TrustedAdministratorContext`, the tenant connection store, deployment OAuth client
configuration, bounded publication timings and one Form Version ID. It accepts no
access token, refresh token, instance origin, org ID, namespace, username or token
callback from the publication request. It creates exactly one bound ADR 0039 session
and passes only that session's non-enumerated `getAccessToken` capability and stored
instance origin to ADR 0036.

All context, configuration, request, validator and transport shapes are checked
before the store is selected. Refresh exchange time is charged to the same overall
publication deadline; the remaining budget, not a new full budget, is passed to the
publisher.

### Refuse provisioning drift before credential or Salesforce use

`createBoundTenantSalesforceSession` compares the selected connection's normalized
org, authorization origin and canonical namespace with the immutable tenant tuple
from the live administrator context while holding the refresh lock. A mismatch
returns `TENANT_PUBLICATION_BINDING` before calling `getRefreshToken` or making the
OAuth request. Absence returns `TENANT_PUBLICATION_NOT_CONNECTED`; refresh and
rotation failures return `TENANT_PUBLICATION_SESSION`. None exposes provider,
database, credential, tenant or Salesforce values.

The comparison is repeated on every attempt. It does not repair or choose between
disagreeing rows, and it does not add a rebind path.

### Name the post-upload failure state

After artifact attestation succeeds, any failure to confirm the immutable commit
after ADR 0036's one byte-identical retry returns
`PUBLICATION_PUBLISHER_PARTIAL`. Earlier definition, Describe, validation, upload or
attestation failures retain their existing codes. The distinct result means
private, unlinked artifacts may exist and reconciliation is required; it never
claims rollback, commit or publish success and never deletes artifacts after an
uncertain commit.

Salesforce remains the only publication system of record in this unit. No local
publication row is introduced, so there is no false cross-system atomicity claim.
A later job, retry or retention boundary must reconcile partial attempts before it
may claim cleanup or recovery.

### Preserve the reviewed authorization posture

This composition changes no Salesforce metadata, permission set, sharing rule or
publisher selection. The same Integration principal still needs
`Kusanya_Integration`, target CRUD/FLS from fresh Describe and the one Form-scoped
Edit share from ADR 0037. It cannot widen access during publication.

## Consequences and verification

Unit tests prove exact-tuple success; mismatch of org, authorization origin or
namespace before refresh-token access and all network I/O; absent connections;
hostile configuration and request refusal before store access; one OAuth exchange;
reuse of only the attempt-scoped access token across every publication request; and
one overall deadline spanning refresh and publication. ADR 0036 tests prove the new
partial outcome after deterministic and uncertain commit failures.

Independent verification must run the composition against a disposable PostgreSQL
17 tenant binding and fresh Salesforce org with the non-administrator Integration
principal. It must prove the exact binding publishes through the established scoped
record access, a mismatched synthetic binding performs no OAuth or Salesforce call,
and a lost commit response retains the existing byte-identical internal retry. This
unit adds no Salesforce metadata, package, route, deployment secret wiring or CLI.

This advances note 34 through final internal publisher composition. Note 34 remains
open for the approved provisioning interface, deployment wiring, external identity
provider, privileged disconnect/rebind and publish CLI. Note 39 remains open. No C10
acceptance test, publish-ready state or Phase 1 completion is claimed.

## Revisit when

Adding the publish route or CLI, a durable attempt/reconciliation table, abandoned
artifact retention, deployment OAuth secrets, privileged connection lifecycle or a
second Salesforce org per tenant.
