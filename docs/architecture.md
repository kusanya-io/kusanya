# Architecture and initial Phase 1 foundation

The build contract is [the brief](brief.md), especially C1, C2 and C12a. This page
distinguishes the intended product from the implemented foundation.

## Intended ownership

| Component                  | Responsibility                                                                | Source of truth                          |
| -------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------- |
| Salesforce package         | Authoring, forms, mappings, jobs, collectors, submissions, Apex record writes | Customer Salesforce org                  |
| Kusanya service            | Collector authentication, tenant binding, OpenRosa, durable relay, API usage  | Customer service PostgreSQL database     |
| Stock ODK Collect          | Offline form entry and retry on Android                                       | Durable device drafts until acknowledged |
| Enketo                     | Browser rendering of the same published XForm                                 | Published Salesforce form version        |
| Future Kotlin/JavaRosa app | Rich task list and device workflow in Phase 6                                 | Same service contract                    |

The service connects once per tenant as a least-privileged Salesforce integration
user. A tenant is one org; sandbox and production are distinct tenants. Collectors
are Kusanya identities, with no Salesforce licence or sharing-rule requirement.
Never trust a client tenant header or a submitted school Id as authorization.

The service will store work durably before contacting Salesforce and acknowledge
the client only after Salesforce commits. ODK instance Ids provide idempotency;
mapping configuration supplies object/field names, references and collector stamps.
The Apex engine owns transactional record writes. Bulk transaction sizing and the
API-call budget require a Phase 2 ADR and tests before implementation.

## Implemented in Phase 0

- A TypeScript/Fastify service skeleton with liveness and database readiness probes,
  environment validation and tests. No collector, tenant, form or submission API.
- An SFDX source tree, a scratch definition, minimal Apex smoke tests and an explicit
  85% coverage gate for actual test results.
- GitHub build/lint/test workflow and a separate controlled Salesforce validation
  path. No CI deployment to Cobitech or Azure.
- A reserved mobile directory and decision/verification documentation.

There is no product database schema yet. See [data model status](data-model.md),
[OpenAPI](openapi.yaml), [OpenRosa status](openrosa.md) and [threat model](threat-model.md).

## Initial Phase 1 source

The model slices add Folder, Form, Form Version, Question, Choice List, Choice and
Skip Rule metadata, model-only permission sets, declarative validation and derived
identities. Question parent scope distinguishes once-only siblings from repeat
children; Hint and Author Notes are separate fields. Integrity triggers reject
invalid trees/references/ownership without exposing definition data. Stored skip
conditions are not yet compiled. These slices expose no form/publish API or
collector delivery path. C10 tests 10 and
12 remain unimplemented, not represented by source/smoke tests.

Private definition ownership still blocks cross-owner integration/supervisor reads.
ADR 0011 records a future object-scoped read-all policy, not a current permission
grant. A reviewed implementation with effective-access tests must precede any
Phase 2 definition reader. Read access, publishing write authorization and collector
task/tenant authorization remain distinct boundaries.

Bill's Option 2 permits unnamespaced development while the `ksny` Dev Hub link is
blocked. Source stays namespace-local with an empty project namespace. The pure
`createSalesforceNames(prefix)` service helper qualifies explicitly Kusanya-owned
object/field/relationship names, preserves explicit customer/standard/foreign target identifiers and builds
namespace-aware Apex REST paths. The deployment default is
`SALESFORCE_NAMESPACE_PREFIX`, not tenant identity or authorization; future tenant
connections and CLI/compiler/mapping adapters must supply their own configuration.
Synthetic empty/`ksny__` fixtures do not prove actual namespaced behavior. Linking
is required before packaging or namespaced claims, and a namespaced suite must run
as soon as the link works, before the next phase gate (ADRs 0006, 0008, 0009).

## Environments

Development and staging run only on `cobitech-edge`, in `kusanya-dev` and
`kusanya-staging`, each with its own network, PostgreSQL, object store, Enketo and
service. Do not share website volumes or containers. Start the complete staging
project at a total budget of 3 CPU cores and 4 GB RAM, with limits per container.
Private development uses Tailscale; a maintainer-approved staging hostname uses the
existing Cloudflare Tunnel. Production uses Azure Container Apps, Azure Database
for PostgreSQL and Azure Blob Storage. The HP server cannot host production tenants.

The service container is portable and reads settings from the environment. Future
storage drivers implement S3/MinIO and Azure Blob behind one interface. Migrations
will run as a one-shot container. Approved deployment work must include rotated logs,
health checks, backup/restore verification and measured upload bandwidth.
