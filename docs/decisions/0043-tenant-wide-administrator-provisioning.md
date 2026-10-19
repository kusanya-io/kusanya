# ADR 0043: Tenant-wide administrator provisioning invariants

- Status: Proposed; implementation awaiting independent verification
- Date: 2026-10-19
- Brief sections: C1.3a, C2, C4 Tenant Connection, C8, C11 Phase 1
- Decision owner: Cobitech Solutions
- Extends: ADR 0042

## Context

ADR 0042 initially stored the expected Salesforce org, authorization origin and
namespace beside every administrator actor. Independent review found two gaps. First,
provisioning accepted namespace spellings that the OAuth route later refused, leaving
an otherwise immutable actor unable to authorize. Second, two actors for one tenant
could carry different expected Salesforce orgs and fail only when a later route used
them. Those are tenant properties, not actor properties.

Provisioning remains an internal operation for a future approved operator. It must be
safe under concurrent replicas and must not leave a tenant or actor row after a
rejected partial attempt.

## Decision

### Store Salesforce authorization context once per tenant

`tenant_administrator_tenants` owns one immutable tuple of tenant UUID, normalized
Salesforce `00D` org, exact Salesforce authorization origin and canonical namespace
prefix. The tenant UUID is the primary key and the org is unique, so neither one
tenant with two orgs nor one org assigned to two tenants can be represented.

`tenant_administrator_bindings` now maps only a stable actor identifier to that
tenant. Several approved actors may share one tenant, but every request they
authenticate resolves the same tenant-owned Salesforce context through a live join.
Changing any tenant property or moving an existing actor returns the fixed
`ADMINISTRATOR_SESSION_CONFLICT`; there is no implicit rebind.

### Use the same namespace grammar at provisioning and routing

Both boundaries call `administratorNamespacePrefix`. It accepts only the empty
prefix or a lowercase Salesforce package prefix followed by `__`, matching
`^(?:|[a-z][a-z0-9]{0,14}__)$`. It does not lowercase or otherwise repair input.
Values such as `MyNs__`, `my_ns__` and `Evil__` are rejected before storage with
`ADMINISTRATOR_SESSION_INPUT`.

The database repeats the namespace constraint. Migration `0004` creates the tenant
table, refuses inconsistent legacy actor rows, collapses identical per-actor tuples
with `SELECT DISTINCT` into one tenant row, and then removes the duplicated tenant
properties from actor bindings. A bad namespace, duplicate org ownership or
inconsistent tenant tuple rolls the migration back under the existing migration
transaction rather than choosing a winner.

### Serialize provisioning without partial rows

Provisioning remains one parameterized SQL statement. Transaction-scoped PostgreSQL
advisory locks are acquired in tenant-then-actor order from namespaced hashes. After
the locks, the statement checks an existing actor's tenant, conditionally inserts or
matches the tenant tuple, and only then inserts or matches the actor. A conflict
returns no row, while a unique-org collision is normalized from PostgreSQL `23505`;
both become `ADMINISTRATOR_SESSION_CONFLICT`.

Because the locks live for the statement transaction, concurrent replicas cannot
admit conflicting tenant tuples or actor moves. A refused actor move does not leave an
unused tenant, and a refused tenant tuple does not leave an actor. Hash collisions can
only serialize unrelated provisioning calls; they cannot weaken the invariant.

## Consequences and verification

Unit tests exercise canonical namespaces, tenant-wide org/origin/namespace conflicts,
multiple actors sharing one exact tenant, fixed uniqueness failures, hostile error
objects and the matching route boundary. PostgreSQL 17 integration tests apply the
migration twice, inspect the normalized table shape, prove refused actor moves leave
no tenant row, race conflicting tuples for one tenant and prove exactly one actor and
one tuple survive.

This closes review notes 96 and 97 if independently verified. It does not implement
the external identity verifier, approved provisioning interface, secure login/cookie
and logout composition, actor-to-Salesforce-user audit, privileged disconnect/rebind,
publisher composition or CLI. Note 94 still applies when the OAuth adapter is mounted:
the host must preserve query- and cookie-safe logging. Nothing is mounted in
`main.ts`, no Salesforce metadata or CI boundary changes, and no C10 acceptance test,
publish-ready state or Phase 1 completion is claimed.

## Revisit when

The approved provisioning or rebind workflow is exposed, a tenant may intentionally
own more than one Salesforce org, the external identity mapping is selected, or the
service routes are mounted.
