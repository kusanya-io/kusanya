# Data model status

Phase 0 creates no application objects or database tables. The model in brief C4
remains the design contract; this page does not claim it has been deployed.

Salesforce will own form/version/question trees, choices and skip rules, metadata
mappings, jobs/tasks/prefill, assignment groups, collectors, submissions/answers,
scoring and operational audit records. Every future object and field must carry a
description. Target customer objects and fields are mapping data, never constants
hard-coded from the Splash seed.

PostgreSQL will hold tenant connections, hashed collector credentials, durable relay
state and API-use counters. Tenant-scoped keys, uniqueness, migration rollback and
retention constraints will be designed and tested before adding the first tables.
Salesforce refresh credentials must be encrypted at rest with rotatable keys.

No credentials or raw production seed records may become automated test fixtures.
