# ADR 0062: Tenant-bound reviewer print delivery

- Status: Proposed; implementation awaiting independent verification
- Date: 2026-11-02
- Brief sections: C2, C5 print view, C8 security, C11 Phase 1
- Decision owner: Cobitech Solutions

## Context

ADR 0016 created a pure static renderer whose successful result is explicitly
`reviewer-only`. Claude note 39 correctly kept that label from becoming an access
control claim: the HTML contains Author Notes, regular-expression examples and
mapping details that must never reach a collector or public route. The existing
operator application now has live tenant-scoped administrator, publisher and
reviewer roles plus an encrypted Salesforce connection, but no production path
to obtain the print document.

## Decision

Mount `POST /api/admin/salesforce/reviewer-print` in the existing hardened
publication surface. The request accepts exactly one Salesforce Form Version ID
in JSON. POST keeps the identifier out of the URL and therefore out of ordinary
request-target logging. It requires the configured exact origin, the shared
host-only administrator-session cookie and that session's derived CSRF token.
The role is loaded from the live binding on every request. Administrator,
publisher and reviewer roles receive `review_definition`; no collector identity,
public path or bearer-token alternative exists.

The adapter selects only the live session tenant's encrypted connection and
checks the complete provisioned tuple: tenant, Salesforce org, authorization
origin and namespace. It exchanges that connection's refresh token for one
short-lived access token and makes one read-only definition-snapshot request.
The response must have the exact versioned shape already consumed by the pure
renderer. Bounded response bytes, fatal UTF-8, exact keys, fixed error codes and
a fetch-independent deadline fail closed. The access and refresh tokens never
enter the returned HTML or an error. This path cannot import the publisher,
attempt store, reconciler or any Salesforce write/commit operation. The shared
session can persist a provider-issued refresh-token rotation; that credential
maintenance is not a definition or publication mutation.

Success is accepted only when the renderer repeats the exact closed result
contract: `ok: true`, `audience: reviewer-only`, `validation: structural-only`,
bounded HTML and warnings. Delivery uses `text/html` with `Cache-Control:
no-store`, the renderer's exact CSP as an HTTP response header,
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, same-origin resource
policy, no-referrer and a restrictive permissions policy. The document retains
its early meta CSP as defense in depth. The operator shell opens the response
through a temporary same-origin-fetched Blob URL and revokes that URL; it never
inserts the author-only document into the operator page.

## Consequences and verification

This closes note 39 only after independent verification. Tests must prove all
three live roles can review, a collector-style bearer request cannot authenticate,
forged tenant headers are ignored, origin/session/CSRF checks run before review,
the stored tenant tuple is exact, the deadline works when transport ignores
abort, response headers are real, and malformed snapshot or renderer contracts
return fixed refusals. The mounted production surface and operator shell must
also expose the path without creating a second credential or mutation path.

The output remains a structural review aid, not publication approval, collector
content, execution of mappings, or a C10 acceptance claim. Printing or saving a
copy leaves the service's cache boundary and is an operator responsibility.

## Revisit when

Adding collector-facing previews, sharing reviewer documents, changing roles,
adding server-side PDF generation, changing the definition snapshot, or allowing
any review operation to mutate Salesforce or the service database.
