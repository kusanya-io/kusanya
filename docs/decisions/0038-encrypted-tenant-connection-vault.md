# ADR 0038: Encrypted tenant connection vault

- Status: Proposed; implementation awaiting independent verification
- Date: 2026-10-16
- Brief sections: C1.3a, C2, C4 Tenant Connection, C8, C11 Phase 1, C12
- Decision owner: Cobitech Solutions
- Extends: ADRs 0001, 0003, 0008, 0025 and 0036

## Context

ADR 0036 composes one publication attempt once it receives an exact Salesforce
instance origin and a capability that supplies fresh access tokens. It intentionally
cannot select a tenant or persist a credential. ADR 0037 supplies the last
Salesforce record-access prerequisite, so note 34 now remains open only for tenant
connection selection, encrypted credential persistence and rotation, and the
publish CLI.

The brief requires an administrator to connect each Salesforce org once, sandbox
and production as separate tenants, while the service protects a refresh token or
JWT certificate at rest with a rotatable key. Salesforce currently recommends its
web-server authorization-code flow with PKCE for server applications, recommends
External Client Apps for new integrations, and supports renewed sessions through
refresh tokens. A JWT bearer grant would require separate certificate and username
provisioning in each tenant and does not implement the brief's administrator
connection flow.

The service has PostgreSQL connectivity but no product schema or migration runner.
Adding the first table therefore also requires a repeatable migration boundary,
without making service startup mutate the database implicitly.

## Decision

### Select authorization code with PKCE and a refresh token

The later administrator connection route will use Salesforce's OAuth 2.0 web-server
authorization-code flow with PKCE and request refresh-token access. New deployments
use an External Client App; an existing compatible Connected App may use the same
protocol contract. The callback, state/PKCE transaction, token exchange, client
secret configuration, refresh transport and administrator authorization are not
implemented in this unit.

Persist the resulting refresh token, never an access token. Store the authorization
origin separately from the returned instance origin so a sandbox, production org
or approved My Domain can refresh through the same origin that issued the grant.
Both must be exact HTTPS Salesforce origins without credentials, paths, ports,
queries or fragments.

### Bind one case-safe org identity to one tenant

`tenant_connections` uses the service tenant UUID as its primary key and a unique
18-character Salesforce Organization ID. A 15-character ID is converted to the
checked 18-character form; a supplied 18-character ID must already have the correct
checksum. This prevents case aliases or two service tenants from silently claiming
the same org. Reconnecting a tenant may replace the credential only when the org ID
is unchanged. Deliberate tenant-to-org rebinding needs a later privileged disconnect
and reconnect operation rather than an upsert side effect.

The row also stores the exact instance origin, authorization origin and that
connection's validated package namespace prefix. Later callers must select a row
from trusted tenant authentication; no request header, Salesforce record ID,
instance URL or global namespace default is tenant authority.

### Encrypt with an authenticated, rotatable envelope

Encrypt each refresh token with AES-256-GCM, a fresh cryptographically random
96-bit nonce and a 128-bit authentication tag. Additional authenticated data binds
the ciphertext to envelope schema 1, the tenant UUID and the normalized Salesforce
org ID. Copying a ciphertext to another tenant or org therefore fails authentication.
The database stores only the key ID, nonce, ciphertext and tag in canonical base64.
Errors are fixed classifications and never include credential, key, database or
provider values.

The encryption keyring is injected from deployment secrets through
`TENANT_CREDENTIAL_ACTIVE_KEY_ID` and `TENANT_CREDENTIAL_KEYS`; no encryption key is
stored in PostgreSQL or committed. At most eight 32-byte keys may be present during
rotation. New writes use only the active key. Existing rows remain readable while
their old key is present and can be conditionally rewrapped under the active key;
the old key is removed only after every row is rewrapped and verified. Encryption
rewrap does not increment the Salesforce credential version. Reauthorization or
Salesforce refresh-token rotation replaces the credential atomically and does.

The returned connection object exposes the secret only through a non-enumerated
`getRefreshToken` capability. Serialization of the connection or encrypted envelope
cannot include plaintext. ADR 0039 consumes the capability inside one bounded,
PostgreSQL-serialized token request and does not log or cache the returned string.

### Apply checksum-pinned migrations explicitly

`npm run migrate` applies migrations under a PostgreSQL transaction and advisory
lock, records a SHA-256 checksum for each migration and refuses drift. It is an
explicit one-shot operation; the HTTP service does not create or modify schema at
startup. The first migration creates only `tenant_connections` and the migration
ledger. It creates no collector, submission, queue or Salesforce record.

## Consequences and verification

Unit tests must prove nondeterministic encryption, authenticated tenant/org binding,
malformed envelope and hostile-object refusal, canonical key parsing, secret-free
errors, old-key read and active-key rewrap. Store tests must prove exact tenant-keyed
queries, parameterized ciphertext persistence, case-safe org normalization,
untrusted-origin/namespace refusal and absence without fallback. Disposable
PostgreSQL integration must apply the migration twice, round-trip only encrypted
credentials, replace one credential with a monotonic version, rewrap without a
credential-version change, reject a second tenant for the same org and leave the
other tenant absent.

This unit advances note 34 through durable encrypted credential storage and a
decided OAuth grant. ADR 0039 later adds internal tenant selection and refresh-token
exchange/rotation. Administrator OAuth routes, transient state and PKCE storage,
trusted HTTP authentication, final publisher composition and CLI publication remain.
Note 39 remains open. This unit adds no HTTP product endpoint,
Salesforce metadata, connected/external client app, workflow, harness, policy,
Enketo/Collect behavior, submission data or C10.14 claim. It is not a Phase 1 gate.

## Revisit when

The OAuth callback is implemented, a privileged disconnect/rebind workflow is
designed, Azure Key Vault or another managed key service replaces environment-injected keys, or tenant
row volume requires a resumable key-rotation job.
