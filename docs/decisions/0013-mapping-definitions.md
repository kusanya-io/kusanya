# ADR 0013: Portable mapping definitions and explicit field sources

- Status: Accepted design decision; implementation awaiting independent verification
- Date: 2026-09-14
- Brief sections: C3.5/.6/.7/.11/.12/.15/.20, C4, C7, C8, C11 Phase 1, C12
- Decision owner: Cobitech Solutions

## Context

After PRs #9 and #7 merged, Bill approved the next C4 model unit. The HWWS worked
example contains an Account reference and two repeat mappings, with no main
mapping. Each repeat combines answers from its own repeat with once-only answers
outside it. Its two relationship mappings supply a parent lookup to the reference.
Those are structural requirements, not permission to copy seed records into tests.

This unit stores definitions. It must not pretend to publish, resolve lookups,
execute transforms or create mapped records. Existing private definition sharing,
empty namespace, verification quotas and independent approval rules still apply.

## Decision

### Ownership and graph

`Mapping` is a non-reparentable master-detail child of Form Version;
`Field_Mapping` is a non-reparentable child of Mapping. Both inherit access and
owner-cascade deletion. Every C4 mapping field is present. Mapping has a human
Name; Field Mapping has an auto-number Name. Order is positive and whole, not
unique; deterministic execution order and topological scheduling are future work.

Kinds are `main`, `repeat`, `reference`. Do not require or limit the number of main
mappings at storage time. A repeat requires a same-version Question of type repeat;
other kinds have no Repeat Question. A reference requires Matching Field (including
`Id` or a non-unique field such as `Name`); other kinds leave it empty. Matching
uniqueness is a publish warning/check, not something storage can infer.

Parent Mapping and Parent Lookup Field are supplied together. A parent must be a
different mapping in the same version. Any kind can supply a parent, including a
reference supplying the resolved Account to a repeat. Cycles are refused. Version
locks serialize graph writers; validation uses the union of stored and proposed
parent edges so a successful partial-DML subset cannot introduce a cycle. An
invalid graph rejects the whole incoming trigger batch with a generic message.
Stage edge reversals by detaching, then attaching in separate writes. This is a
conservative authoring constraint, not a claim of unlimited graph size: queries,
heap and DML remain subject to platform limits.

### Portable target configuration

Target Object, all configured target fields and optional Record Type use one ASCII
API identifier, matching the existing external resolver's lexical contract:
`^[A-Za-z][A-Za-z0-9]*(?:_{1,2}[A-Za-z0-9]+)*$`. There are no traversals, expressions,
URLs or queries in these slots. Preserve spelling and foreign/customer namespaces;
never prepend the Kusanya namespace to target configuration. Salesforce trims
boundary whitespace before validation, so this preserves the normalized identifier,
not its surrounding input whitespace (Claude note 34). Validation does not
assert that a lexically valid identifier exists or is writable. Claude's note 34
confirms that `Account__r`/`Account__R` pass this lexical check as Target Object;
the future publisher must use Describe to reject non-object/non-field identifiers,
not infer schema validity from a suffix or the regular expression.

Record Type stores a portable DeveloperName, not a label or Salesforce ID. Empty
means no explicit record-type override. The publisher must resolve against the
target object's accessible record types and reject missing or ambiguous names;
namespace disambiguation, if needed, requires a reviewed extension before use.
This unit does not resolve RecordTypeId or accept raw record IDs in this slot.

Collector Field and Submission Field describe future trusted stamps. They do not
accept identities from a response, grant target permissions or perform a stamp.
Publish/ingestion must reject competing manual mappings and populate these from
authenticated collector/submission context (C7), with the full acceptance tests.
No collector Salesforce user, licence or sharing record is introduced.

### Question versus constant

Add `Source_Kind` (`question` by default, or `constant`) to Field Mapping. A question
source requires a same-version Question and no constant text. A constant source
requires no Question. `0` and `false` remain literal values, not missing values.
Claude's [PR #10 review 5201392981](https://github.com/kusanya-io/kusanya/pull/10#pullrequestreview-5201392981)
(finding 33) established that Salesforce trims
leading/trailing spaces, tabs and newlines **before triggers**, while retaining
interior spaces. Whitespace-only and empty strings become null. Storage therefore
holds the platform-normalized literal, not a byte-for-byte copy of the input.
The handler does not add its own trimming or reconstruct discarded whitespace.
Null Constant Value in constant mode explicitly means a blank constant; a distinct
typed-null/omit operation is not represented. Do not infer the source from
truthiness. Change mode and its fields together. Whitespace-sensitive constants
need a lossless representation or explicit import rejection before any C3.12
round-trip claim; silently exporting normalized text as unchanged input is not
acceptable. The regression asserts normalization on insert and update.

Question sources may be outside a repeat, preserving once-only values reused by
both HWWS-shaped repeat mappings. This model checks ownership, not executable
answer scope or answerability. The future compiler must permit root/ancestor/same
repeat-instance values, reject sibling/deeper-repeat values without an aggregation
contract, and revalidate after tree changes. It must also check reference matching
inputs, nested-repeat parent compatibility and non-answerable question sources.
Current records saving successfully do not prove executable mapping semantics.

