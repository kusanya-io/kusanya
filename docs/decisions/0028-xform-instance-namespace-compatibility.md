# ADR 0028: XForm instance namespace compatibility

- Status: Accepted and independently verified
- Date: 2026-09-24
- Brief sections: C2, C3.6, C3.19, C5, C11 Phase 1, C12
- Decision owner: Cobitech Solutions
- Tracking issue: [#46](https://github.com/kusanya-io/kusanya/issues/46)

## Context

ADR 0015 and the finding 60 correction established that Collect requires the
conventional unprefixed `<meta><instanceID/></meta>` shape when nested counted
repeats change during entry. The compiler retained the document's default XForms
namespace declaration but also emitted `xmlns=""` on the instance `<data>` root.
That reset moved the complete instance into the null namespace.

The first authorized run of the pinned Enketo Core 9.0.1 and Transformer 4.2.0
tooling reproduced finding 70: Transformer did not recognize the null-namespace
metadata, injected `<xf:meta><xf:instanceID/></xf:meta>` without declaring `xf`,
and Enketo Core refused the resulting malformed model as `Invalid XML`. Both
tracked runtime fixtures failed before initialization.

Four isolated browser variants showed that metadata qualification was not the
cause. Removing only `xmlns=""` let Transformer recognize and retain the existing
unprefixed metadata and initialize cleanly. That same candidate passed the tracked
JavaRosa 6.0.0 probe and a real ODK Collect v2026.3.4 device run: nested repeats
expanded independently after their counts changed, and the finalized submission
kept a populated `instanceID`.

## Decision

### Keep the instance in the default XForms namespace

The compiler emits `<data id="..." version="...">` without a namespace reset.
Because the document root declares `http://www.w3.org/2002/xforms` as its default
namespace, the instance root and its unprefixed descendants remain in the XForms
namespace. The compiler continues to emit the conventional unprefixed
`<meta><instanceID/></meta>` block and bind `/data/meta/instanceID` with
`once(concat('uuid:', uuid()))`.

The renderer unit test must assert both the exact `<data>` opening tag and the
absence of `xmlns=""`. The tracked Enketo runner must make the same refusal check
before browser initialization, then require zero initialization errors and exactly
one populated `instanceID` before and after repeat changes and saved-instance
reload. A future refactor cannot restore the reset while leaving only a metadata
shape test green.

### Require all established compatibility boundaries on the same bytes

The exact compiler output reviewed in this unit must pass:

1. the service renderer and compiler suites;
2. ODK Validate 1.20.0 through the ADR 0024 pinned adapter;
3. the isolated Enketo Core 9.0.1 and Transformer 4.2.0 browser probe;
4. the tracked JavaRosa 6.0.0 probe; and
5. the already-recorded real Collect v2026.3.4 device procedure, independently
   repeated by the verifier if the reviewed bytes differ from the proven candidate.

Engine and device evidence remains synthetic runtime evidence. It does not prove
server delivery, Tasks, mappings, ingestion, authentication or any C10 acceptance
test. Enketo's removal of answered rows after a count reduction and Collect's
retention of them remain a genuine client difference governed by ADR 0029.

### Keep the tooling isolated

This unit uses Bill's approved, already-installed optional Enketo tooling. It adds
or updates no dependency, lockfile, lifecycle script, browser installation,
workflow, Salesforce metadata, harness or policy script. The probe continues to
use a fresh blocked-network browser profile and synthetic fixtures only. It does
not authorize a hosted Enketo deployment, dependency upgrade or further device
access.

## Alternatives considered

- Restore qualified `orx:meta`: Enketo accepts it, but the real finding 60 Collect
  sequence can finalize with an empty instance identifier.
- Keep the null-namespace instance and patch the transformed model: treats a
  malformed intermediate result rather than emitting the interoperable source.
- Maintain separate Collect and Enketo XForms: violates the product requirement
  that one published form runs offline and online.
- Count JavaRosa as sufficient device evidence: the finding originated in Collect's
  application behavior, and the candidate has now also been tested there.

## Consequences and verification

Removing the namespace reset changes every compiled XForm byte stream and therefore
changes fixture hashes and any ADR 0023 package digest derived from it. Compilation
remains deterministic, and no previously published production artifact exists in
this repository that requires migration.

Independent verification of the exact reviewed head ran the ordinary suites, ODK
Validate, the Enketo probe and the JavaRosa probe, and matched the generated source
to the device-tested candidate. Finding 70 is closed and note 36 is answered at
this compiler/runtime boundary. ADR 0029 selects the later ingestion-cardinality
rule for note 37.

This unit makes no C10, deployed-Enketo, publish-ready or Phase 1 completion claim.
Notes 34, 37, 39 and 69 and the carried operational notes are unchanged.

## Revisit when

The selected Enketo or Collect version changes, the XForm root namespace changes,
metadata nodes or their bind change, a delivery serializer rewrites namespaces, or
the reviewed count-reduction policy changes.
