# ADR 0044: Administrator browser session composition and logging guard

- Status: Accepted; verified in PR #81, mounted by ADR 0050
- Date: 2026-10-20
- Brief sections: C1.3a, C2, C8, C11 Phase 1
- Decision owner: Cobitech Solutions
- Extends: ADRs 0041, 0042 and 0043

## Context

ADR 0042 supplies opaque, revocable administrator sessions but deliberately leaves
browser issuance and logout uncomposed. The browser contract must use a host-only
cookie that survives the top-level Salesforce redirect without becoming available
to JavaScript. Same-origin application code also needs the session-derived CSRF
token, but the token must not appear on an unauthenticated response, URL, redirect
or log.

Independent review note 94 also identified that ADR 0041's OAuth adapter could be
registered on any Fastify instance. The adapter itself never logs, but Fastify's
default request logger includes the callback URL, which contains the one-time OAuth
code and state. Documentation cannot make that host property travel with the
adapter.

At the time of this decision the external administrator identity provider was still
undecided. ADR 0050 records Bill's later OIDC/Entra decision and mounts this adapter.

## Decision

### Keep identity verification injected and issue a fresh session afterward

`registerAdministratorSessionRoutes` accepts a provider-specific
`verifyLoginRequest` capability. The capability is the only component allowed to
translate a completed external login into a stable internal actor identifier. The
adapter requires an exact HTTPS application origin and an empty query/body, strictly
decodes the returned actor, and then asks `AdministratorSessionStore` to issue a new
random session. It never accepts an actor or tenant identifier from request data.

Successful login returns no CSRF value or identity data. It sets only
`__Host-kusanya_admin_session` with `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`,
an explicit bounded `Max-Age`, and no `Domain`. Any old browser value is replaced;
failed login expires it. The adapter remained unmounted until ADR 0050 recorded
Bill's OIDC selection and supplied the reviewed deployment-secret wiring.

### Bootstrap CSRF only through a live same-origin session

The CSRF bootstrap is a same-origin POST with an empty query/body and the host-only
session cookie. It resolves that cookie against live PostgreSQL state and returns
only `{ "csrfToken": ... }` with the service-wide `Cache-Control: no-store` header.
Cross-origin, absent, expired, replaced and malformed sessions never receive the
token. The value is not placed in a cookie, URL, redirect or unauthenticated login
response.

### Revoke before clearing the cookie

Logout is a same-origin POST authenticated by both the live session cookie and its
constant-time CSRF value. It deletes the session digest before expiring the browser
cookie. A CSRF refusal or storage failure leaves the cookie unchanged so the browser
can retry and the service never claims logout while a database session may remain.
An absent or already-invalid session receives a fixed authentication refusal and a
cookie expiry because no live row was authenticated.

### Make safe request logging a runtime registration precondition

`createApp` retains the Fastify `LogController` with automatic request logging
disabled, the request serializer that emits only the HTTP method, generic error
serialization, and cookie/authorization redaction. Browser route adapters call
`requireHardenedRequestLogging` before registering. The guard inspects Fastify's
actual installed log controller and requires its own non-accessor
`disableRequestLogging` value to be exactly `true`. A default Fastify host, including
one with logging output disabled only for a test, is rejected with the fixed
`HTTP_LOGGING_CONFIGURATION` error before any route exists.

The guard deliberately depends on the installed Fastify controller shape. It was
first verified on 5.12.3 and is re-proved on the security-patched 5.12.7 in ADR 0050.
That makes a framework upgrade fail closed rather than silently weakening the logging
boundary; every Fastify upgrade must re-prove the controller inspection and both
default-host refusal tests.

This closes note 94 in code. The guard prevents the automatic request logger from
serializing callback query strings or cookies; the adapters themselves contain no
logging calls and return only fixed errors.

## Consequences and verification

Unit tests assert the real `Set-Cookie` header character for character, including
the absence of `Domain`; prove login never returns CSRF; prove CSRF bootstrap requires
the exact origin and a live session; and prove logout calls authentication and
revocation before it clears the cookie. Negative tests preserve the cookie after a
wrong CSRF value or database failure, treat an unconfirmed revocation as an invalid
session, reject hostile verifier/context objects without executing accessors, and
reject both session and OAuth adapters on a default Fastify host.

No route is mounted in `main.ts`, no identity provider or public provisioning API is
chosen, and no Salesforce license is required per collector. ADR 0045 adds the audit
tying the trusted actor to the validated Salesforce `005` user. Privileged
disconnect/rebind, final publisher composition and publish CLI remain under note 34.

The empty login query/body is a security boundary, not a provider-neutral transport.
It excludes SAML HTTP POST binding and OIDC `form_post` response mode from direct use
with this route. A future provider must verify through another injected mechanism or
trigger a separately reviewed route-contract change. ADR 0045 records this
consequence from note 99 without choosing the provider.

## Revisit when

The selected identity provider changes, especially to one requiring a form-post
assertion, session-secret
rotation is operationalized, multiple sessions per actor are needed, or a separate
HTTP host is introduced.
