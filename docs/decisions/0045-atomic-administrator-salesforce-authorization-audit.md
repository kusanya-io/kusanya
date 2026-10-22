# ADR 0045: Atomic administrator-to-Salesforce authorization audit

- Status: Proposed; implementation awaiting independent verification
- Date: 2026-10-21
- Brief sections: C1.3a, C2, C4 Tenant Connection, C8, C11 Phase 1
- Decision owner: Cobitech Solutions
- Extends: ADRs 0038, 0040, 0041, 0042 and 0044

## Context

The one-time OAuth boundary verifies a signed Salesforce identity and returns its
`005` user ID. The browser adapter also resolves the exact still-live administrator
session and therefore knows the stable trusted actor that initiated the grant. Until
now the callback persisted only the encrypted tenant credential and discarded the
relationship between those two principals. ADRs 0041, 0042 and 0044 explicitly defer
that audit.

Writing the audit after credential persistence would permit a successful connection
without its actor evidence. Writing it before persistence would permit an audit for a
connection that never committed. Updating one row on reauthorization would also
erase who authorized earlier credential versions.

Independent review note 98 additionally identified two copies of the authenticated
administrator-context decoder. That duplication had not admitted bad data because
the session store emits a normalized 18-character org ID, but it recreated the class
of drift previously found in note 96. Note 99 identified that the deliberately empty
login request excludes identity protocols whose assertion is delivered in a request
body.

## Decision

### Append one event for every committed grant

Migration `0005_salesforce_authorization_audits` adds
`tenant_salesforce_authorization_audits`. Each row records an identity-generated
event ID, tenant UUID, trusted actor, normalized Salesforce `00D` org, normalized
authorizing `005` user, resulting credential version and database timestamp. Actor
and tenant have a composite foreign key to the immutable administrator binding; the
tenant also references the committed connection.

Events are append-only through the Kusanya write path. A later successful
authorization writes another event instead of updating or deleting history. The
schema does not revoke `UPDATE` or `DELETE` from a privileged database role, so this
is not a tamper-evidence claim against database administration. No access token,
refresh token, OAuth code, state, session, CSRF value or provider response is stored
in the audit table.

### Commit credential and audit in one database transaction

`TenantConnectionStore.saveAuthorization` strictly decodes both principals, seals
the refresh token before database I/O, begins one PostgreSQL transaction, upserts the
tenant connection and then inserts the audit by selecting the exact actor-to-tenant
binding. A missing or mismatched actor makes the audit insert affect no row; the
method rolls back the preceding credential upsert and returns a fixed connection
failure. Commit happens only after both writes report exactly one row.

The actor reaches this method only from the live administrator context decoded at
callback time. The Salesforce user reaches it only from the signed token identity
verified by ADR 0040. Neither value is accepted from request headers, query, body or
cookies. The store independently requires the actor's durable binding to the same
tenant, so an internal caller cannot attach an otherwise valid actor from another
tenant.

### Use one shared authenticated-context decoder

`decodeTrustedAdministratorContext` is exported by the administrator-session module
and used by both browser adapters and by stored-session reconstruction. It accepts
the one exact context shape, normalizes 15- or 18-character org IDs to one checked
18-character identity, uses the canonical namespace rule, rejects proxies and
accessors without invoking them, and returns a frozen value. This closes note 98 by
removing the duplicated validator rather than synchronizing copies.

### Keep the empty login request and state its provider consequence

ADR 0044's login route remains queryless and bodyless. Consequently, a future
identity provider must complete verification through an injected mechanism that does
not require an assertion in this route's request body. SAML HTTP POST binding and
OIDC `form_post` response mode cannot be wired to the current route unchanged. Bill
must revisit the route contract when selecting the provider; this records note 99
without selecting one prematurely.

## Consequences and verification

Unit tests prove canonical `005` normalization, exact actor/user input propagation,
parameterized encrypted persistence and one transaction containing connection then
audit before commit. OAuth route tests prove the actor comes from the authenticated
callback context and the user from the signed provider response. Context tests pin
the shared decoder's hostile-input behavior.

A disposable PostgreSQL 17 test must apply the migration, complete a signed grant,
inspect the exact raw audit row, complete a second grant from another validated
Salesforce user and retain both events. It must then attempt persistence with an
unprovisioned actor and prove rollback preserves both the prior encrypted credential
and both audit rows. The audit table must contain no credential material.

This discharges the actor-to-Salesforce-user audit strand of note 34 and closes note 98. Note 99 is documented and remains a provider-selection constraint. The external
identity provider and stable actor mapping, approved provisioning interface,
deployment secret wiring, privileged disconnect/rebind, final
`publishSalesforceDefinition` composition and publish CLI remain. Nothing is mounted
in `main.ts`; no live Salesforce grant, C10 acceptance test, publish-ready state or
Phase 1 completion is claimed.

The audited OAuth path always commits the connection and event together. The older
low-level `TenantConnectionStore.save` remains available to tests and internal
storage callers, so a connection without an audit is representable outside that
path. This is an API-boundary fact, not a claim that an audit can exist without its
connection foreign key. A future production composition may narrow that method's
visibility once all non-audited test setup uses a dedicated fixture boundary.
These clarifications answer verifier notes 100 and 101 without claiming database
tamper evidence or narrowing a code path in this unit.

## Revisit when

Bill selects the external identity provider, actor identifiers need migration,
authorization history receives an operator-facing read API or retention policy, a
privileged disconnect/rebind workflow is added, or tenant connections may be deleted.
