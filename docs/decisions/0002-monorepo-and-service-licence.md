# ADR 0002: One monorepo and Apache-2.0 for original service code

- Status: Accepted (implementation decision; phase gate pending verification)
- Date: 2026-09-10
- Brief sections: C11 Phase 0, C12, C13
- Decision owner: Cobitech Solutions

## Context

C13 delegates the repository arrangement and the service licence. This repository
already contains the brief, Apache-2.0 licence and three component directories.
Salesforce metadata, the relay and mobile contracts will evolve together.

## Decision

Keep one repository with `salesforce/`, `service/` and `mobile/`. Apply the existing
root Apache-2.0 licence to Kusanya's original service code as well as the Salesforce
and future mobile code. Document direct dependency licences in `docs/licences.md`.

## Alternatives considered

Three repositories provide independent release permissions but complicate changes
to a shared contract during the early phases. AGPL-3.0 would require source
availability for modified network services; Apache-2.0 gives self-hosters and
contributors one permissive licence across Kusanya's original components.

## Consequences and verification

Others can offer hosted forks under Apache-2.0. The README retains the naming and
trademark policy. A component's third-party licence is not changed by this decision;
check the exact Enketo, ODK and JavaRosa components before selecting releases.
No upstream source, protected implementation or proprietary assets are copied.

Package format selection is deferred: C12 says to ask before choosing unlocked
versus managed packaging. Phase 0 uses unpackaged scratch-org source and does not
register a namespace, create a package, or choose a commercial distribution model.

## Revisit when

Independent release or governance needs justify splitting repositories, or Bill
requests a packaging decision through the C12 approval process.
