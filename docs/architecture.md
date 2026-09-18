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
Skip Rule, Mapping and Field Mapping metadata, model-only permission sets, declarative validation and derived
identities. Question parent scope distinguishes once-only siblings from repeat
children; Hint and Author Notes are separate fields. Integrity triggers reject
invalid trees/references/ownership without exposing definition data. Stored skip
conditions can now be compiled from a portable in-memory definition. These slices expose no form/publish API or
collector delivery path. C10 tests 10 and
12 remain unimplemented, not represented by source/smoke tests.

The first [compiler unit](compiler.md) is a pure TypeScript module inside the
service, as permitted by C2 (ADR 0014). It accepts a strict, bounded neutral bundle,
validates question/choice/skip-rule structure, parses a limited XPath grammar,
checks repeat-relative references and dependency cycles, and emits deterministic
ODK XForm XML. An explicit output allowlist excludes Author Notes and Regex Example;
Hint remains collector-facing. There is no Salesforce reader/adapter, persistence,
HTTP route, publishing call or permission change. Salesforce remains the authoring
source of truth; this neutral input is not a replacement database.

A successful result is marked `validation: structural-only`, not publish-ready.
The optional offline ODK Validate probe covers synthetic definitions. Every real
publication still needs JavaRosa validation, target/access checks and immutable
storage. Dynamic count reduction is client-specific: JavaRosa retains old
instances, while the Enketo probe removes trailing answered rows. A consistent
publication/ingestion policy still needs a decision and tests. Unsupported
configured options fail explicitly rather than being silently removed. No Collect,
Enketo or C10 compatibility claim is made from XML generation alone.

The [reviewer-only print view](print-view.md) shares the compiler's prepared
graph and expressions, and adds a strict supplied-mapping summary (ADR 0016).
It emits static escaped HTML with fixed print CSS and no external resources.
Author Notes and regex examples are intentionally visible to reviewers, unlike
collector XML. The prepared graph and print document must never be used as
collector responses. No endpoint, Salesforce access, authorization, mapping
execution or publication approval is added. Future hosted reviewer delivery
requires a separate access-control design; a document's CSP is not that boundary.

The [authoring interchange unit](interchange.md) adds a versioned JSON envelope
around the supported definition and mapping snapshots (ADR 0017). An XLSForm-style
table profile projects that source into recognizable rows and retains the complete
source in an extension table. Import regenerates all tables and refuses conflicting
edits. ADR 0018 adds a strict XLSX wrapper with literal text cells and bounded ZIP/XML
decoding. These are author-only snapshots, not an additional source of truth, a
general edited-XLSForm importer, a Salesforce import or a publication channel.
Exact Kusanya XML round trips do not establish third-party XLSForm conversion
equivalence or C10.10. Collector output continues through the compiler allowlist.

Mapping definitions store a reference/main/repeat dependency graph and explicit
question-or-constant field sources. They preserve once-only answers shared across
repeat mappings and portable customer target identifiers. They do not execute
transforms, validate target permissions or write/stamp customer records (ADR 0013).

The first publication-boundary unit validates those mappings against a strict,
normalized target-schema snapshot (ADR 0019). It checks object and field existence,
integration-user query/create/update access, record-type availability, parent
lookup targets, unique external IDs and trusted-stamp collisions, while warning on
non-unique reference matching. The caller remains responsible for obtaining a
fresh Describe snapshot as the integration user. This pure function performs no
Salesforce I/O, authorization, artifact storage or publication and is labelled
`target-schema-only`; saved Match Status is never evidence.

The field-compatibility unit extends that normalized snapshot and pure result
with field datatype, nullability and base picklist compatibility (ADR 0020). It
checks all stored transform names against their source and target categories and
requires every possible authored value for a restricted picklist to be active.
It still performs no transform, Salesforce call or publication. Value-size and
record-type-specific picklist rules remain with the future Describe adapter and
executable publisher.

The Describe normalization boundary (ADR 0021) converts fresh, dependency-injected
integration-user REST Describe responses into that strict snapshot. It performs one
uncached request per distinct target object, copies only required metadata, treats
FLS-hidden fields as absent and fails closed on hostile, mismatched or oversized
responses without leaking provider data. The concrete authenticated REST transport,
and refusing publisher remain future units, so note 34 is not closed.

The publication preflight boundary (ADR 0022) composes shared form preparation and
XForm compilation with strict mapping decoding, deterministic mapping-derived target
acquisition, the fresh Describe normalizer and target validation. It detaches the
validated definition and mappings before its first asynchronous request, so caller
mutation cannot change what is validated after Describe returns. Success provides a
frozen in-memory `publication-preflight-only` result with XML, its SHA-256 digest,
target names, warnings and exact request count. It is not immutable stored
publication state and adds no OAuth transport, JavaRosa execution, transform
execution, persistence, route or CLI publication.

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
