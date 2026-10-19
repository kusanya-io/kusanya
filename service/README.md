# Kusanya service

Phase 0 supplies an operational scaffold: TypeScript on Node.js 24, Fastify 5,
and PostgreSQL 17. Tenant authentication, OpenRosa, submission storage, Salesforce
mapping and the durable queue belong to later phases. No collector Salesforce
account is created or required. See the architecture and ADRs in `../docs/`.

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
provisioning. A concrete external identity verifier, approved provisioning workflow,
deployment wiring, final publisher composition and the publish CLI remain.

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

The internal ADR 0040 authorization boundary creates a short-lived Salesforce
authorization URL and completes its callback. ADR 0041 adds an unmounted HTTP route
adapter that can be registered only with a concrete trusted administrator-session
verifier. It stores only a state digest and trusted tenant/org metadata in
`tenant_oauth_transactions`; the PKCE verifier is derived under a deployment secret.
The callback consumes state once before exchanging the code and only then writes the
encrypted refresh token through `TenantConnectionStore`. The adapter accepts neither
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

`main.ts` does not register these routes yet. The external administrator identity
verifier, approved provisioning workflow, cookie/login composition and deployment
secret wiring remain required; the health-only OpenAPI description therefore stays
accurate. A future composition must also persist an audit tying its trusted actor to
the validated Salesforce `005` user returned by the authorization boundary and must
preserve the service's query/cookie-safe logging policy.

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
the namespace becomes a path segment without its trailing `__`. Future CLI
publish, XForm bindings and mapping adapters must reuse this boundary and keep
question/XPath names separate from Salesforce names. They are not implemented yet.

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
