# ADR 0008: Select the ksny namespace and separate registration from packaging

- Status: Accepted; registration verified by builder; app PKCE locked in Edit; Dev Hub linking blocked; prerequisite review pending
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

## Approved link attempt and blocker (2026-09-11)

Bill subsequently approved linking `ksny` from `Kusanya-Namespace` to the exact
existing `Kusanya-DevHub` org identified in the builder conversation. The builder
rechecked that hub's Organization ID against the approved ID before proceeding.
This approval covers neither additional hubs nor changes to OAuth security policy.

After Bill signed in to the Dev Hub himself, the builder opened Namespace
Registries and clicked Link Namespace once. The Salesforce-generated authorization
popup failed before presenting a namespace-org sign-in form:

```text
error=invalid_request&error_description=missing%20required%20code%20challenge
```

The generated request had no `code_challenge` or `code_challenge_method`. Its
callback path was `/environmenthub/soma-callback.apexp`. Complete authorization
URLs, OAuth state values and credentials are deliberately not included here.
This establishes the observed PKCE input mismatch, not which org/app setting or
Salesforce defect caused it. No specific vendor fix or resolution date is verified.

At 19:16:38 UTC, read-only queries rechecked both approved org IDs: the holder still
reported `NamespacePrefix = ksny`; the existing hub's standard Namespace Registry
query still returned zero matching rows. Linking has not completed. The registry
check was:

```powershell
sf data query --target-org Kusanya-DevHub --query "SELECT Id, NamespacePrefix, NamespaceOrg FROM NamespaceRegistry WHERE NamespacePrefix = 'ksny'" --json
```

Preserve security settings while obtaining independent diagnosis and a supported
resolution. Do not disable PKCE, replace the built-in connected app, or manually
rewrite authorization URLs as part of this approval. Any proposed security change
requires separate explicit review and Bill's approval before implementation.
Salesforce's [PKCE documentation](https://help.salesforce.com/s/articleView?id=sf.remoteaccess_pkce.htm&language=en_US&type=5)
requires the authorization challenge and matching token-exchange verifier; adding
a challenge to the popup URL alone is not evidence of a correct end-to-end fix.
No new namespace-org browser login or OAuth consent, package creation, scratch
creation, CI change or project-namespace source change was performed in this link
attempt. The read-only queries used existing authenticated CLI connections.

## Claude's independent diagnosis (2026-09-11, 19:23 UTC)

Bill relayed Claude's read-only diagnosis, explicitly issued **without a verdict**.
The observations below are attributed to that report; the builder did not repeat
Claude's metadata retrieval or represent the diagnosis as a completed link:

- The namespace-holder still reported `NamespacePrefix = ksny`, Developer Edition
  and not sandbox. The approved existing Dev Hub had zero Namespace Registry rows.
- `Settings:OauthOidc` retrieved from both orgs had `isPkceRequired = false`.
  Claude ruled out the org-wide PKCE requirement in those checked settings; this
  does not establish the connected app's own PKCE requirement.
- The Dev Hub's only connected app was `SalesforceDX Namespace Registry`, created
  by Automated Process on 10 September at 11:30 UTC. Claude could not retrieve it
  as metadata or read its PKCE flag through the API. No external client apps were
  found in that inspection.
- `NamespaceRegistry.NamespaceOrg` was not createable. The inspection established
  no direct API creation path for the link; it does not authorize attempts to
  insert registry records or bypass the supported linking flow.
- Because the error occurs before login, Claude considers client-app enforcement,
  most likely an app-level PKCE requirement unmet by the Environment Hub flow,
  the leading diagnosis. The specific setting remains unconfirmed until Bill
  views the app's OAuth settings. This is not a confirmed Salesforce defect.

Bill's relay identifies verification-log entry PR #7. That verifier-owned log is
separate from this local ADR and does not constitute a PASS for this prerequisite.

The older blank-page Known Issue `a028c00000qQ0CBAA0` concerns a soma-callback
connected app. Its connected-app-creation workaround is outside the approved
scope and is not established as a fix for this PKCE error. Disabling PKCE is not
an established Salesforce-supported remedy for this failure.

