# ADR 0008: Select the ksny namespace and separate registration from packaging

- Status: Accepted; registration verified by builder; Dev Hub linking and Claude review pending
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
The initial schema describe returned no Organization field for Dev Hub state, so
that API check did not establish whether it was disabled. The later direct setup
check and registration evidence are recorded below.

## Decision

Select `ksny` as Kusanya's namespace prefix, based on the brief and the supplied
availability result. Do not choose an alternative without evidence of a conflict
and an updated ADR.

Keep the namespace-holder Developer Edition org separate from all Dev Hubs and
scratch orgs. Do not enable Dev Hub in it. Registration permanently associates the
namespace with its org and requires Bill's explicit approval of that exact org and
prefix before Review/Save. Recheck availability immediately before registration.

Bill authorized registration with the package selector at `--None--`. Do not
associate or convert a first-generation managed package, create any package, or
select unlocked versus managed distribution as part of this operation. The C12
package-format decision remains separate.

Linking requires approval of the exact target Dev Hubs and read-only confirmation
of each resulting Namespace Registry association. This ADR does not provision a
CI Dev Hub, move CI secrets, change the harness pin or authorize scratch creation.
Keep `salesforce/sfdx-project.json` unchanged until the registration/linking
prerequisites have been verified and the corresponding source change reviewed.

## Registration approval and execution (2026-09-11)

Bill explicitly confirmed permanent registration of `ksny` in the newly
authenticated `Kusanya-Namespace` org, with no associated package, conditional on
confirming Dev Hub was disabled. That approval was given in the builder
conversation; it did not authorize any Dev Hub link or package creation.

The builder then completed and checked these steps:

1. Opened Setup > Dev Hub in the namespace org. The `Enable Dev Hub` checkbox was
   unchecked (`0`). No settings on that page were changed.
2. Re-ran Check Availability for `ksny`; Salesforce still reported it available.
3. Reviewed the exact prefix and `-- None Selected --` package association, then
   saved once. The resulting Package Manager page displayed Namespace Prefix
   `ksny` and an empty Managed Package Name.
4. At 19:04:50 UTC, a read-only Organization query returned `ksny` in
   `NamespacePrefix`, Developer Edition and `IsSandbox = false`. The org ID matched
   the exact org authenticated and approved before registration.
5. Separately queried the existing `Kusanya-DevHub` identity and its standard
   `NamespaceRegistry` records for `ksny`. It is a different org, and the registry
   query returned zero rows. No link was attempted.

The post-registration identity check was:

```powershell
sf data query --target-org Kusanya-Namespace --query "SELECT Id, Name, OrganizationType, NamespacePrefix, IsSandbox FROM Organization LIMIT 1" --json
```

The local aliases above identify explicitly authenticated builder connections;
they are not credentials or an instruction to reuse an unknown default org. Claude
must independently check the intended org identity before using equivalent aliases.
This is namespace configuration evidence, not Apex execution or a verifier verdict.

## Alternatives considered

An alternative prefix was unnecessary: `ksny` passed the availability check and is
now registered. Using a Dev Hub or scratch org as the namespace holder conflicts
with Salesforce's documented setup.
Starting Phase 1 objects before the availability evidence and this ADR land would
bypass ADR 0003. Namespaced objects also await ADR 0006's verified registration and
linking. Choosing managed packaging now would exceed the delegated prefix decision
and Bill's current approval.

## Consequences and verification

- Availability alone was not a reservation. Registration is now verified by the
  builder through the UI and Organization query; Dev Hub linking remains pending.
- Retain account recovery and administrative access under Cobitech's control. Do
  not put usernames, credentials or recovery material in this repository.
- For every explicitly approved target Dev Hub, query its Organization identity and
  standard `NamespaceRegistry` rows for `ksny` (not Tooling API). Require exactly one
  row with prefix `ksny` and `NamespaceOrg` matching the namespace-holder's
  case-sensitive 15-character org ID before claiming that hub is linked.
- Only the existing builder alias's hub was inspected, and it is not linked. The
  full builder/verifier/CI hub topology remains unverified. A shared Phase 0 hub is
  not evidence that the approved dedicated CI hub was provisioned.
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

Ownership/recovery cannot be confirmed, the intended Dev Hubs change, or Bill makes
the separate package-format decision. The registered prefix is permanent; revisiting
this ADR does not make it renameable or transferable. Update evidence and obtain
review before relaxing any Phase 1 prerequisite.
