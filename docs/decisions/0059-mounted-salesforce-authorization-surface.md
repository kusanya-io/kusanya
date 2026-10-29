# ADR 0059: Mounted Salesforce authorization surface

- Status: Proposed; implementation awaiting independent verification
- Date: 2026-10-29
- Brief sections: C1.3a, C2, C4 Tenant Connection, C8, C11 Phase 1, C12a
- Decision owner: Bill Owiti / Cobitech Solutions
- Extends: ADRs 0040, 0041, 0042, 0045, 0050, 0054 and 0058

## Context

The one-time Salesforce Authorization Code plus PKCE core, its browser adapter,
revocable administrator sessions, tenant-wide provisioning tuple and atomic
administrator/Salesforce-user audit were independently verified. The adapter stayed
unmounted until the production surface had a concrete identity, live role checks,
hardened request logging and complete deployment-secret configuration.

Those prerequisites now exist. Leaving the reviewed adapter outside the running
composition prevents a tenant administrator from establishing the encrypted
Salesforce connection that publication requires. Mounting also makes note 128's
previously unreachable status-code difference observable: the old adapter accepted
administrator-cookie lengths from 43 through 512 for parsing and returned 401 only
after authentication, while the shared cookie reader accepts exactly the 43
characters the session store issues and classified other shapes as route input.

## Decision

### Mount through the existing fail-closed composition

`registerPublicationSurface` now requires the OAuth transaction store, OAuth
configuration and connection authorization capability in addition to its existing
dependencies. It constructs the one live-session resolver used by every protected
administrator adapter and passes the OAuth route only frozen least-capability
wrappers: `begin`/`consume` for one-time state and `saveAuthorization` for the atomic
encrypted connection plus audit. The route receives neither the publication attempt
store nor the refresh-session capability.

`main.ts` creates those capabilities from the same PostgreSQL executor and the same
encrypted tenant connection store already used by publication. No alternate token
store, tenant selector or credential path is introduced. Missing any new capability
prevents registration rather than falling back to a partial surface.

### Derive the callback and fail startup on incomplete secrets

The runtime reads a separate canonical base64 32-byte
`SALESFORCE_OAUTH_STATE_SECRET`, a 1 through 30000 millisecond exchange timeout and
a 60 through 900 second transaction TTL. Client ID and secret are the same reviewed
connected-app credentials already required for refresh. The redirect URI is not a
second operator-controlled value: it is derived as the exact configured
`ADMIN_EXTERNAL_ORIGIN` plus `/api/admin/salesforce/callback`, and route registration
checks that equality again.

All values validate before PostgreSQL is opened. The committed example contains
placeholders only. State, PKCE verifier, authorization code, access token, refresh
token and client secret are never logged or returned by the service.

### Treat malformed session credentials as authentication failures

The shared cookie reader's exact 43-character acceptance remains unchanged. Start
and callback deliberately classify a missing, malformed, expired, revoked or
otherwise unusable administrator cookie as the same fixed `401 Authentication
required`. This closes note 128 without widening the accepted credential set and
without exposing a cookie-shape oracle.

OAuth protocol input retains a separate classification: malformed or duplicate
callback query values, state and browser binding return the fixed generic 400. A
live non-administrator returns the existing fixed 403. Storage or connection
unavailability returns the existing fixed 503. No response reflects the rejected
value or tenant context.

### Publish only the least-data route contract

OpenAPI documents the bodyless, queryless start and the callback's exact `state`
plus either `code` or `error` shape. The successful callback returns only
`{"status":"connected"}` and expires the binding cookie. Neither route accepts or
returns tenant, org, namespace, actor, Salesforce user, access token or refresh
token. The callback parameters are sensitive and the already mandatory hardened
logging guard remains a registration prerequisite.

## Consequences and verification

Composition tests drive the start through the real `createApp` surface, assert the
Salesforce redirect and every browser-cookie attribute, remove every required
capability in turn and keep the unsafe-logger refusal. Route tests pin 401 for empty,
illegal, short and long administrator cookies on both start and callback while the
existing hostile callback matrix continues to pin 400 for protocol input. Runtime
tests remove every new environment setting and exercise both bounds and malformed
secrets. The OpenAPI tripwire refuses tenant selectors or credential fields.

This advances note 34 by mounting tenant connection authorization and closes note 128. It does not add privileged disconnect/rebind, scheduled reconciliation,
privileged retry, unlinked File cleanup, a real CI workload publication, ODK Validate
runtime assets or a C10 acceptance claim. No collector receives or needs a Salesforce
licence.

## Revisit when

The external origin or callback path changes, Salesforce connected-app credentials
rotate, multiple outstanding grants per tenant are required, a privileged
disconnect/rebind flow is added, or another tenant connection protocol is supported.
