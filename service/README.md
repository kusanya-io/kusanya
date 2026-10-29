# Kusanya service

Phase 0 supplied an operational scaffold: TypeScript on Node.js 24, Fastify 5,
and PostgreSQL 17. Collector authentication, OpenRosa, submission storage,
Salesforce mapping execution and the durable queue belong to later phases. No
collector Salesforce account is created or required. See the architecture and ADRs
in `../docs/`.

ADR 0038 adds a service-internal tenant connection vault and the first product
table. It stores one normalized Salesforce org binding per tenant and only an
AES-256-GCM encrypted refresh-token envelope. Encryption keys remain deployment
secrets and support active-key rewrap; a connection exposes plaintext only through
an internal token capability. ADR 0039 adds a bounded internal refresh adapter and
attempt-scoped access-token capability. Refreshes for one tenant are serialized by
a PostgreSQL row lock across replicas, a rotated refresh token is encrypted and
committed before access is exposed, and the returned org and instance must match the
stored binding. A local rejecting deadline releases that row lock even if an injected
transport ignores its abort signal. ADR 0040 adds the internal one-time OAuth start
and callback protocol. ADR 0041 adds an unmounted HTTP adapter with an injected
trusted-session contract, same-origin CSRF and browser-bound callback state. ADR 0042
adds the internal opaque session issuer, live revocation and immutable actor-to-tenant
provisioning. ADR 0044 adds the browser login/CSRF/logout composition and makes
hardened request logging a runtime prerequisite for administrator adapters.
ADR 0047 adds a live-session and same-origin-CSRF administrator publish
adapter plus a durable tenant-scoped attempt ledger. A partial Salesforce commit is
surfaced distinctly and stores the exact uploaded artifact identities for future
reconciliation; interrupted attempts remain unresolved.
ADR 0048 adds an internal read-only reconciler for those attempt rows. It records
indeterminate, committed, unlinked or artifacts-missing evidence through a one-way
tenant-scoped transition. It cannot publish, upload or delete and exposes no route.
ADR 0049 adds a read-only administrator listing adapter. It returns a
bounded least-data attempt summary under the same live-session, exact-origin and
CSRF controls. Unresolved and indeterminate attempts explicitly require human
judgement; the adapter cannot reconcile, retry, publish or delete. ADR 0050 records
Bill's OIDC/Entra identity decision and mounts login, CSRF, logout, publication and
attempt presentation as one fail-closed production composition.
ADR 0052 adds `GET /admin`, a dependency-free static operator shell over those APIs,
plus administrator lifecycle controls and keyset pagination. The shell embeds no
tenant data, uses no external assets or browser storage, clears the short-lived login
token immediately and renders API data only as text under a hash-pinned CSP. Attempt
pages stay capped at 100, repeat the full tenant authorization join and expose only
an opaque continuation cursor. Initial tenant bootstrap and privileged connection
lifecycle remain operator/deployment work outside these routes.
ADR 0053 adds a server-only first-administrator bootstrap command and authenticated
peer deprovisioning. Bootstrap reads one bounded JSON document from standard input,
has no HTTP route and refuses replay. Deprovisioning keeps the immutable actor binding
inactive, revokes all of its sessions and appends the lifecycle audit atomically;
self-removal, last-administrator removal and cross-tenant removal share one refusal.
ADR 0054 adds three tenant operator roles. `administrator` may invite, deprovision and
change peer roles, authorize Salesforce, publish and view publication history;
`publisher` may publish and view history; `reviewer` may only view history. Login,
CSRF bootstrap and logout remain available to every active role. Authority is loaded
from PostgreSQL on every request, never accepted from a header or cached in the
session, so demotion immediately affects an existing cookie.
ADR 0055 replaces direct browser enrolment with opaque, expiring invitations. A full
administrator issues the role and OIDC subject without learning whether that identity
already exists elsewhere. The raw 256-bit token is returned once, stored only as a
digest and accepted only in the first verified login body. Binding, stored role,
enrolment audit, invitation consumption and the first browser session commit in one
PostgreSQL statement. Pending tokens are revocable; wrong-subject, expired, revoked,
replayed and cross-tenant collisions share one authentication refusal.
ADR 0056 adds database-enforced, administrator-only retention for old safely
terminal publication attempts, with one surviving audit per deletion. ADR 0057 adds
the stdin-driven CLI/CI client of the mounted service publication boundary. It has no
tenant selector or direct Salesforce credential path, and uncertain outcomes require
inspection rather than retry.

