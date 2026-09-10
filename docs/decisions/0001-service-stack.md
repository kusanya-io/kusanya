# ADR 0001: TypeScript, Fastify and PostgreSQL for the service

- Status: Accepted (implementation decision; phase gate pending verification)
- Date: 2026-09-10
- Brief sections: C2, C8, C11 Phase 0, C12, C12a
- Decision owner: Cobitech Solutions

## Context

The service must accept OpenRosa requests, deliver Enketo forms, isolate tenants,
persist work before Salesforce calls, and run the same container on Cobitech and
Azure. Salesforce remains the source of truth for forms, mappings and customer
records. Collectors authenticate to Kusanya and never require Salesforce users.
Phase 0 needs a small service that can be built and tested without implementing
later phases. C12 explicitly delegates the language, framework and database choice.

## Decision

Use TypeScript on Node.js 24, Fastify 5 and PostgreSQL 17. Pin direct dependencies
and commit npm lockfiles; review upgrades through pull requests. Use the `pg`
driver and explicit SQL migrations when persistence begins. Use PostgreSQL for
the durable queue in Phase 2, as required by C12a. Do not add Redis or another
queue in Phase 0.

Use a factory to construct the service independently of its listener and database
connection so HTTP and failure handling can be tested in process. `/healthz` checks
process liveness; `/readyz` checks PostgreSQL availability. These operational
endpoints carry no tenant or submission data. Tenant-facing APIs, migrations,
OpenRosa, authentication and Salesforce calls are not implemented in this phase.

## Alternatives considered

- Python/FastAPI is suitable, but TypeScript keeps the service and future LWC
  tooling in the same language ecosystem.
- Java/Spring would share the JavaRosa runtime language but adds operating and
  build overhead for the initial relay. JavaRosa validation can run as a separate
  controlled process when its integration is designed.
- SQLite is useful for local applications but would introduce a different database
  for shared durable queue operations on Azure. PostgreSQL serves both environments.

## Consequences and verification

TypeScript does not validate untrusted input at runtime; each future endpoint must
have explicit validation. PostgreSQL does not automatically isolate tenants: tenant
binding, scoped keys, queries, storage paths and adversarial tests remain mandatory.
Future migrations need an independent one-shot container. Object storage will have
an S3/MinIO driver and an Azure Blob driver behind one interface.

Phase 0 verifies configuration, HTTP probes, database readiness and container builds.
It claims no C10 acceptance tests. C10.14 and C10.15 will verify tenant isolation and
the API-call budget in Phase 2; this ADR does not claim those properties exist yet.

## Revisit when

Supported Node/PostgreSQL versions change, measured resource use exceeds C12a's
budget, or the form compiler demonstrates a justified need for another runtime.
