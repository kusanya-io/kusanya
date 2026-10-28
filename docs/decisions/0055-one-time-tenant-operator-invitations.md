# ADR 0055: One-time tenant operator invitations

- Status: Proposed; implementation awaiting independent verification
- Date: 2026-10-28
- Brief sections: C1.3a, C2, C5, C8, C11 Phase 1
- Decision owner: Bill Owiti / Cobitech Solutions
- Extends: ADRs 0042, 0043, 0044, 0050, 0052, 0053 and 0054

## Context

ADR 0052 let a full administrator create another binding immediately by submitting
an OIDC subject. That made the administrator, rather than the subject, the actor who
completed enrolment. It also forced issuance to report success or refusal when the
derived actor was already bound to another tenant, leaving a one-bit cross-tenant
membership oracle. ADR 0054 added the role that an invitation must carry and made
role authority live, but it deliberately left invitation lifecycle work open.

An invitation must confer no authority before the invited identity accepts it. Its
secret must be unguessable, single-use, expiring and revocable. Acceptance must bind
the verified OIDC identity to the invitation's stored tenant and role without taking
tenant, role or actor selectors from the acceptance request.

## Decision

### Issue without probing global membership

Only a live `administrator`, under the existing exact-origin, opaque-session and
session-derived CSRF boundary, may issue or revoke an invitation. Issuance accepts a
bounded OIDC subject and one closed ADR 0054 role. The configured issuer derives the
target actor. PostgreSQL confirms the performing actor is still an active full
administrator in the live tenant, but deliberately does not query whether the target
actor has a binding or invitation in another tenant. A request for an existing or
unknown subject therefore has the same successful issuance response.

The service generates an independent UUID and 256-bit random token. It returns the
raw token once under `Cache-Control: no-store` and stores only its SHA-256 digest.
The token never enters a URL, redirect, cookie, log or database column. The operator
delivers it out of band. Multiple issued invitations remain independent; reissuing
does not edit or escalate an earlier token.

Migration `0010_administrator_invitations` stores tenant, issuer, target actor, exact
role, issuance and expiry, plus mutually exclusive acceptance or revocation state.
Closed role, token-digest, target-actor, expiry and terminal-state checks reject
incoherent rows. Composite foreign keys bind issuers, accepters and revokers to the
same tenant. The accepted actor must equal the target actor. As with earlier audit
tables, an update trigger makes the token, tenant, issuer, target, role and expiry
immutable after issue and prevents either terminal state from being cleared or
rewritten. These constraints protect application state but do not claim tamper
evidence against a privileged database owner who can alter the schema itself.

### Accept only as the invited verified subject

`POST /api/admin/session/login` retains ordinary login for an existing binding. On
first sign-in it may additionally receive exactly `{invitationToken}` in the JSON
body while the OIDC access token remains in the redacted Authorization header. The
trusted OIDC verifier derives the actor before invitation storage is touched. The
acceptance request supplies no tenant or role.

One PostgreSQL statement takes deterministic actor and tenant advisory locks, checks
the token digest, exact target actor, unrevoked and unaccepted state, database expiry,
and that the original issuer is still an active full administrator. It then inserts
the immutable binding using the stored role, marks the invitation accepted, appends
the role enrolment audit and inserts the opaque browser session. Any failure rolls
back every write. Concurrent acceptance or replay has one winner. A subject already
bound anywhere cannot accept another tenant's invitation. Wrong-subject, expired,
revoked, replayed and binding-conflict attempts share the same fixed authentication
refusal.

Revocation identifies the random invitation UUID, not its secret. Any current full
administrator in that tenant may revoke a pending invitation. Revocation is
idempotent and gives the caller no row-existence signal; acceptance and revocation
serialize through the same actor-then-tenant lock order.

### Remove direct browser enrolment

`POST /api/admin/administrators` is removed. The remaining lifecycle path changes a
peer role or deprovisions an existing peer. The production composition passes narrow
method facades to session, invitation and lifecycle adapters, so none can reach the
legacy internal provisioning helper. The static operator shell creates and revokes
invitations, displays the raw token only in memory for copying, and accepts it only
through first sign-in. Browser fields remain convenience, never authority.

## Alternatives considered

- Refuse issuance when the subject is already bound elsewhere. Rejected because the
  status becomes a cross-tenant membership oracle.
- Put tenant or role in a signed invitation token. Rejected because revocation and
  role immutability would depend on token parsing and key lifecycle; opaque random
  capability plus database state is smaller and immediately revocable.
- Put the token in a link query string. Rejected because URLs leak through history,
  referrers, screenshots, proxies and infrastructure logs.
- Create the binding at issuance and activate it at acceptance. Rejected because an
  unaccepted invitation would already create tenant identity state and complicate
  uniqueness and recovery.
- Let publishers invite reviewers. Rejected for now because administrator lifecycle
  is one explicit full-administrator capability. A future delegation policy requires
  a separate decision and matrix change.

## Consequences and verification

An invitation that has not been accepted creates no binding, session or authority.
The issuer learns only that an opaque invitation was stored, not whether its subject
exists in Kusanya. Removing or demoting the issuing administrator also prevents that
administrator's still-pending invitations from being accepted; another administrator
must issue replacements deliberately.

Unit tests cover route boundaries, lower-role denial, hostile request shapes, opaque
token storage, fixed errors, method reachability and the atomic SQL shape. PostgreSQL
17 integration probes cover wrong-subject refusal, cross-tenant collision at
acceptance, revocation, expiry, replay, concurrent one-winner acceptance, one binding,
one session, one audit, stored role fidelity, lower-role issuance denial and absence
of raw tokens at rest. A direct attempt to escalate an issued invitation from
`reviewer` to `administrator` is rejected by PostgreSQL. A forced lock race proves
that demoting the issuer while acceptance waits prevents acceptance after the lock
is released rather than admitting it from a stale statement snapshot.

This closes note 34's invitation strand and the remaining membership-oracle part of
note 109. It materially reduces note 110 by making pending additions revocable, but
an active stolen full-administrator session can still issue invitations until that
session or actor is revoked. Note 39 remains open. No C10 acceptance test,
publish-ready state or Phase 1 completion is claimed.

## Revisit when

Kusanya adds invitation delivery, resend, listing, rate limits, delegated inviters,
tenant suspension, privileged recovery or storage-role enforcement for audit data.
