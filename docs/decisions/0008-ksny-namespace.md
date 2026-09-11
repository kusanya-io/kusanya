# ADR 0008: Select the ksny namespace and separate registration from packaging

- Status: Accepted prefix decision; registration and linking await explicit approval and verification
- Date: 2026-09-11
- Brief sections: C11 Phase 1 prerequisites, C12, C13
- Decision owner: Cobitech Solutions

## Context

The brief names `ksny` unless a conflict is found and delegates the namespace-prefix
decision. ADR 0003 requires an availability check and namespace ADR before the first
Phase 1 object. ADR 0006 additionally requires registration and multi-hub linking
before namespaced Phase 1 objects. Package format remains an explicit C12 question
for Bill; choosing a prefix does not answer it.

On 2026-09-11, Bill supplied a screenshot of Salesforce's Namespace Settings page
showing `ksny` with the result **This namespace is available**. The package selector
was `--None--`, and the page still offered Review and Cancel. This is operator-
supplied, point-in-time availability evidence, not proof of reservation or completed
registration.

Before that check, the builder authenticated the separate namespace org with Bill's
authorization under local alias `Kusanya-Namespace`. A read-only Organization query
confirmed Cobitech Solutions, Developer Edition, `IsSandbox = false` and an empty
`NamespacePrefix`. Existing local aliases and default-org/default-Dev-Hub settings
were unchanged. Empty `NamespacePrefix` alone does not prove global availability.
Dev Hub disabled state has not been independently verified; no Organization field
for that setting was returned by the schema describe.

## Decision

Select `ksny` as Kusanya's namespace prefix, based on the brief and the supplied
availability result. Do not choose an alternative without evidence of a conflict
and an updated ADR.

Keep the namespace-holder Developer Edition org separate from all Dev Hubs and
scratch orgs. Do not enable Dev Hub in it. Registration permanently associates the
namespace with its org and requires Bill's explicit approval of that exact org and
prefix before Review/Save. Recheck availability immediately before registration.

If Bill authorizes registration, leave the package selector at `--None--`. Do not
associate or convert a first-generation managed package, create any package, or
select unlocked versus managed distribution as part of registration. The C12
package-format decision remains separate.

Linking requires approval of the exact target Dev Hubs and read-only confirmation
of each resulting Namespace Registry association. This ADR does not provision a
CI Dev Hub, move CI secrets, change the harness pin or authorize scratch creation.
Keep `salesforce/sfdx-project.json` unchanged until the registration/linking
prerequisites have been verified and the corresponding source change reviewed.

## Alternatives considered

An alternative prefix is unnecessary while `ksny` is available. Using a Dev Hub or
scratch org as the namespace holder conflicts with Salesforce's documented setup.
Starting Phase 1 objects before the availability evidence and this ADR land would
bypass ADR 0003. Namespaced objects also await ADR 0006's verified registration and
linking. Choosing managed packaging now would exceed the delegated prefix decision
and Bill's current approval.

## Consequences and verification

- Availability is not a reservation; no namespace registration or linking is
  claimed complete by this record.
- Confirm the intended namespace org's identity and Dev Hub switch off before
  registration; retain account recovery and administrative access under Cobitech's
  control. Do not put usernames, credentials or recovery material in this repository.
- After authorized registration, query Organization again and require
  `NamespacePrefix = 'ksny'`; audit the intended Dev Hubs' Namespace Registry links
  before claiming namespaced development/verification readiness.
- The exact builder/verifier/CI hub topology and links remain unverified. A shared
  Phase 0 hub is not evidence that the approved dedicated CI hub was provisioned.
- No Phase 1 objects, packaging, deployment or C10 acceptance tests are implemented
  or claimed here. The existing no-Salesforce-licence-per-collector rule is unchanged.
- All ADRs remain outside the documentation-only CI exemption. Batch this record
  with ADR 0002's licence confirmation before submitting the prerequisite PR; do
  not change the exemption to avoid review or scratch capacity requirements.

Salesforce documents the separate
[availability, Review and Save steps](https://developer.salesforce.com/docs/platform/pkg2-dev/guide/sfdx-dev-dev2gp-create-namespace.html)
and the
[separate namespace org, permanent association and Dev Hub linking](https://developer.salesforce.com/docs/platform/pkg1-dev/guide/sfdx-dev-reg-namespace.html).
Referencing managed-packaging documentation for the namespace mechanism is not a
decision to produce a managed package.

## Revisit when

`ksny` becomes unavailable before registration, ownership/recovery cannot be
confirmed, the intended Dev Hubs change, or Bill makes the separate package-format
decision. Update evidence and obtain review before relaxing any Phase 1 prerequisite.
