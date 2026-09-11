# ADR 0003: Phase gates, client boundaries and deliberate exclusions

- Status: Accepted (implementation decision; phase gate pending verification)
- Date: 2026-09-10
- Brief sections: C1, C2, C4, C11, C12, C12a
- Decision owner: Cobitech Solutions

## Context

The preliminary handoff suggested a custom offline PWA. The repository brief
requires stock ODK Collect and Enketo, and explicitly says a custom PWA and Redis
are not needed. C2's mobile labels describe two client stages, while C11 specifies
the actual delivery phase numbers. The current request authorizes only Phase 0.

## Decision

Follow C11 for delivery gates. Use stock Collect for the initial Android path and
Enketo for the web path. Reserve `mobile/` for the Kotlin/JavaRosa client in C11
Phase 6; Phase 0 does not create a second form renderer. Define client version
targets in ADRs before their first integration. Define OAuth flow, tenant identity,
namespace availability and API-call budget in ADRs before those designs are built.
Specifically, the `ksny` availability check and namespace ADR must land before the
first Phase 1 object is created; neither is claimed complete by this scaffold.

Deliberately exclude PPI, mobile money, survey libraries, contact groups, client
assignation and identified-interviewee features per C4/C12. Preserve generic
metadata-driven mappings and the collector stamp requirement for later phases.

Keep developer build/test commands portable. The Windows checkout and GitHub-hosted
CI are build/verification environments, not product hosting. Actual development and
staging services belong to separate Cobitech Compose projects; production belongs
to Azure. Do not deploy, expose a hostname, modify backups, or change the HP stack
as part of Phase 0. Deployment manifests and automation follow in a reviewed unit.

## Consequences and verification

Phase 0 contains no tenant connection, form ingestion or client business workflow.
C10 tests remain explicitly unimplemented. The supplied worked example is useful
reference material but is not all seven forms: it has two separate repeats limited
to 20 and legacy repeat-only mappings, whereas C10.2 asks for a parent observation
and up to 40 students. The migration/acceptance fixtures must address that distinction
explicitly instead of silently changing the supplied seed. `seed/xlsform/` is empty.

Do not replay production seed rows into development or embed them in a container.
Use synthetic fixtures for automated tests. Preserve the brief and seed unchanged.

## Revisit when

Claude passes the current phase gate and the next phase begins, or Bill approves a
change to the product/client boundaries.