The next operator steps are for Bill to view the app's OAuth settings read-only
and send the drafted Support request. Any PKCE or connected-app change requires
Bill's separate approval and Claude's explicit review before and after the change.
No security-setting change, new connected app, Support submission or credential
disclosure is authorized by this diagnosis. Keep the prerequisite PR incomplete
until the link is verified; keep namespaced Phase 1 objects and the source
namespace change on hold. The remaining multi-hub, dedicated CI hub and packaging
approval boundaries above are unchanged.

## Conditional PKCE approval and stopped inspection (2026-09-13)

Bill separately approved one temporary PKCE change in the existing Dev Hub
`00Dbm00000yeiz3EAA`, on `SalesforceDX Namespace Registry` only, to link `ksny`
from holder `00Dbm00000yxbH7EAI`. The approved window was at most 30 minutes,
including up to 10 minutes for propagation, with one link attempt and immediate
restoration regardless of the result. Bill would enter credentials himself.
The approval explicitly required stopping without changes if PKCE was unchecked
or could not be edited. It authorized no other app, OAuth setting, consumer
details, scratch org, CI, package or source-namespace changes.

Bill relayed Claude's read-only baseline at 12:09:45 UTC: zero registry rows,
app last modified on 10 September at 11:30 UTC by Automated Process, and no
security or connected-app audit entries. This is attributed baseline evidence,
not a builder audit-trail inspection or evidence of a subsequent change.

The builder performed the following checks without changing Salesforce settings:

1. At 12:19:30 UTC, read-only Organization queries matched both exact approved
   org IDs. The holder reported Developer Edition, `NamespacePrefix = ksny` and
   `IsSandbox = false`; the hub's `ksny` registry query returned zero rows.
2. Opened the approved app's View page. PKCE was checked. The visible callback
   belonged to the approved Dev Hub and ended in
   `/environmenthub/soma-callback.apexp`. Consumer details were not opened.
3. During navigation, inadvertently opened the app's Delete confirmation and
   cancelled it without confirming deletion. Then identified the current Edit
   control and opened the Edit form. No field was changed and Save was not used.
4. On the actual Edit form, the PKCE checkbox was both checked (`1`) and disabled.
   Its adjacent instruction read: **To change this required setting, contact
   Support.** This establishes the non-editable condition on Edit, not merely the
   normal read-only state of a View-page checkbox. The builder cancelled Edit.
5. The returned View page still showed the same app, PKCE checked, and Last
   Modified Date `9/10/2026, 4:30 AM`, by Automated Process. That displayed time
   is preserved as UI-local evidence, not independently converted to UTC.
6. At 12:39:27 UTC, read-only queries again matched both approved org IDs and the
   holder's Developer Edition, `ksny`, non-sandbox state. An unfiltered standard
   `NamespaceRegistry` query in the hub returned zero total rows:

   ```powershell
   sf data query --target-org Kusanya-DevHub --query "SELECT Id, NamespacePrefix, NamespaceOrg FROM NamespaceRegistry" --json
   ```

Screenshots in the builder conversation show the View-page app name, callback and
checked PKCE, followed by the Edit-page checked, disabled PKCE and Support
instruction. No consumer key or secret is visible in those captures. They are
described here, not embedded or represented as retained repository attachments;
the verifier should independently inspect the app and audit trail.

**Outcome: stopped under Bill's non-editable-control rule.** PKCE was never
unticked, so untick and re-tick UTC times are both not applicable, the temporary
window never started, and no restoration action was needed. No new Link Namespace
attempt, authentication/consent interaction or security-setting save occurred on
13 September. The computer-use skill also reserves security-setting changes to
the operator; no alternate API or control manipulation was used to bypass it.

Option 1 cannot proceed through this UI. Return to Bill and Claude for the
Option 2 / Salesforce Support route; this record does not authorize another
workaround or submit a Support request. The checked app-level PKCE requirement
is now directly observed, but the root cause remains a diagnosis rather than a
Salesforce-confirmed defect. Linking and the prerequisite review remain blocked;
the Phase 1, multi-hub, CI and packaging boundaries above are unchanged.

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
