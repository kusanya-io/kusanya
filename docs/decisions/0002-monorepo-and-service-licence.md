# ADR 0002: One monorepo and Apache-2.0 for original service code

- Status: Accepted; service licence explicitly confirmed by Bill on 2026-09-11
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

### Bill's confirmation (2026-09-11)

After Phase 0 and issue #5 were verified and merged, Bill explicitly confirmed
retaining Apache-2.0 for Kusanya's original service code in the builder
conversation. This answers the service-licence prerequisite raised by the verifier;
it records owner approval of the existing choice, not a change of licence.

Retain the permissive, consistent licence for adoption and customer self-hosting,
accepting that others may commercially host modified forks without publishing
their modifications. AGPL-3.0 was considered for requiring modified
network-accessible versions to offer corresponding source to their users; it does
not prohibit commercial hosting. Third-party components retain their own licence
obligations and still require version-specific review before integration.

This confirmation does not authorize namespace registration or Dev Hub linking,
choose unlocked versus managed packaging, or approve a Salesforce run. The
namespace availability check and ADR remain prerequisites to the first Phase 1
object under ADR 0003; registration and multi-hub linking remain prerequisites to
namespaced Phase 1 objects under ADR 0006. Collectors still require no Salesforce
licence.

### Shared tooling

Use the root Prettier configuration and locked tooling across shared files and
service source/tests, alongside the service's typed ESLint rules. Exclude generated
output, dependencies and supplied reference material. A second service formatter
installation would duplicate version/configuration management without a need.

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
