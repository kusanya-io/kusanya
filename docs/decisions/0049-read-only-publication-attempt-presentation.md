# ADR 0049: Read-only publication-attempt presentation

- Status: Proposed; implementation awaiting independent verification
- Date: 2026-10-22
- Brief sections: C1.3a, C2, C5 publish recovery, C8, C11 Phase 1
- Decision owner: Cobitech Solutions
- Extends: ADRs 0044, 0047 and 0048

## Context

ADRs 0047 and 0048 preserve uncertain publication outcomes and classify the cases
that have exact remote evidence. Those facts are visible only in PostgreSQL. A
retention policy or privileged retry should not be designed before an operator can
see which attempts require judgement, but a presentation boundary must not become a
second way to reconcile, retry, publish or delete.

## Decision

Add an unmounted `GET /api/admin/salesforce/publication-attempts` adapter. It uses
the same opaque administrator session, exact configured origin and session-derived
CSRF token as the publication route. Request bodies and query parameters are
refused. Tenant, actor, expected org, authorization origin and namespace come only
from the decoded live session; request headers cannot select a tenant.

The store performs one bounded `SELECT`, returning at most the newest 100 rows. Its
join rechecks the complete actor/tenant provisioning tuple. The projection contains
only attempt ID, Form Version ID, outcome, reconciliation status and timestamps.
It does not select credentials, provider data, actor or org identifiers, package
digests, ContentVersion IDs, failure codes or request counts.

The HTTP response exposes only attempt ID, Form Version ID, three timestamps and a
fixed operator status. A response schema strips any extra property supplied by a
misbehaving store. Unresolved `started` and `partial` rows are presented as
`human_judgement_required_unresolved`; an `indeterminate` resolution is presented as
`human_judgement_required_indeterminate`. Neither is called failed or pending and
neither authorizes retry. Known terminal and reconciled evidence uses fixed statuses:
`published`, `rejected`, `published_confirmed`, `unlinked_artifacts_confirmed` and
`artifacts_missing_confirmed`.

The adapter's dependency surface is only authentication plus
`listForOperator`. It imports neither the publisher nor the reconciler and exposes
no mutation method. Storage failures become a fixed unavailable response. Global
`Cache-Control: no-store` and hardened request logging remain mandatory. Production
remains health-only until the separately approved external identity and deployment
composition exists.

## Consequences and verification

This is a visibility boundary, not a retention policy, scheduler, resolution action,
privileged retry or UI. Fixed newest-100 delivery deliberately avoids user-controlled
pagination until an operator interface has a reviewed cursor and retention contract.

Independent verification should provision two real tenants and prove cross-tenant
absence; mutate session, origin and CSRF inputs; inject extra response properties;
feed every legal and contradictory ledger state; and prove that the route can reach
only one tenant-scoped `SELECT`. It should inspect source imports and registered
methods rather than infer read-only behavior from test intent.

No Salesforce metadata, permission, sharing, workflow, harness, package, namespace
or dependency changes are made. No C10 acceptance test, publish-ready state or
Phase 1 completion is claimed. Note 34 remains open for retention/deletion,
scheduled reconciliation, privileged retry, external identity/deployment,
provisioning and connection lifecycle, and the publish CLI. Note 39 remains open.

## Revisit when

Adding pagination, operator UI, retention/deletion, scheduled reconciliation,
privileged retry, deployment mounting or another publication channel.