Phase 1 also supplies a pure, bounded XForm compiler at `src/compiler/compile.ts`.
It has no HTTP route, Salesforce access or publishing authority. See
[the input contract, unsupported features and offline ODK validation runbook](../docs/compiler.md)
and ADR 0014. `ok: true` means structural compilation only, not publish-ready or
verified Collect/Enketo behavior. Existing unit tests include synthetic compiler,
XPath, output-allowlist and resource-boundary regressions.

The pure `renderPrintView(formInput, mappingInput)` function at `src/print/render.ts`
shares compiler preparation and emits bounded, static reviewer-only HTML. It shows
compiled logic, choices, supplied mappings and separate author annotations. It is
not collector content, a publishing check or an HTTP endpoint. See the
[print contract and synthetic export runbook](../docs/print-view.md) and ADR 0016.
No print/browser dependency is added to the service.

Pure [authoring interchange](../docs/interchange.md) lives in `src/interchange/`.
It exports/imports a strict canonical JSON bundle and a consistency-checked
XLSForm-style table profile, preserving the current compiler definition and
supplied mappings. The source includes author-only annotations. There is no
binary spreadsheet parser, general edited-workbook importer, Salesforce write,
delivery route or new dependency. ADR 0017 records scope and limits.

Optional [client runtime probes](../docs/runtime-validation.md) live in
`scripts/runtime` at repository root, with a separate Node 22 tooling lockfile.
They exercise synthetic forms in Enketo and Collect's pinned JavaRosa engine;
they are not part of the service image or normal CI, and do not prove Collect
app behavior or C10 acceptance. ADR 0015 records the metadata/reload fixes and
the remaining cross-client count-reduction risk.

## Checks

From this directory with Node.js 24 and npm:

```sh
npm ci
npm run lint
npm run typecheck
npm test
```

After `npm run build`, apply the checksum-pinned schema to a disposable or approved
service database as a separate one-shot operation:

```sh
npm run migrate
```

The service never migrates implicitly during HTTP startup.

After migrations, bootstrap a tenant's first administrator only from the service
host with its approved database environment and `ADMIN_OIDC_ISSUER`. Supply the
initial tuple on standard input so it is not placed in process arguments:

```sh
printf '%s\n' '{"subject":"<oidc-subject>","tenantId":"<uuid>","expectedSalesforceOrgId":"<00D-id>","authorizationOrigin":"https://login.salesforce.com","namespacePrefix":""}' | npm run bootstrap-administrator
```

Before deploying migration `0012_bootstrap_uniqueness`, check for damage from the
pre-existing warm-pool race described by issue #108:

```sql
SELECT tenant_id, count(*) AS bootstrap_count
FROM tenant_administrator_lifecycle_audits
WHERE action = 'bootstrap'
GROUP BY tenant_id
HAVING count(*) > 1;
```

No rows is the required result. If rows are returned, stop the deployment, preserve
the audit and binding evidence, and investigate under the approved audited change
process. Migration `0012` deliberately fails and rolls back without choosing a
winner or deleting history. Do not remove duplicate records merely to make the
index build.

Use `https://test.salesforce.com` for a sandbox authorization origin when that is the
tenant's reviewed binding. Use `"ksny__"` only after the namespace is linked and the
namespaced suite has passed. The command has one winner: it refuses if that tenant
already has any administrator or the issuer-derived actor has any binding. It never
repairs, reactivates, moves or replaces an administrator. Do not edit the lifecycle
tables manually; use the authenticated operator interface to remove a peer while
retaining at least one active full administrator. Invite a second trusted
`administrator` promptly after bootstrap: the one-shot bootstrap command cannot
recover an existing tenant whose sole full administrator is unavailable. Deliver
each one-time token to its intended subject out of band. Use the operator interface
to issue or revoke invitations at `administrator`, `publisher` or `reviewer`, or to
change an accepted peer's role; self-change and demotion/removal of the final full
administrator are refused.

