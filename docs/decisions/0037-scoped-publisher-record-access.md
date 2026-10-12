# ADR 0037: Scoped publisher record access

- Status: Proposed; implementation awaiting independent verification
- Date: 2026-10-12
- Brief sections: C3.16, C4 sharing and permissions, C5 publish, C8, C11 Phase 1
- Decision owner: Cobitech Solutions
- Extends: ADRs 0011, 0026, 0027 and 0036

## Context

ADR 0036 proved that `Kusanya_Integration` can read an administrator-owned
definition through its definition-only View All Records grants, compile and attest
artifacts, and still be refused at the final user-mode publication update. `Form__c`
is private, its Form Versions are controlled by their parent, and View All Records
does not grant update access. Integration-owned definitions publish, but ownership
transfer is the wrong product contract: administrators and supervisors author the
definitions while one tenant integration user publishes them.

Modify All Records would close the immediate gap by giving the publisher write
access to every Form in the org. ADRs 0011 and 0026 deliberately forbid that broad
grant. An owner-based or criteria sharing rule would likewise be org-wide rather
than an explicit decision per Form. The required boundary is one reviewable,
revocable publisher selection on one Form.

## Decision

Add optional `Form__c.Publisher__c`, a lookup to one Salesforce User. Only
`Kusanya_Admin` receives field edit access. Integration and Supervisor can read the
selection but cannot appoint or replace the publisher. Selecting a user does not
create or assign a user, permission set, collector, group, queue or credential. The
selected user must separately hold `Kusanya_Integration`, including the object,
field, class and `Publish_Kusanya` grants already required by ADRs 0026, 0032 and 0034.

Maintain one `Form__Share` row with Edit access and the packaged
`Publisher_Access__c` Apex sharing reason when the selected publisher is not the
record owner. A custom reason makes the package-owned share distinct from manual
shares and durable across owner transfer. If the publisher is the owner, ownership
already supplies access and no redundant share is stored. The controlled-by-parent
Form Version and its definition details inherit the Form access needed by the
user-mode publication lifecycle.

`PublisherRecordAccess` is a trigger-only `without sharing` system-maintenance
boundary. That elevation is limited to deleting and inserting `Form__Share` rows
for this one custom reason; it cannot select a user or modify Form data. It runs
after insert, update and undelete, and reconciles only records whose Publisher or
Owner changed. Each invocation uses one query and at most one delete plus one
insert, bulked across up to 200 Forms. Clearing or replacing Publisher deletes every
old share for this reason before applying the new selection. Other manual or rule
shares are untouched. A share failure rolls the initiating Form transaction back.

Do not add Modify All Records, View All Data, setup permissions, automatic
permission-set assignment, group membership, a REST endpoint or a tenant selector.
The existing publisher still supplies a fresh token for every request and acts as
one principal for definition read, Describe, artifact ownership and commit. This
unit decides only the Salesforce record-access prerequisite; tenant connection
selection, encrypted credential persistence and rotation, and the publish CLI
remain separate work.

## Consequences and verification

Source tests pin the User lookup, custom sharing reason, Admin-only editability,
unchanged `modifyAllRecords=false` grants, exact trigger events, one-query/two-DML
bound, Edit access and absence of setup-object creation. Apex tests use synthetic
distinct principals to prove all of the following:

- the unshared Integration principal reads but cannot commit a cross-owner Draft;
- setting Publisher creates exactly one reason-scoped Edit share and the same
  principal then completes the existing publication lifecycle with its own Files;
- replacing and clearing Publisher revoke the previous user's inherited Form
  Version write access without affecting definition-wide read access;
- owner transfer suppresses a redundant owner share and recreates it when the
  selected publisher is no longer the owner; and
- 200 Forms reconcile in one share query and one share insert, while an unrelated
  Form edit performs no share query or DML.

Independent verification must deploy to a fresh org and repeat the ADR 0036
cross-owner path with a non-administrator Integration principal: refusal before
selection, successful publication after selection, exact publisher-owned and
attested ContentVersion pins, then refusal on a new Draft after revocation. It must
also confirm no user, permission assignment, group, queue, role or unrelated share
was created and `modifyAllRecords` remains false.

Successful live evidence closes note 85's untested shared-for-write route and the
scoped record-level write-access portion of note 34. Note 34 remains open for
tenant connection selection, encrypted credential persistence and rotation, and
the publish CLI. Note 39 remains open. This unit changes no workflow, harness,
policy script, dependency, Enketo/Collect boundary, delivery route, ingestion path
or C10 acceptance test and makes no Phase 1 completion claim.

## Revisit when

A tenant needs multiple simultaneous publisher principals, Publisher selection is
exposed through the Lightning builder, an integration user is rotated, or package
namespace/linking verification reveals a sharing-reason compatibility issue.
