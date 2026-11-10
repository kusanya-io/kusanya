# Salesforce org registry

This is the non-secret catalog for Kusanya-operated Salesforce orgs and roles. It
records ownership and credential locations without storing authentication
material. Never add usernames, email addresses, passwords, tokens, Salesforce
authorization URLs, consumer secrets or private keys.

| Role                                             | Stable org ID        | Org type                                   | Principal                         | Credential location                                             | Owner | Status                                        | Last verified |
| ------------------------------------------------ | -------------------- | ------------------------------------------ | --------------------------------- | --------------------------------------------------------------- | ----- | --------------------------------------------- | ------------- |
| Development and independent verification Dev Hub | `00Dbm00000yeiz3EAA` | Developer Edition Dev Hub                  | Verifier-only Salesforce user     | Verifier private CLI store                                      | Bill  | Active; `ksny` linked                         | 2026-11-09    |
| Hosted CI Dev Hub                                | `00Dbm00000yeiz3EAA` | Same Developer Edition Dev Hub by ADR 0033 | Dedicated CI-only Salesforce user | GitHub `salesforce-ci` environment secret `SF_DEV_HUB_AUTH_URL` | Bill  | Active; `ksny` linked                         | 2026-11-09    |
| Diagnostic Dev Hub                               | `00Dak00001Pc1uFEAR` | Developer Edition Dev Hub                  | Operator-only administrator       | Operator-controlled Salesforce account                          | Bill  | Retained diagnostic; `ksny` linked; no CI use | 2026-11-09    |

The two roles intentionally share an org and therefore share its scratch-org
allocation. They must not share a Salesforce user or authorization entry. Scratch
orgs are disposable and tracked by the ownership tags and cleanup evidence defined
in ADR 0006; they are not cataloged as permanent orgs here.

The diagnostic hub does not replace either operational role and is not authorized
for routine scratch creation. It was retained after the supported namespace-link
retest so the Salesforce-side resolution and second registry association remain
inspectable. Any future use or retirement is a separately reviewed operator action.

The hosted CI principal uses the `Minimum Access - Salesforce` profile and the
dedicated `Kusanya_CI_Dev_Hub` permission set. Its system-permission scope is API
Enabled, View Setup and Configuration, View Roles and Role Hierarchy, and View
Setup Audit Trail. The setup permissions are read-only: the Limits REST resource
used by the pinned harness requires View Setup and Configuration, and Salesforce
requires View Roles and Role Hierarchy as its dependency. View Setup Audit Trail
was enabled at the same timestamp as those explicit setup grants, has no separate
setup-audit entry and was not introduced by the namespace grant. Its cause is not
established: comparable permission sets in these orgs carry View Setup without it.
It remains an open least-privilege question for a separately approved lifecycle
test rather than a claimed platform dependency. Object scope is Read, Create, Edit
and Delete
on `ScratchOrgInfo`, plus Read, Edit and Delete on `ActiveScratchOrg`, without View
All or Modify All, plus Read only on `NamespaceRegistry`. The registry read is
required by Salesforce's namespaced scratch-org signup validator and grants no
linking or mutation. The CI principal continues to see only its own scratch-org
records. ADR 0033 records why the two currently unused `ScratchOrgInfo` mutation
grants remain candidates for a separately tested tightening and why the registry
grant is operator-applied rather than arm's-length evidence.

Update this table whenever an org, role, principal type, credential location or
owner changes. Record the change in an ADR when it changes a trust boundary.
