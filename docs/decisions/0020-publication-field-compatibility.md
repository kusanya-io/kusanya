# ADR 0020: Publication field datatype and base picklist compatibility

- Status: Accepted design decision; implementation awaiting independent verification
- Date: 2026-09-17
- Brief sections: C3.5/.7/.15/.20, C4 mappings, C5 publish checks, C8 field-level security, C11 Phase 1
- Decision owner: Cobitech Solutions

## Context

ADR 0019 verifies that configured target objects and fields exist and that the
integration user can access them. It deliberately left datatype and picklist
compatibility open. A mapping could therefore pass while sending a text answer to
a Boolean field, an unjoined select-many answer to a Salesforce multipicklist, or
an inactive value to a restricted picklist.

The future publisher still needs a fresh Salesforce Describe adapter, executable
transform implementations, JavaRosa validation, immutable storage and a CLI/API.
Combining those boundaries would make the next publication change too large to
review safely.

## Decision

Extend ADR 0019's normalized field snapshot with a lower-case canonical Salesforce
field type, `nillable`, `restrictedPicklist`, and bounded active/inactive picklist
values. The strict decoder accepts the documented canonical type enumeration and
refuses unknown types, malformed values, duplicate values, picklist metadata on a
non-picklist field, reference targets on a non-reference field, more than 2,000
values on one field or more than 10,000 values in one snapshot. A future Describe
adapter owns conversion from Salesforce's wire spelling to this canonical shape.

For each manual field assignment, publication checks both the source/transform
pair and the transform/target pair:

- `none` permits text-like answers to text-like or single-picklist fields,
  integers to numeric fields, decimals to decimal-capable numeric fields,
  select-one values to text or single-picklist fields, select-many values to text,
  date/time/datetime to the matching type, and geographic text to text fields.
  Calculate and media answers require an explicit transform.
- `picklist_match` requires select-one or a nonblank constant and a picklist or
  combobox target. `multi_select_join` requires select-many and a multipicklist or
  text target.
- `lookup_by_external_id` requires a scalar text/select-one source and a reference
  target. It does not choose or query the referenced object's external-ID field;
  that execution contract remains open.
- `date_only`, `boolean_yes_no`, `number`, `text_truncate`, the three geopoint
  component transforms and `file_url` each require their corresponding source
  category and target category. This validates configuration only; it does not
  execute or silently invent a transform.

For a restricted picklist or multipicklist, every possible authored choice value
must match an active target value exactly and case-sensitively. A nonblank constant
must also match. An unrestricted picklist does not require membership. A null
constant retains ADR 0013/0017's meaning of an explicit blank: it is accepted only
without a transform and only when the target is nillable. Diagnostics expose only
stable codes and structural locations, never question, constant or picklist text.

The existing success label remains `validation: target-schema-only`. It means the
supplied normalized snapshot and portable mapping are compatible at this pure
boundary; it is not evidence that the snapshot is fresh, a transform exists, an
artifact is publishable, or Salesforce will accept every future response value.

## Consequences and verification

Unit tests cover all twelve stored transform names, direct scalar assignments,
wrong source/transform and transform/target pairs, inactive and missing restricted
picklist values, blank constants, hostile schema shapes, deterministic behavior,
input immutability and diagnostic non-disclosure. Tests use synthetic schema only.

Salesforce field constraints that depend on actual values remain future work,
including text length, numeric precision/scale, URL/email/phone lexical rules,
reference external-ID selection, compound fields and record-type-specific picklist
restrictions. Those checks belong with the reviewed Describe adapter and executable
publisher rather than being inferred from incomplete metadata here.

No Salesforce call, metadata, permission, workflow, dependency, route, persistence,
delivery authorization or transform execution is added. Note 34 remains open until
a fresh integration-user Describe adapter and refusing publisher are reviewed.
Notes 36, 37 and 39 remain open. Notes 24, 25, 27-31 and 35 carry forward; note 42
remains informational. No Enketo dependency is installed and no Collect device or
emulator decision is made. No C10 acceptance test or Phase 1 gate is claimed.

## Revisit when

Adding the Salesforce Describe adapter, record-type-specific picklist metadata,
transform execution, value-size validation, immutable publication or CLI/API
publication.
