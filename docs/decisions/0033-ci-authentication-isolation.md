# ADR 0033: Isolate hosted CI authentication in the existing Dev Hub

- Status: Proposed; operational migration awaiting independent verification
- Date: 2026-09-30
- Brief sections: C8, C11 Phase 1, C13; verification protocol
- Decision owner: Cobitech Solutions
- Amends: ADR 0006's requirement for a separate CI-only Dev Hub

## Context

Hosted CI and the independent verifier currently authenticate as the same user in
the same Developer Edition Dev Hub. This contradicts the intended separation in
ADR 0006 and `docs/ci.md`. The coupling has caused an observed CI authentication
failure after the shared user's PlatformCLI authorization changed, and one local
logout removed both aliases because they represented the same user and auth entry.

Creating another Developer Edition org would separate scratch capacity as well as
identity, but it also adds another permanent org, mailbox-facing registration and
recovery obligation. The current Dev Hub has two unused full Salesforce licences.
Salesforce supports delegating scratch-org work to a non-administrator through
object permissions on `ScratchOrgInfo` and `ActiveScratchOrg`.

The immediate defect is shared identity and shared authorization, not an exhausted
active-org limit. This decision therefore isolates the CI principal inside the
existing Dev Hub without pretending to isolate its scratch-org quota.

## Decision

### Use one dedicated least-privilege CI principal

Retain Dev Hub `00Dbm00000yeiz3EAA`. Create one active user used only by the
protected GitHub `salesforce-ci` environment. Use a spare full Salesforce licence
with the `Minimum Access - Salesforce` profile and a dedicated permission set that
grants only:

- API Enabled;
- Read, Create, Edit and Delete on `ScratchOrgInfo`; and
- Read, Edit and Delete on `ActiveScratchOrg`.

Do not grant packaging, namespace, customer-org, product-data or administrator
permissions. A globally unique Salesforce username is an identifier, not a demand
for another mailbox; the account can use Bill's existing monitored address for
notifications and recovery. The username and email are operational secrets and do
not belong in repository files, logs, issues or pull-request comments.

The verifier retains its existing user. CI and verifier must have different
Salesforce user IDs and independent local authorization entries. A logout or token
rotation for one principal must not remove or invalidate the other's authorization.

### Preserve the current workflow contract during migration

Do not change the workflow, trusted harness, immutable pin or policy scripts in
this unit. Authorize the new CI user privately and replace only the protected
environment secret `SF_DEV_HUB_AUTH_URL`. Never print, paste into chat, commit or
otherwise persist the authorization URL outside the protected secret and the
operator's private Salesforce CLI store.

The existing Salesforce CLI connected app may be used for this migration because
the different Salesforce user provides a separate refresh-token identity. A
dedicated certificate-based connected app and JWT flow is preferable for long-term
headless rotation, but Salesforce currently requires a connected app for Dev Hub
scratch creation. Introducing its consumer key/private key and changing the pinned
authentication path require their own reviewed workflow/harness unit.

### Record non-secret operational ownership

Maintain `docs/operations/salesforce-org-registry.md` as the human-readable catalog
of Salesforce roles, stable org identifiers, credential locations, owners and
last verification dates. It must never contain usernames, email addresses,
passwords, tokens, authorization URLs, consumer secrets or private keys.

### Keep capacity sharing explicit

Both principals still consume the existing Developer Edition allocation. Identity
isolation therefore does not provide a separate active or daily scratch-org budget.
CI and the verifier continue to coordinate live capacity under ADR 0006. If shared
capacity becomes the constraint, a separately approved higher-capacity Dev Hub or
second hub can be evaluated without reversing this identity separation.

## Verification and rollout

The migration is accepted only when an independent reviewer confirms all of the
following without exposing credentials:

1. the CI and verifier user IDs differ while the intentional Dev Hub org ID is the
   same;
2. the CI principal has exactly the approved profile and permission-set scope;
3. the protected GitHub environment secret was replaced without a repository,
   issue, pull-request, Actions-log or transcript disclosure;
4. the verifier authorization works before and after CI migration;
5. one approved exact-head hosted run authenticates as the new principal, creates
   one owned scratch org, passes the complete Apex gate and deletes that org; and
6. `ScratchOrgInfo.CreatedById` for that run identifies the dedicated CI user, with
   zero active owned orgs after cleanup.

The source pull request still merges before its verification-log pull request. A
failed migration is infrastructure evidence, not permission to weaken the gate,
reuse the verifier credential or bypass the retry policy.

## Consequences

This closes note 77's refresh-token, logout and principal-ownership coupling after
the live proof succeeds. The shared-capacity part of note 77 remains open and is
named as such. The change creates no Developer Edition org and requires no new
mailbox. It does not advance product notes 34, 39 or 69, close note 75, implement a
C10 acceptance test or complete Phase 1.

## Revisit when

The pinned harness moves to JWT, Salesforce changes its Dev Hub connected-app
requirements, the existing hub's quota becomes inadequate, or the CI principal's
least-privilege scope must expand.
