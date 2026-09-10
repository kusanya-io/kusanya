# Architecture and Phase 0 baseline

The build contract is [the brief](brief.md), especially C1, C2 and C12a. This page
distinguishes the intended product from what Phase 0 implements.

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
