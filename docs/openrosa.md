# OpenRosa implementation status

No OpenRosa endpoints are implemented in Phase 0. The health probes are operational
HTTP endpoints and are not an OpenRosa implementation.

Phase 2 must implement and contract-test authenticated `/formList`, `/forms/{id}`,
media manifests/downloads, submission negotiation via `HEAD /submission` and
multipart `POST /submission` against the selected ODK Collect version. The same
published XForm and ingestion path must support Enketo in Phase 3.

Before implementation, record selected ODK/Enketo versions, specification references,
response/status/header rules, durable acknowledgement semantics and compatibility
tests. Unknown form nodes must remain auditable; duplicate instance Ids must never
duplicate mapped records. Authentication and tenant scope come from the verified
credential or link, not a client-supplied tenant header.
