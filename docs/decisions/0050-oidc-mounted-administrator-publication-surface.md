# ADR 0050: OIDC identity and mounted administrator publication surface

- Status: Proposed; implementation awaiting independent verification
- Date: 2026-10-27
- Brief sections: C1.3a, C2, C5 publish, C8, C11 Phase 1, C12a
- Decision owner: Bill Owiti / Cobitech Solutions
- Extends: ADRs 0041, 0042, 0044, 0047 and 0049

## Context

The administrator session, durable publication route and read-only attempt
presentation were independently verified but deliberately unmounted. Mounting them
requires a stable external identity, complete deployment-secret configuration and a
single composition that cannot accidentally bypass live-session resolution. Bill
approved standards-based OIDC with Microsoft Entra ID as the first provider while
keeping the verifier provider-neutral.

Cloudflare Access headers are staging-specific and can be forged when an origin is
reached outside that proxy. Salesforce authorization is already a separate tenant
connection flow that requires a live administrator session. Neither is used as the
administrator identity boundary.

## Decision

### Accept only a Kusanya-API access token

The browser obtains a short-lived access token for the Kusanya API through its OIDC
client's Authorization Code plus PKCE flow. It sends the token only in the redacted
`Authorization: Bearer` header of the existing empty-body login request. Kusanya
validates RS256 signature, exact configured issuer, exact API audience, expiry,
issued-at time and a five-minute maximum token age against the configured HTTPS JWKS
endpoint. It stores neither the token nor provider claims.

Microsoft Entra ID is the initial supported provider. Issuer, audience and JWKS URI
remain explicit configuration so a customer-hosted standards-compliant provider can
be reviewed without changing the session contract. Common/organizations multitenant
issuer substitution is not accepted: the configured issuer must match exactly.

The internal actor is `oidc:` plus a base64url SHA-256 digest over a domain separator,
the exact issuer, a NUL delimiter and the nonempty `sub` claim. This fits the existing
actor key, does not disclose provider identity in PostgreSQL, and prevents the same
subject text from colliding across issuers. Provisioning remains the authorization
decision: a correctly signed token whose derived actor has no immutable tenant
binding cannot receive a Kusanya session.

### Mount one fail-closed composition

`registerPublicationSurface` accepts the OIDC verifier, session store, encrypted
tenant connection store, attempt store, publisher configuration, pinned ODK Validate
adapter and exact external origin as one exact capability set. It checks hardened
request logging before any route is registered. It constructs one live-session
resolver and supplies that same resolver to both publication adapters after
registering login/CSRF/logout. Request data never selects a tenant.

`main.ts` now reads every required setting before opening PostgreSQL, constructs one
pool and one set of tenant stores, and passes the complete surface to `createApp`.
Missing identity, session, encryption, Salesforce OAuth, timeout or validator
configuration prevents startup. The service keeps no default identity and never
falls back to health-only mode in production composition.

The ODK Validate 1.20.0 jar and Java executable remain hash/path checked by the
reviewed process boundary. They must be present at absolute paths in the eventual
service image; this unit does not approve a host-path mount or deploy an image.

### Publish the actual HTTP contract

`docs/openapi.yaml` now documents login, CSRF bootstrap, logout, publication and
attempt presentation. The attempt response has exactly six fields and the same seven
fixed operator statuses produced by `PublicationAttemptStore`. The OpenAPI enum is
documentation, not a second runtime producer; the store mapper remains the sole
producer, preserving note 104's boundary.

## Consequences and verification

The real application can now reach the reviewed routes only when all runtime guards
are present. Tests replay origin, body/query, cookie, CSRF and revoked-session attacks
through `createApp`, prove a forged tenant header has no effect, reject an unhardened
Fastify host before routes exist, and remove each composition capability and each
environment setting in turn. OIDC tests use a real generated RSA key and JOSE
verification, with wrong issuer, audience, age, subject and HTTPS configuration
collapsing to one fixed error.

The access token is a sensitive bearer credential even though it is short-lived.
Automatic request logging stays disabled, the authorization header stays redacted,
errors never reflect token/provider data, and TLS is mandatory at ingress.

Because this unit makes the administrator routes reachable, it also updates the
exact Fastify pin from 5.12.3 to the security-patched 5.12.7 and refreshes affected
transitive `fast-uri` resolutions. The hardened-logging guard and unsafe-host
negative controls are rerun against 5.12.7 rather than assuming its internal
controller shape stayed compatible. The production dependency audit reports no
known vulnerability after the update.

This advances note 34 through external identity and mounting. It does not add the
browser operator UI, self-service actor/tenant provisioning, pagination, retention,
scheduled reconciliation, privileged retry, disconnect/rebind or publish CLI. It
does not claim C10 acceptance, publish readiness or Phase 1 completion. No collector
receives or needs a Salesforce licence.

## Revisit when

Adding another OIDC issuer, multitenant Entra consent, an operator UI, automated
provisioning, validator assets to the release image, session-secret rotation,
privileged connection lifecycle or the CLI publication channel.
