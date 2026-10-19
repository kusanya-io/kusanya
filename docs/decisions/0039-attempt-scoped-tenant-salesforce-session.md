# ADR 0039: Attempt-scoped tenant Salesforce session

- Status: Proposed; implementation awaiting independent verification
- Date: 2026-10-19
- Brief sections: C1.3a, C2, C5 publish, C8, C11 Phase 1
- Decision owner: Cobitech Solutions
- Extends: ADRs 0025, 0036 and 0038

## Context

ADR 0038 persists one encrypted Salesforce refresh token per tenant, but deliberately
stops before selecting that connection or exchanging the token. ADR 0036 accepts a
fresh-token capability for an attempt-scoped publication but cannot obtain it from a
tenant binding. The missing boundary must not let an instance URL, Salesforce ID or
request header choose another tenant, and it must remain safe when the stateless
service runs more than one container replica.

Salesforce's [refresh-token flow](https://help.salesforce.com/s/articleView?id=xcloud.remoteaccess_oauth_refresh_token_flow.htm&language=en_US)
requires a form POST to `/services/oauth2/token`, recommends caching and reusing the
resulting access token instead of issuing simultaneous refreshes, and recommends
refresh-token rotation. Rotation makes the old refresh token single-use; reusing it
can invalidate the replacement and its access tokens. An in-process mutex is
therefore not sufficient for a multi-replica service.

## Decision

### Select only an authenticated tenant binding

`createTenantSalesforceSession` accepts a tenant UUID explicitly named
`trustedTenantId`. It is an internal boundary: a future route may supply that value
only from verified service authentication, never from a header, Salesforce record,
instance origin or global namespace. The exact tenant row supplies the authorization
origin, instance origin, normalized org ID, namespace and encrypted refresh-token
capability. An absent row gives only `TENANT_SALESFORCE_SESSION_NOT_CONNECTED`.

This unit adds no HTTP route and therefore does not claim that trusted request
authentication exists yet.

### Serialize refresh and rotation in PostgreSQL

The store pins one PostgreSQL connection, begins a transaction and selects the exact
tenant row `FOR UPDATE`. The row lock remains held while the refresh exchange runs.
All service replicas using this store therefore serialize refreshes for that tenant,
while different tenants remain independent. The operation either commits a returned
rotated token in the same transaction or rolls back; connections are always released.

The exchange invokes the encrypted `getRefreshToken` capability only while building
the bounded POST body and does not retain the plaintext in the returned session. A
rotated token is encrypted with the active service key and replaces the prior token
only when tenant, org and credential version still match. Its credential version is
incremented. The access token is not persisted. It is held only in a frozen,
attempt-scoped object behind a non-enumerated `getAccessToken` capability and reused
for that attempt. ADR 0036 still invokes the capability for every Salesforce request;
the future composition may bind it to this one short-lived session rather than
amplifying one publication into many refresh grants.

No local transaction can make a Salesforce rotation and a PostgreSQL commit atomic.
If Salesforce invalidates the old token and the database cannot commit the replacement,
the operation returns `TENANT_SALESFORCE_SESSION_ROTATION`, exposes no access token and
requires administrator reauthorization. It never retries the old token. This narrow
failure window is preferable to claiming a recoverability guarantee the two systems
cannot provide.

### Bind the returned token to the stored org and origin

The request is an HTTPS form POST to the stored authorization origin with the grant,
client ID, client secret and refresh token only in its body. It refuses redirects,
ambient credentials, caching, non-JSON responses, non-200 status, invalid UTF-8,
oversized bodies and a bounded deadline. The External Client App client ID and secret
are deployment inputs to this internal function; their environment wiring and the
authorization callback remain later work.

The deadline is enforced by racing the complete exchange against a local rejecting
timeout as well as aborting the supplied signal. A custom or future transport that
ignores `AbortSignal` therefore cannot keep the tenant's PostgreSQL row lock past the
deadline. Its abandoned operation cannot expose a session or commit a rotated token.

The response must contain a printable bounded bearer access token, an identity URL
whose normalized `00D` org ID equals the selected binding, and an instance URL whose
origin equals the stored instance origin. A root trailing slash is normalized, but
paths, ports, credentials, query strings, fragments and non-Salesforce hosts are
refused. The strict allowlist accepts Salesforce's documented refresh response and
the optional `refresh_token` and `token_format`; provider errors and bodies never
cross the boundary.

ADR 0038 note 87 is answered at the same time: refresh-token shape validation now
occurs at the store boundary, so `save` and conditional replacement consistently
raise `TenantConnectionError` rather than leaking `TenantCredentialError` into a
caller contract.

## Consequences and verification

Unit tests prove the exact no-cache form request, one-tenant selection, non-enumerated
access-token capability, conditional rotation, fixed failures, org/origin/type
binding, hostile shape refusal without getter execution, body limits, timeout and
secret-free errors. The timeout test deliberately uses a fetch implementation that
never settles and ignores its abort signal. Store tests prove one pinned `BEGIN`/
`SELECT FOR UPDATE`/
`UPDATE`/`COMMIT` sequence and rollback with operation-error preservation.

A disposable PostgreSQL 17 integration test must run two refresh operations against
one tenant. The second must remain outside its callback until the first commits its
rotated token, then observe the incremented credential version and replacement token.
The same real-database test must also prove that a signal-ignoring exchange loses its
row lock at the configured deadline and that a later same-tenant operation can enter.
This is database serialization evidence, not a live Salesforce OAuth grant. No
customer credential, Salesforce scratch org or client-app change is required.

This advances note 34 through refresh transport, rotation-aware persistence and an
internal trusted-tenant contract. ADR 0040 later adds the one-time administrator
authorization and PKCE callback protocol. Note 34 remains open for trusted HTTP
authentication, deployment client configuration, connection/disconnect lifecycle,
final publisher composition and CLI. Note 39 remains open. No C10 acceptance test,
publish-ready state or Phase 1 completion is claimed.

Verifier note 88 is answered by the local rejecting race and the real-database
lock-release test. Deadline enforcement no longer depends on injected fetch behavior.

## Revisit when

Exposing the callback through trusted administrator authentication, wiring deployment
client secrets, binding the session to `publishSalesforceDefinition`, adding
disconnect/reconnect and reauthorization UX, or implementing the publish CLI.
