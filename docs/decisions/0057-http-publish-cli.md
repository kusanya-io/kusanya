# ADR 0057: Publish CLI through the mounted service boundary

- Status: Proposed; implementation awaiting independent verification
- Date: 2026-10-29
- Brief sections: C3 defect 16, C5 publish, C8, C11 Phase 1
- Decision owner: Bill Owiti / Cobitech Solutions
- Extends: ADRs 0039, 0046, 0047, 0050 and 0054

## Context

Phase 1 requires publication to be callable from a command line and CI. Kusanya
already has one reviewed publication boundary: a short-lived OIDC identity becomes
an opaque live service session, the session resolves its immutable tenant binding
and current role, and the durable publication route selects the tenant's encrypted
Salesforce connection. A CLI that opened PostgreSQL, decrypted a refresh token or
called the internal publisher directly would create a second credential and tenant
selection path. It could also bypass the attempt ledger that preserves uncertain
Salesforce outcomes.

Command-line secrets have an additional exposure risk. Arguments are commonly
visible to process inspection and job metadata, while environment variables invite
an undocumented second configuration contract. Publication output also needs to
distinguish a known refusal from a transport failure that may have happened after
Salesforce committed.

## Decision

### The CLI is a client of the existing HTTPS composition

`service/src/publish-definition.ts` accepts one exact bounded JSON document on
standard input. It contains only:

- the exact HTTPS Kusanya service origin;
- one short-lived OIDC access token for the Kusanya API; and
- one Salesforce Form Version ID.

There is no tenant, Salesforce org, namespace, refresh token or service database
input. The CLI performs the same four operations as an operator browser:

1. exchange the OIDC bearer token for the hardened opaque host session;
2. obtain the session-derived CSRF token;
3. publish through `POST /api/admin/salesforce/publications`; and
4. revoke the service session through the authenticated logout operation.

The service therefore remains the only component that resolves the actor, current
role, tenant binding, namespace and encrypted Salesforce connection. The existing
attempt ledger is written before OAuth or Salesforce I/O. The CLI imports route
paths and response contracts but has no database, vault, refresh-session or
publisher capability.

The access token is allowed only in the login Authorization header. The opaque
session is allowed only in Cookie headers to the same exact origin. The CLI accepts
no positional argument and does not read a credential from an environment variable.
CI supplies the same bounded document through standard input from its approved
secret mechanism.

### Network and response handling are bounded

The origin must be a canonical HTTPS origin with no credentials, explicit port or
path. Every request disables caching, ambient credentials, referrers and redirects.
A fixed overall deadline bounds the complete sequence; shorter per-request limits
bound login, CSRF and logout, while publication receives the larger part of the
budget. The deadline races the transport independently of abort compliance and
remains active while the response body is read.

JSON responses have fixed byte limits, fatal UTF-8 decoding, exact keys and closed
status shapes. The CLI accepts only the exact hardened session cookie attributes
issued by ADR 0044. Provider messages, URLs, stacks, credentials and unexpected
properties never enter its output.

### Uncertainty is never converted into permission to retry

Known `published` and `rejected` results are returned as bounded machine-readable
JSON. Durable `partial` or `unresolved` results direct the operator to reconciliation.
If the publication request itself has an unrecognised, malformed or transport
outcome, the CLI reports `transport_unresolved` and directs the operator to inspect
publication history. It never recommends or performs an automatic retry.

Logout runs after every publication attempt. Its result is reported separately as
`sessionCleanup: confirmed|unconfirmed`, so a cleanup failure cannot overwrite a
known Salesforce result. The process exits successfully only for a known published
result with confirmed session cleanup. All other results are still written as one
bounded JSON document and use a non-zero exit code. Failures before a safe result
emit only the fixed `Publication CLI failed` message.

If login creates a session but CSRF acquisition fails, the CLI has no safe way to
call the CSRF-protected logout operation. Adding a CSRF bypass only for cleanup would
widen the server boundary. The CLI retains no cookie, and the server-side session
expires under the existing bounded lifetime; this is a known failure boundary, not
a second revocation path.

## Alternatives considered

- Call the internal publisher from a Node command. Rejected because the command
  would need database, keyring and Salesforce OAuth secrets and could bypass the
  durable HTTP attempt boundary.
- Accept tenant, org or namespace flags. Rejected because the live session owns
  tenant selection and the stored connection owns the org and namespace.
- Put the access token in an argument or URL. Rejected because process listings,
  command history, proxies and request logs commonly retain them.
- Read the token from a dedicated environment variable. Rejected because standard
  input is sufficient and keeps one documented secret-input contract for local and
  CI use.
- Retry a failed publication transport automatically. Rejected because a timeout or
  broken response can follow a successful remote commit; only the ledger and
  reconciliation boundary can establish the outcome.
- Treat logout failure as publication failure. Rejected because it would erase a
  known publication result. The two outcomes remain explicit and independently
  actionable.

## Consequences and verification

The CLI makes publication scriptable without creating another tenant, credential or
Salesforce authority path. Unit tests exercise the exact request sequence and
headers, closed response states, partial and uncertain outcomes, cleanup separation,
hostile inputs, cookie attributes, bounded response bodies, accessor/proxy refusal,
credential non-reflection and the compiled executable's stdin-only contract.

This advances note 34's publish-CLI strand. It does not by itself prove the seven
supplied forms publish from a real CI identity (C10.11), or prove portable
validation in stock Collect (C10.12), so the Phase 1 gate is not claimed. Scheduled reconciliation and retention, unlinked Salesforce File
cleanup, privileged retry, disconnect/rebind and the ODK Validate runtime assets
also remain future units. Note 39 remains open.

## Revisit when

Running C10.11, separately running C10.12, selecting the production CI workload identity, adding scheduled
reconciliation, or changing the administrator session and publication contracts.
