# ADR 0047: Durable administrator publication attempts

- Status: Proposed; implementation awaiting independent verification
- Date: 2026-10-22
- Brief sections: C1.3a, C2, C3.5/.11/.16/.20, C5 publish, C8, C11 Phase 1
- Decision owner: Cobitech Solutions
- Extends: ADRs 0036, 0039, 0044 and 0046

## Context

The internal tenant publisher is bounded and tenant-bound, but has no operator
route or durable local attempt. Publication spans OAuth plus several Salesforce
REST calls and cannot be made atomic with PostgreSQL. Exact Files may exist after
the immutable commit response is lost. A generic error or after-the-fact success
row would conceal that uncertainty.

## Decision

Add a hardened `POST /api/admin/salesforce/publications` adapter. It
accepts exactly one Form Version ID. Tenant, actor, expected org, authorization
origin and namespace come only from the live opaque administrator session. The
route requires the exact configured origin and session-derived CSRF token; request
query, tenant headers and body fields cannot select a tenant. Registration refuses
a host whose automatic request logging could serialize URLs or cookies. ADR 0050
later supplies the separately approved external identity and deployment-secret
composition and mounts this adapter without changing its authority.

Migration `0006_publication_attempts` adds one tenant- and actor-bound attempt row.
The route inserts `started` before OAuth. A one-way, same-tenant conditional update
may record `succeeded` with the package digest, `failed` with a fixed code, or
`partial` with the exact package digest and both uploaded ContentVersion IDs. A
process failure or failed terminal update deliberately leaves `started`: an
unresolved reconciliation signal, never permission to retry or a success claim.
An uncertain commit returns a distinct HTTP `partial` or `unresolved` state. No
credential, provider response, form contents or compile warnings enter the table.

`salesforce_request_count` and operator field `salesforceRequestCount` count
definition, Describe, Files and commit REST requests after the attempt-scoped
session is obtained. They intentionally exclude the single OAuth token exchange,
which is not a governor-counted publication REST call. This closes note 102's
terminology ambiguity.

## Consequences and verification

Foreign keys and the `INSERT ... SELECT` recheck the complete live actor/tenant
provisioning tuple. Terminal transitions are one-way and tenant-scoped. The partial
callback runs only after both byte-identical commit attempts fail, when the digest
and exact ContentVersion IDs are known.

Independent verification should attack CSRF and origin handling, forged tenant
selectors, duplicate cookies, hostile bodies, second-tenant completion, terminal
replay, interruption before OAuth, a lost commit response, and partial-ledger
failure. It should inspect PostgreSQL for exact identities and credential absence.
No Salesforce metadata, permission, sharing, package or namespace changes are made.
No C10 acceptance test or publish-ready claim is made.

Note 34 advances but remains open for external identity/deployment composition,
approved provisioning, disconnect/rebind, reconciliation/retention and the publish
CLI. Note 39 remains open.

## Revisit when

Adding reconciliation, abandoned-artifact retention, privileged retry, the CLI,
deployment mounting, or a second publication channel.
