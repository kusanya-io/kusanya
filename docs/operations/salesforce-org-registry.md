# Salesforce org registry

This is the non-secret catalog for Kusanya-operated Salesforce orgs and roles. It
records ownership and credential locations without storing authentication
material. Never add usernames, email addresses, passwords, tokens, Salesforce
authorization URLs, consumer secrets or private keys.

| Role                                             | Stable org ID        | Org type                                   | Principal                         | Credential location                                             | Owner | Status            | Last verified |
| ------------------------------------------------ | -------------------- | ------------------------------------------ | --------------------------------- | --------------------------------------------------------------- | ----- | ----------------- | ------------- |
| Development and independent verification Dev Hub | `00Dbm00000yeiz3EAA` | Developer Edition Dev Hub                  | Verifier-only Salesforce user     | Verifier private CLI store                                      | Bill  | Active            | 2026-09-30    |
| Hosted CI Dev Hub                                | `00Dbm00000yeiz3EAA` | Same Developer Edition Dev Hub by ADR 0033 | Dedicated CI-only Salesforce user | GitHub `salesforce-ci` environment secret `SF_DEV_HUB_AUTH_URL` | Bill  | Migration pending | 2026-09-30    |

The two roles intentionally share an org and therefore share its scratch-org
allocation. They must not share a Salesforce user or authorization entry. Scratch
orgs are disposable and tracked by the ownership tags and cleanup evidence defined
in ADR 0006; they are not cataloged as permanent orgs here.

Update this table whenever an org, role, principal type, credential location or
owner changes. Record the change in an ADR when it changes a trust boundary.
