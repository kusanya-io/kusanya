# ADR 0040: One-time Salesforce administrator authorization

- Status: Proposed; implementation awaiting independent verification
- Date: 2026-10-19
- Brief sections: C1.3a, C2, C4 Tenant Connection, C8, C11 Phase 1, C12
- Decision owner: Cobitech Solutions
- Extends: ADRs 0038 and 0039

## Context

ADR 0038 selects Salesforce's OAuth 2.0 web-server authorization-code flow with
PKCE and persists an encrypted refresh token. ADR 0039 exchanges that token for an
attempt-scoped Salesforce session. Neither implements the first administrator grant.
This callback is the first boundary where untrusted browser and provider values can
create or replace a durable tenant-to-org credential, so state replay, PKCE replay,
wrong-org authorization and partial persistence must fail before a connection is
claimed.

Salesforce recommends the web-server flow with PKCE, recommends PKCE plus a client
secret for private server applications, and returns an identity URL, instance URL,
refresh token, issue time and HMAC signature in the grant response. The service still
has no trusted administrator HTTP authentication. Pretending that a tenant header is
trusted would turn the callback into a cross-tenant credential replacement route.

## Decision

### Keep trusted initiation internal

`beginTenantSalesforceAuthorization` is an internal boundary. Its tenant UUID,
expected normalized `00D` org ID, Salesforce authorization origin and namespace come
from a future authenticated administrator workflow, never from a callback, request
header, Salesforce URL or state payload. Until that workflow exists, this unit does
not expose an HTTP start route.

The operation creates a 256-bit random base64url state and returns an authorization
URL containing `response_type=code`, `api refresh_token` scope and an S256 PKCE
challenge. Configuration explicitly supplies the client ID, client secret, exact
HTTPS callback URL, deadline, transaction lifetime and a 32-byte deployment state
secret. Environment/secret-store wiring remains deployment work rather than a hidden
module default.

### Store a digest, derive PKCE and replace prior pending state

PostgreSQL stores only SHA-256(state), the trusted tenant/org/origin/namespace
binding and expiry. It never stores or logs the browser state, authorization code,
PKCE verifier, client secret or access token. The verifier is HMAC-SHA256 over a
versioned domain and the random state under the deployment state secret. The
challenge is SHA-256(verifier). Disclosure of PostgreSQL alone therefore reveals
neither browser state nor verifier.

There is at most one pending authorization per tenant. Starting a new one atomically
replaces that tenant's prior transaction, invalidating its state. Transactions live
for 60 to 900 seconds; a deployment state-secret rotation invalidates any pending
transaction, which the administrator restarts after the short expiry window.

### Consume before exchange and fail closed

The callback accepts exactly one state plus either one code or one provider error.
It atomically `DELETE ... RETURNING`s one unexpired digest before interpreting a
provider error or contacting Salesforce. Concurrent callbacks therefore have one
winner, and success, refusal, timeout, transport failure or storage failure can never
reuse the state or verifier. This deliberately sacrifices automatic retry: after any
failure the administrator starts a fresh grant. It avoids holding a database
transaction across external I/O and prevents a code from being exchanged twice.

The token exchange is one no-cache, no-redirect HTTPS form POST to the transaction's
trusted authorization origin with the exact redirect URI, code verifier and private
client credentials. A local rejecting race enforces the deadline even if fetch
ignores abort. Only bounded, valid UTF-8 JSON with an allowlisted response shape is
accepted. The Bearer access token is validated and discarded. The refresh token is
accepted only with a valid Salesforce identity URL, a case-safe org ID equal to the
transaction's expected org, an exact Salesforce instance origin, and an HMAC-SHA256
signature over `id + issued_at` verified with the client secret.

Only after all checks pass does the existing `TenantConnectionStore.save` perform
one encrypted insert or same-org replacement. Wrong-org grants are refused. A token
exchange followed by a database failure may require Salesforce reauthorization, but
cannot leave a partial new row; an existing connection remains governed by the
store's atomic statement. Returned metadata contains no access or refresh token.

## Consequences and verification

Unit tests prove exact PKCE construction, absence of state/verifier/client secret in
storage, atomic replay and concurrency refusal, provider-error consumption,
signature and expected-org binding, malformed/hostile input refusal without getter
execution, fixed secret-free errors, fetch-independent timeout and a late transport
that cannot persist. A disposable PostgreSQL 17 test must prove one winner across
two real concurrent consumes, encrypted-only durable refresh storage, replay refusal,
and no connection after a partial grant.

This advances note 34 through the authorization and callback protocol but does not
close it. Trusted administrator HTTP authentication and tenant provisioning,
deployment secret wiring, privileged disconnect/rebind, final publisher composition
and the publish CLI remain. No public callback route is safe until the service owns
its external origin, trusted administrator session and CSRF boundary. No live
Salesforce grant, connected/external client app change, Salesforce metadata, package,
scratch org, C10 acceptance test, publish-ready state or Phase 1 completion is
claimed.

## Revisit when

The trusted administrator route and deployment configuration are composed, multiple
simultaneous grants per tenant are required, the client or state secrets rotate, a
privileged disconnect/rebind workflow is added, or Salesforce changes its signed
token response contract.
