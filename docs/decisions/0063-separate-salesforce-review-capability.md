# ADR 0063: Separate Salesforce definition-review capability

- Status: Accepted; independently verified and merged in PR #125
- Date: 2026-11-02
- Brief sections: C2, C4 sharing and permissions, C5 print view, C8 least privilege, C11 Phase 1
- Decision owner: Cobitech Solutions
- Extends: ADRs 0034 and 0062

## Context

ADR 0062 correctly separates reviewer and publisher authority inside the service,
but its definition snapshot calls the Apex resource created by ADR 0034. That
resource still checks `Publish_Kusanya`. Consequently a Salesforce principal
cannot receive snapshot access without also receiving publication-commit authority.
The service code has no write path from review, but the Salesforce authorization
boundary should enforce the same separation rather than trusting only the service
process. Claude recorded this as note 135.

Kusanya must not require a Salesforce licence per collector. This decision affects
only the tenant's service integration principal and creates no collector user,
permission assignment, group or queue.

## Decision

Add the unlicensed `Review_Kusanya_Definition` custom permission and require it in
`DefinitionSnapshotResource` before reading the request body. `Publish_Kusanya`
continues to guard only `PublicationCommitResource`; `Import_Kusanya_Definition`
continues to guard only `DefinitionImportResource`. The full
`Kusanya_Integration` permission set receives all three because its principal
supports the complete authoring and publication workflow.

Add a separate capability-only `Kusanya_Reviewer_Integration` permission set. It
contains only class access to `DefinitionSnapshotResource` and the new review
custom permission. It contains no object/field grants, import or commit class,
publish/import permission, setup permission, user assignment or target-object
access. Pair it with the existing read-only `Kusanya_Supervisor` permission set
when a tenant wants a review-only service identity. The latter supplies user-mode
read access across the exact nine definition objects while the new permission set
supplies only the API capability.

Provision that identity on the Salesforce `Minimum Access - Salesforce` profile,
not `Standard User`, before assigning the two permission sets. Effective authority
is profile plus permission sets; a broader profile could independently grant access
to customer standard or target objects and would invalidate the review-only claim.

Kusanya still stores one Salesforce connection per tenant. A tenant choosing the
review-only pairing can render definitions but cannot publish through that same
credential. A tenant using full `Kusanya_Integration` can do both. Supporting
simultaneous separate reviewer and publisher credentials for one tenant would
require a separately reviewed multi-connection model and is not implied here.

## Consequences and verification

Hosted Apex must prove a `Minimum Access - Salesforce` user assigned
`Kusanya_Supervisor` plus `Kusanya_Reviewer_Integration` can read a cross-owner
definition snapshot while
`FeatureManagement` reports review true and publish/import false. Existing tests
continue proving ordinary and Supervisor-only users are refused before body
access, while the full Integration principal succeeds. Static tests pin the exact
top-level permission-set element whitelist and class/custom-permission inventories,
and prove the reviewer capability set contains no object, field, user, publish or
import grant. This answers notes 138 and 139 after independent verification.

This closes note 135 after independent verification. It does not narrow the
service role matrix: administrator, publisher and reviewer roles all deliberately
hold `review_definition`, as note 137 records. Note 136 also remains informational:
the operator opens a detached Blob protected by the embedded meta CSP, not by the
route's HTTP-only framing headers. The OpenAPI contract now lists all seven actual
success response protections.

No collector obtains Salesforce access or a Salesforce licence. No service code,
workflow, CI harness, package, namespace, target-object access or C10 acceptance
claim changes in this unit.

## Revisit when

Supporting multiple Salesforce credentials per tenant, adding another definition
reader, changing the service role model, or allowing any reviewer operation to
write Salesforce or service business data.