### Publish from a command line or CI

ADR 0057 exposes no second Salesforce credential path. The command logs into the
mounted service with a short-lived Kusanya API OIDC access token, obtains the opaque
session and CSRF token, calls the existing durable publication route and logs out.
Build it, then supply one exact JSON document through standard input:

```sh
npm run build
npm run --silent publish-definition < /run/secrets/kusanya-publish-request.json
```

```json
{
  "accessToken": "<short-lived Kusanya API JWT>",
  "formVersionId": "<15-or-18-character Salesforce ID>",
  "serviceOrigin": "https://kusanya.example"
}
```

Protect that input as a secret, never commit it, and never put the access token in
an argument or URL. The service origin is one exact HTTPS origin without a path or
explicit port. The token's verified issuer and subject select the live actor; the
request cannot select a tenant, org or namespace. CI uses the same stdin contract
with its approved workload identity and secret mechanism.

Standard output is one bounded JSON result. Only `published` with
`sessionCleanup: "confirmed"` exits zero. `rejected` is a known validation refusal;
`partial` and `unresolved` require reconciliation; and `transport_unresolved`
requires inspecting publication history before any retry. Cleanup is reported
separately so an unconfirmed logout never hides a known publication result. Failures
before a safe result print only `Publication CLI failed` to standard error.

Only a live `administrator` may run publication-attempt retention from the operator
interface. The request supplies no tenant, cutoff, status or attempt identifier.
PostgreSQL applies the tenant's stored policy (90 days by default, constrained to
30 through 3650) to at most 100 old safe terminal rows and records one surviving
audit for each deletion. Repeat the operation to process another bounded batch.
Started, unresolved, indeterminate and unlinked-artifact attempts cannot be removed
by this operation. Do not edit those states or the retention audit table manually.

Before applying migration `0004_administrator_tenants` to a database created by PR
#77, check the legacy bindings for namespace values that the current canonical rule
will refuse:

```sql
SELECT actor_id, tenant_id, namespace_prefix
FROM tenant_administrator_bindings
WHERE namespace_prefix !~ '^(|[a-z][a-z0-9]{0,14}__)$';
```

If this returns rows, stop the deployment. Confirm the intended canonical prefix
with the tenant administrator, back up the database, and correct every binding for
that tenant together under the approved audited change process before rerunning the
migration. Do not guess, lowercase or otherwise normalize it automatically. The
migration deliberately fails closed and rolls back if a legacy namespace is invalid,
if actors for one tenant disagree, or if two tenants claim one Salesforce org.

The unit suite checks invalid configuration, credential-safe errors, liveness during
database failure, readiness recovery, pool shutdown, HEAD probes and absent business
routes. It also checks oversized bodies (413), malformed JSON (400), unsupported
media (415), and sanitized fallback errors. No C10 product acceptance test is claimed.
From the repository root, `npm run format:check` checks service formatting as well
as shared files; `npm run format` applies the shared Prettier configuration.

For an existing disposable PostgreSQL 17 database, inject `DATABASE_URL`, set
`DATABASE_SSL` for that database, and set `REQUIRE_DATABASE_TESTS=true`, then run:

```sh
npm run test:integration
```

Missing `DATABASE_URL` fails when `REQUIRE_DATABASE_TESTS=true`; otherwise the live
database case explicitly skips. Tests use a real `SELECT 1` through readiness, apply
the checked migrations, write and remove isolated synthetic tenant rows, and check a
real driver's timeout against an unresponsive TCP connection. Never point them at a
customer database.

## Run the scaffold

Copy `.env.example` to `.env`, configure a disposable database, then:

```sh
npm run build
node --env-file=.env dist/src/main.js
```

The listener defaults to `127.0.0.1:3000`; the container uses `0.0.0.0`. GET and
HEAD `/healthz` indicate process liveness; `/readyz` returns 200 for a successful
database query or 503 for failure, without disclosing details. Responses use
`Cache-Control: no-store`. SIGTERM/SIGINT close HTTP and the pool with a ten-second
deadline.

