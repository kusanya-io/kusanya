# ADR 0072: Activate ksny and require exact-head namespaced verification

- Status: Proposed; exact-head namespaced evidence pending independent review
- Date: 2026-11-09
- Brief sections: C8, C11 Phase 1, C13
- Decision owner: Cobitech Solutions

## Context

ADR 0008 selected and registered `ksny` while allowing bounded unnamespaced Phase 1
development because Salesforce's Environment Hub authorization failed before login.
ADR 0071 made the supported namespace link, an exact-head namespaced suite and a
fresh verifier gate run explicit prerequisites for Phase 1.

On 2026-11-09 Salesforce's supported flow linked the holder
`00Dbm00000yxbH7EAI` to the intended development/verifier/hosted-CI Dev Hub
`00Dbm00000yeiz3EAA`. A second diagnostic hub `00Dak00001Pc1uFEAR` was linked by
the same flow. Standard `NamespaceRegistry` queries returned exactly one `ksny`
row in each hub with holder `00Dbm00000yxbH7`. The connected-app timestamps and
settings were unchanged. No PKCE setting, callback, consumer detail, package,
credential, workflow or existing-org configuration was changed.

The source and service have intentionally carried namespace-local Salesforce
references plus synthetic resolver tests for both empty and `ksny__` configurations.
Those tests are portability evidence, not proof that the complete metadata deploys
and executes after Salesforce applies the real namespace.

## Decision

Set `salesforce/sfdx-project.json` namespace to `ksny`. Keep all Apex and metadata
references namespace-local; do not add hard-coded `ksny__` prefixes or org IDs.
Keep non-Salesforce naming boundaries configuration-driven and retain both empty and
`ksny__` compatibility fixtures.

Use the ordinary protected exact-head workflow against the already configured
intended hub. Do not migrate `SF_DEV_HUB_AUTH_URL`, change the hosted principal,
alter the workflow or harness, or use the diagnostic hub for CI. The protected run
must create a namespaced scratch org, deploy the complete source, pass every Apex
test at at least 85 percent coverage and delete its owned org. Claude independently
repeats the applicable suite in its own fresh namespaced scratch org.

This unit satisfies ADR 0071 condition 2 only after both evidence paths pass. It is
not the Phase 1 gate: Claude must then rerun C10.10 and C10.12 at the gate and issue
the phase verdict. No package is created and the separate C12 package-format
decision remains outstanding.

Retain the newly created diagnostic hub only as a non-CI diagnostic fallback. It
does not replace the intended hub or create authority to consume scratch capacity.

## Alternatives considered

- Keep the project namespace empty after the supported link. Rejected because it
  would preserve the exact late-defect risk that ADRs 0008 and 0071 require this
  unit to discharge.
- Move hosted CI to the diagnostic hub. Rejected because the intended hub is now
  linked and already has the reviewed least-privilege principal and protected
  credential; migration would add risk without benefit.
- Treat synthetic prefix tests as condition 2. Rejected because Salesforce applies
  namespace behavior during real scratch-org creation and deployment.
- Create a package as part of activation. Rejected because namespace activation is
  separate from Bill's C12 packaging decision.

## Consequences and verification

Every scratch org created from this project through either linked hub is namespaced.
Any namespace-only source, metadata, query, REST-path or permission defect now fails
the ordinary suite rather than remaining latent. Empty-prefix fixtures continue to
protect compatibility with explicitly unnamespaced tenant connections; they do not
weaken the deployment namespace.

The builder runs public local tests only and does not create a scratch org. The pull
request must declare the namespace change, the unchanged workflow/harness and the
absence of package or permission changes. Bill alone approves the protected run.
Claude verifies the `NamespaceRegistry` association, exact head, namespaced org,
full test/coverage result and cleanup, then independently deploys and tests in a
fresh namespaced org. No C10 acceptance test or Phase 1 PASS is claimed by this unit.

## Revisit when

The namespace link is removed or points to a different holder, the intended Dev Hub
or hosted principal changes, Salesforce namespaced behavior forces a reviewed source
change, or Bill decides the package format under C12.
