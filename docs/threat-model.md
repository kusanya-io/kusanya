# Initial threat model

Scope: design risks from brief C8 plus the Phase 0 repository, CI, container and
operational probes. This is a baseline to extend at every phase gate.

## Assets and boundaries

Assets include tenant Salesforce credentials, collector credential hashes, raw
submissions/media, customer records, signing/deployment keys and CI credentials.
Boundaries are device/browser to service, service to PostgreSQL/storage, service to
Salesforce, PR code to CI secrets, and Kusanya containers to other Cobitech workloads.

| Threat                                              | Required control                                                                              | Verification and current status                                                                                                                                                                                               |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Forged tenant identity or cross-tenant query        | Bind verified credentials to tenant; tenant-scoped queries/keys/storage                       | ADRs 0042-0043 resolve every opaque session through an immutable actor-to-tenant binding and one tenant-wide org/origin/namespace tuple; external identity/provisioning composition and C10.14 remain                         |
| Duplicate/partially delivered submission            | Durable queue; unique instance Id; idempotent Apex writes; explicit retry state               | C10.5/C10.8; not implemented                                                                                                                                                                                                  |
| Tampered Task target                                | Authorize Task and stamp server-resolved target; never trust prefill                          | C10.3; not implemented                                                                                                                                                                                                        |
| Credential theft or log leakage                     | KDF for collector passwords, encrypted tenant secrets, environment injection, redacted logs   | ADRs 0038-0044 encrypt refresh tokens, store only OAuth/session digests, expose fixed errors, and refuse browser adapters unless automatic request logging is disabled; collector credentials remain                          |
| OAuth callback replay, wrong-org or unaudited grant | Expiring single-use state, PKCE, signed identity, expected-org binding and atomic actor audit | ADRs 0040-0045 consume state once, verify signed identity and org, bind callback to the exact still-live initiating session, and commit credential plus append-only actor/`005` audit together; the adapter remains unmounted |
| Untrusted XML, media or author expressions          | Size/depth limits; reject external entities; safe filenames; constrained validation runtime   | Design and negative tests required in Phase 1/2                                                                                                                                                                               |
| Anonymous link abuse/replay                         | Expiry, rate limits and atomic single-use enforcement                                         | C10.13 in Phase 3                                                                                                                                                                                                             |
| Integration privilege or API exhaustion             | Least privilege, publish-time checks, batching/budget and per-tenant limits                   | C10.9/C10.15; not implemented                                                                                                                                                                                                 |
| Malicious public PR stealing CI credentials         | Secret-free PR jobs; reviewed commit approval before credentialed scratch-org run             | Phase 0 workflow review and trusted-run procedure                                                                                                                                                                             |
| CI or container compromises host                    | GitHub-hosted runners, minimal permissions, pinned actions, nonroot service image             | Phase 0 checks; no self-hosted runner                                                                                                                                                                                         |
| Kusanya starves production website                  | Separate networks/volumes, per-container limits, rotated logs                                 | C12a deployment review before server changes                                                                                                                                                                                  |
| Loss of durable relay data                          | Encrypted backup, retention and isolated restore verification                                 | Add service volumes/runbook in approved deployment work                                                                                                                                                                       |

## Phase 0 residual risks

Readiness exposes whether the database is reachable; it must not disclose a URL,
query, stack trace, tenant, secret, or driver error. Health checks are not a security
boundary. TLS terminates at approved infrastructure in deployed environments.

The repository contains supplied production-derived seed material. Do not copy it
to service images, test logs, public CI artifacts, or new fixtures. Tests use
synthetic data. Secrets belong in approved secret stores, never in Git.

Credentialed Salesforce validation requires a maintainer to inspect the exact commit
and approve its execution. Approval is not automatic security analysis: test code can
use any credential available to its job. Keep Dev Hub credentials restricted to a
dedicated nonproduction validation context and rotate/revoke on suspicion.

ADRs 0041-0045 wrap the one-time OAuth protocol in unmounted Fastify adapters and a
concrete internal session store. Only a live digest-matched session supplies an
immutable actor binding and the one org/origin/namespace tuple owned by its tenant;
provisioning and routing enforce the same namespace grammar. Start requires
exact-origin CSRF;
callback requires an HMAC binding to the exact initiating session, clears its browser
cookie on every outcome and refuses after logout, replacement or expiry before state
consumption. PostgreSQL stores no raw session or CSRF value and is checked on every
request. The callback now commits the encrypted connection and an append-only event
tying the live trusted actor to the signed Salesforce `005` identity in one database
transaction; a mismatched actor rolls both back. The external identity verifier,
approved provisioning workflow and secret wiring remain under note 34. Login issues only a hardened
host cookie, CSRF is released only through a live exact-origin session, and logout
revokes PostgreSQL before clearing the cookie. Both adapters reject a host whose
actual Fastify controller permits automatic request logging, closing note 94.