All settings use environment variables. `DATABASE_URL` is required, uses `postgres:`
or `postgresql:`, includes a database name and excludes query strings/fragments.
`DATABASE_SSL=true` verifies certificates. Development/test can explicitly set it
to false; production rejects false. Use `NODE_EXTRA_CA_CERTS` for an approved private
CA. `DATABASE_TIMEOUT_MS` defaults to 3000 (maximum 30000); `DATABASE_POOL_MAX`
defaults to 10 (maximum 100). `PORT` defaults to 3000 and `LOG_LEVEL` to info.
Configuration errors name settings without printing their values. Deployed HTTP
requires the environment's approved TLS ingress.

`TENANT_CREDENTIAL_ACTIVE_KEY_ID` names the key used for new encryption.
`TENANT_CREDENTIAL_KEYS` is a comma-separated keyring of `key-id:base64-key`
entries, each a canonical base64 32-byte key, injected from the environment's
secret store. Keep the prior key during rotation, rewrap every connection, verify
no row still names it, then remove it. These settings are consumed by the internal
vault, not accepted from requests, and no key belongs in PostgreSQL or `.env` under
version control.

The mounted administrator surface also requires `ADMIN_EXTERNAL_ORIGIN`, the exact
HTTPS origin; `ADMIN_OIDC_ISSUER`, `ADMIN_OIDC_AUDIENCE` and
`ADMIN_OIDC_JWKS_URI`; canonical 32-byte `ADMIN_SESSION_SECRET` and bounded
`ADMIN_SESSION_TTL_SECONDS`; bounded `ADMIN_INVITATION_TTL_SECONDS`;
`SALESFORCE_OAUTH_CLIENT_ID` and
`SALESFORCE_OAUTH_CLIENT_SECRET`; all three bounded Salesforce timeout settings;
and absolute `ODK_VALIDATE_JAVA_EXECUTABLE` and `ODK_VALIDATE_JAR_PATH` values.
There are no development fallbacks. Missing or malformed values stop `main.ts`
before it opens PostgreSQL. The committed `.env.example` names every setting but
contains placeholders only.

The internal ADR 0040 authorization boundary creates a short-lived Salesforce
authorization URL and completes its callback. ADR 0041 adds an unmounted HTTP route
adapter that can be registered only with a concrete trusted administrator-session
verifier. It stores only a state digest and trusted tenant/org metadata in
`tenant_oauth_transactions`; the PKCE verifier is derived under a deployment secret.
The callback consumes state once before exchanging the code and only then writes the
encrypted refresh token through `TenantConnectionStore`. ADR 0045 makes that write
atomic with an append-only audit event containing only the live trusted actor, signed
Salesforce `005` user, normalized org and resulting credential version. A later
reauthorization appends rather than overwrites history, and a missing actor binding
rolls the connection update back. The adapter accepts neither
tenant nor expected org from request headers, bodies, queries or callbacks. Start is
a same-origin, session-authenticated POST with session-bound CSRF; callback completion
requires an HMAC browser binding to the exact still-active initiating session and
returns no connection metadata. Real Salesforce provider descriptions are discarded
at the HTTP edge.

`AdministratorSessionStore` issues fresh random sessions only after a stable trusted
actor is provisioned to a tenant whose normalized org/origin/namespace tuple is
stored once for the whole tenant. Multiple approved actors can share that exact
tuple; conflicting tenant context, actor movement and noncanonical namespaces are
refused atomically. The store keeps only a SHA-256 session digest, one live session
per actor, derives CSRF under a deployment secret and checks PostgreSQL on every
request so logout, operator revocation, replacement and expiry are immediate.

`registerAdministratorSessionRoutes` composes that store behind an injected trusted
login verifier. A successful exact-origin login issues
`__Host-kusanya_admin_session` with `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`,
an explicit `Max-Age` and no `Domain`; it returns no CSRF or identity data. A separate
exact-origin authenticated POST returns only the session-derived CSRF token. Logout
requires the live cookie and that token, deletes the database row first and clears
the cookie only after revocation succeeds. The session and OAuth adapters refuse
registration unless the host's actual Fastify log controller disables automatic
request logging, so callback codes, state and cookies cannot enter default request
logs (note 94).

