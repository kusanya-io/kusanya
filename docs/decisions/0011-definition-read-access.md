# ADR 0011: Object-scoped definition reads before Phase 2

- Status: Accepted design decision; permission implementation deferred
- Date: 2026-09-14
- Brief sections: C2, C4 sharing and permissions, C8, C11 Phase 2, C12
- Decision owner: Cobitech Solutions

## Context

Claude's PR #8 note 24 identifies a real gap: private Form/Folder/Choice List roots
and inherited detail sharing do not let the integration user or a supervisor read
administrator-owned definitions merely because they have object Read permission.
Bill requested a recorded decision before a Phase 2 read path. No such path exists
yet. The current PR must not claim effective cross-owner access or silently add
org-wide privileges.

## Decision

Before implementing a Phase 2 definition reader, introduce a separately reviewed
permission change giving Kusanya Integration and Supervisor **View All Records on
definition objects only**, plus their existing object/FLS read grants. The initial
allowlist is Folder, Form, Form Version, Question, Choice List, Choice and Skip
Rule. Any later mapping-definition objects require an explicit reviewed extension;
the allowlist must never grow automatically with every Kusanya object.

This is read access to all definitions within the connected Salesforce org, not
to all customer data. That is the intended definition-reader role boundary.
[Object View All overrides record sharing for that object, unlike View All Data](https://help.salesforce.com/articleView?id=users_profiles_object_perms.htm).
Include and verify every required master/detail permission dependency explicitly;
do not assume the parent's grant supplies all child object access. Salesforce
documents these [relationship and permission constraints](https://help.salesforce.com/s/articleView?id=platform.relationships_considerations.htm&language=en_US&type=5).

Keep FLS meaningful. Do not grant View All Data, Modify All Data, Modify All
Records, setup/user management, or access to customer mapping targets, collectors,
assignments, jobs, tasks, submissions or answers through this decision. Target
CRUD/FLS/record types remain administrator configuration with publish checks.
Read-all does not grant edit rights to someone else's definitions: publication
write authorization and the Phase 1 publisher's identity remain separate work.

Definition readers are Salesforce staff/integration principals, not collectors.
Collectors still have no Salesforce user, licence or sharing configuration. Future
service reads must bind the tenant to its connection and expose only the published
definitions allowed by that collector's work, never arbitrary draft definitions
or Author Notes. Object Read All cannot replace service authorization or field
allowlisting. A connection's access must never cross Salesforce orgs/tenants.

**This PR records the decision only.** The permission sets continue to have
`viewAllRecords=false` and `modifyAllRecords=false` on all seven objects. No users,
assignments, shares or org security settings are created or changed. Note 24's
runtime access gap stays open until the follow-up implementation and tests pass.

## Alternatives considered

- Public Read Only roots: broadens access to all users with object Read, not just
  the specific definition-reader roles.
- Explicit per-record shares/groups: possible, but introduces ownership/share
  lifecycle synchronization across both Form and reusable Choice List roots.
- `without sharing` reader or View All Data: bypasses the intended narrow
  boundary. Trigger integrity reads in ADR 0010 do not justify a data reader.
- Continue using only owner access: fails the administrator-built form use case.

## Consequences and verification

The follow-up permission PR is a blocker before **any Phase 2 definition read
path**. It must demonstrate with synthetic, distinct principals that:

- An administrator creates a Form/Version/question/skip hierarchy and both inline
  and reusable choices; integration and supervisor can read the complete model,
  including required master/detail dependencies, despite different ownership.
- A principal without the designated grants cannot gain that cross-owner access;
  restricted FLS remains enforced by the actual reader, not just metadata checks.
- Supervisor write denial and all existing role-specific writes stay unchanged;
  read-all never becomes implicit edit-all.
- Customer targets and non-definition Kusanya objects receive no new access;
  tenant/collector restrictions are independently checked at their service paths.
- No collector Salesforce identity, licence or sharing records are created.

No effective-access test has run in this model-only unit, and no C10 acceptance
test is claimed by this ADR. Follow the normal quota, hosted CI approval and
independent Claude verification rules for the future permission change.

## Revisit when

Customers require private definitions within one org, permission dependencies
make the object allowlist insufficient, or the publication/read design changes
the boundary. Record a superseding decision before widening it.