Add a read-only derived `Target_Key`: SHA-256 of Mapping ID, `:`, and lower-case
Target Field. The unique field prevents duplicate assignments to a target within
one mapping, including concurrent/case-variant writes; separate mappings may use
the same field. Trigger logic overwrites supplied keys. Do not export this org-local
key as portable identity. Field writes use two fixed locking queries and no DML.

All twelve C4 transform names are stored in a restricted picklist (default `none`),
not evaluated. Match Status is nullable with **no default `ok`**; Match Detail and
any author-supplied status are untrusted annotations, never publish authorization.
Future validation must recompute diagnostics rather than trust saved flags.

### Deletion and reverse edits

Parent Mapping is a self-lookup without a metadata delete restriction, following
finding 26's demonstrated Salesforce constraint. A direct delete uses one bounded
query and no DML to reject the entire trigger batch if an outside mapping still
references it. Deleting parent and all dependent mappings in the same trigger batch
is allowed. Larger direct deletes may require leaf-first ordering.

Repeat Question and Field Mapping Question are optional clear-on-delete lookups,
with Apex enforcing required source/kind combinations on insert/update. Direct
Question deletion gains two fixed dependency probes in addition to its existing
self-reference probe. Remove dependent mappings/field mappings before deleting a
referenced question; no hidden dependency identifiers appear in errors. Reverse
Question type changes cannot turn a mapping's repeat into a non-repeat. Locks on
referenced records coordinate writes with deletion/type changes.

Form/Version cascades delete both questions and their same-version mapping owners,
so they must not invoke the direct-child guards. Salesforce documents that only
records initiating deletion invoke triggers, not cascade-deleted records in the
[Apex Developer Guide](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_apex_developer_guide.pdf).
The existing owner-scoped Skip Rule cleanup is unchanged. No new native Restrict
lookup or explicit Mapping cleanup is added to the Form cascade. Actual deployment,
direct/grouped deletion, Form/Version cascades, rollback, partial DML and sibling
isolation require real-org tests; source conversion is not that evidence.

Published/submission-aware deletion and undelete remain lifecycle work. In
particular, note 30's observed restoration gaps are not fixed here. A restored or
manually edited definition cannot be treated as published/executable without full
revalidation. This is not completion of C3.11.

### Access and namespace

Extend the unassigned definition-only permission sets to these two objects with
their existing Admin CRUD, Integration read/create/edit and Supervisor read roles.
The derived key is read-only; no View All, setup or target-object grants are added.
ADR 0011's future cross-owner read allowlist is explicitly extended to Mapping and
Field Mapping, with both included in its effective-access tests before Phase 2.
That future read permission is **not implemented in this unit** (note 24).

The project namespace stays empty. Apex/metadata references are local. Existing
external namespace resolution is exercised with both empty and synthetic prefix
fixtures for the new objects/fields and relationships. This proves only resolution,
not a namespaced deployment. No CI, harness pin, org security, package or hosting
change is included; scratch creation requires the normal separate authorization.

## Alternatives considered

- Require one main mapping: rejects the worked example's reference-rooted graph.
- Require every field source inside its mapping repeat: loses once-only answers.
- Infer constants from a missing Question: conflates malformed drafts and explicit
  blank constants; a source discriminator makes round-trip intent testable.
- Store record-type IDs: non-portable across development, verification and customers.
- Native Restrict on Question references: repeats the owner-cascade conflict from
  ADR 0010. Explicit bulk deletion of mappings would add cascade ordering and
  partial-DML complexity without a need in this same-version model.
- Implement the mapping engine now: exceeds this bounded Phase 1 storage unit.

## Consequences and verification

Synthetic tests cover the reference-plus-two-repeat shape, shared once-only
sources, constants, target identity, same-version ownership, graph changes,
reverse edits and deletion. Static contracts check descriptions, picklists and
permission boundaries. The hosted exact-head Apex run and Claude's independent
fresh-org run are required; no development org output is verification evidence.

Finding 32 in that same review observed that a fully rejected
`Database.update(..., false)` restores the measured SOQL counter even though the
guard ran. The reverse-type regression retains rejection/stored-state assertions
and measures the four-query bound only on the successful, unlinked type change.
These test/documentation corrections do not change metadata or handler behavior.

No C10 test is claimed. Publish schema/CRUD/FLS/record-type checks, picklist matching,
lookup ambiguity handling, transactional writes, idempotency, collector stamps,
batch budgets, artifact round trips and tenant isolation remain later units.
Notes 27/28 remain compiler requirements; 29/31 remain separately reviewed tool/CI
hardening, not changes here.

## Revisit when

Implementing compiler/publish/ingestion, supporting repeat-scoped references or
multiple parent lookups, disambiguating packaged record types, implementing
lifecycle/undelete, or observing form-size limits beyond the bounded tests.