`main.ts` registers these routes only after every ADR 0050 setting validates. The
browser obtains a short-lived access token for the Kusanya API through an OIDC
Authorization Code plus PKCE client and sends it only in the redacted Authorization
header of the empty-body login POST. The service validates RS256 signature, exact
issuer and audience, time bounds and subject through pinned `jose`, derives the
stable actor from issuer plus subject, and persists no identity-provider token. A
missing immutable actor/tenant provisioning row still refuses session issuance.

## Salesforce namespace configuration

`SALESFORCE_NAMESPACE_PREFIX` defaults to empty for Bill's approved unnamespaced
Phase 1 work. A namespaced connection supplies its API prefix, for example
`ksny__`; this does not change Salesforce's project namespace or claim a link.
`readConfig().salesforceNames` exposes an immutable resolver for that deployment
default. Future tenant connections must each call `createSalesforceNames(prefix)`
with their own stored configuration; a request header or global default is not
tenant selection or authorization.

Import the pure helper from `src/salesforce-names.ts` in source, or
`dist/src/salesforce-names.js` after `npm run build` for a future CLI adapter:

```ts
const names = createSalesforceNames(configuredPrefix);
const objectName = names.kusanyaObject('Form__c');
const parentField = names.kusanyaField('Form__c');
const parentRelationship = names.kusanyaRelationship('Form_Version__r');
const childRelationship = names.kusanyaRelationship('Questions__r');
const customerField = names.targetField(configuredTargetField);
const customerRelationship = names.targetRelationship(configuredRelationship);
const restPath = names.apexRestPath(relativeResource);
```

Only the `kusanya*` methods add the prefix: object/field inputs are local `__c`
names, relationship inputs are explicit local `__r` names. Relationship names
must come from the schema/describe; the helper never guesses a child relationship
from a field name. It validates one identifier, not a dotted traversal path.
The `target*` methods validate one API identifier and preserve customer, standard
or foreign-package names exactly. They are not SOQL builders or permission checks.
REST accepts literal relative path segments, not URLs, query strings or escapes;
the namespace becomes a path segment without its trailing `__`. The publish CLI
delegates namespace selection to the tenant-bound service publisher; it does not
accept a namespace input. Future XForm binding and mapping adapters must reuse this
boundary and keep question/XPath names separate from Salesforce names.

Tests use empty and `ksny__` synthetic configurations, parent/child relationship
names, standard/customer/foreign targets, malformed inputs and
interleaved resolvers. They do not contact Salesforce or prove namespaced execution.

The request error handler preserves integer 4xx statuses and returns only
`{"error":"Request rejected"}`. Other unhandled errors return 500 with
`{"error":"Internal server error"}`. Error details, request bodies and URLs are
not reflected. This does not change explicit 404 responses or readiness's 503
dependency status, and does not add POST or OpenRosa routes.

## Containers

From the repository root:

```sh
docker build --target test -t kusanya-service-tests ./service
docker run --rm kusanya-service-tests
docker build -t kusanya-service:phase0 ./service
```

For integration tests, attach a disposable PostgreSQL 17 instance and test container
to the same network, injecting the database environment rather than putting secrets
on the command line:

```sh
docker run --rm --network kusanya-test -e DATABASE_URL -e DATABASE_SSL -e REQUIRE_DATABASE_TESTS=true kusanya-service-tests npm run test:integration
```

That command assumes `kusanya-test` and its disposable database already exist.
GitHub Actions provisions isolated test PostgreSQL. Test and runtime containers use
the nonroot `node` user; runtime contains neither tests nor development dependencies.

Development/staging belong on `cobitech-edge`; production belongs on Azure (C12a).
These commands build images or run disposable tests; they do not provision a hosting
environment. Compose, storage drivers and restore procedures remain future reviewed
work before deployment or ingestion is enabled. The migration runner exists, but
no deployment automation invokes it yet.
