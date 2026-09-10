# Kusanya

Kusanya (Swahili: to gather) is an open-source field data collection platform for Salesforce. Administrators design forms inside Salesforce, collectors run them offline on Android through the ODK XForms standard or online in a browser, work is assigned as Jobs and Tasks tied to Salesforce records, and every submission is written back into Salesforce as records of any object, with photos attached to the records they belong to.

Two things set it apart from the products it replaces:

- **No Salesforce licence per collector.** Kusanya connects to each org once, as an integration user. Collectors log in to Kusanya, never to Salesforce.
- **One form, offline and online.** The same published form runs on a phone without signal and in a browser from a shared link, and both submit through the same mapping.

## Status

Pre-alpha, Phase 0 scaffold; independent verification is pending. The operational
service and Salesforce smoke tests are foundations, not a working collection product.
No C10 product acceptance tests are implemented yet. The build contract is
[docs/brief.md](docs/brief.md), with the review protocol in
[docs/verification.md](docs/verification.md). See [architecture](docs/architecture.md),
[threat model](docs/threat-model.md), [roadmap](docs/roadmap.md) and
[decisions](docs/decisions).

## Repository layout

| Folder        | What it holds                                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| `salesforce/` | The Salesforce package (SFDX source): objects, Apex, Lightning components, permission sets                           |
| `service/`    | The multi-tenant service: OpenRosa endpoints, Enketo hosting, Salesforce connection, ingestion relay                 |
| `mobile/`     | The Android app on the ODK JavaRosa engine (phase 6)                                                                 |
| `seed/`       | Reference material: the schema of the product being replaced and a worked example of a real form, job and submission |
| `docs/`       | Brief, architecture, data model, API contracts, verification protocol, decisions                                     |

## Built on

The client architecture uses ODK XForms, ODK Collect, JavaRosa, Enketo and ODK
Validate. Exact upstream releases and their licences will be checked before each
integration. The Phase 0 service uses Node.js 24, TypeScript, Fastify 5 and PostgreSQL 17. Kusanya's original code uses Apache-2.0 across all three components (ADR 0002).
See [dependency licences](docs/licences.md).

## Installing

No installable package or mobile release exists. The brief targets a versioned
package install link and a source-deploy route. Package creation is deferred pending
the C12 packaging decision; no package Id or registered namespace is claimed.

For the scaffold's source-deploy route, follow [salesforce/README.md](salesforce/README.md)
for the builder-only development org and reviewed fresh CI verification. Reuse the
development org for iteration; its output is not verification evidence. For service
builds, tests and container commands, see [service/README.md](service/README.md).
Build commands are not an authorization to deploy an environment.

Development and staging services belong on Cobitech's `cobitech-edge` server in
separate Compose projects. Production belongs on Azure. Phase 0 deploys to neither.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and
the verification protocol. Work on a branch, identify the brief sections and tests
in the PR, and wait for independent review. Maintainers merge; builders do not.

## Name and trademark

Kusanya is the name of this product and belongs to Cobitech Solutions. The code is free to use, modify and redistribute under its licence; forks that are distributed to others should use a different name.
