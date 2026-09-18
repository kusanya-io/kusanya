# ADR 0022: Bounded publication preflight orchestration

- Status: Accepted design decision; implementation awaiting independent verification
- Date: 2026-09-18
- Brief sections: C3.5/.7/.15/.16 foundation/.20, C5 publish checks, C8 field-level security, C11 Phase 1
- Decision owner: Cobitech Solutions

## Context

ADRs 0019 and 0020 define pure validation against a normalized Salesforce target
schema. ADR 0021 obtains that schema through an injected, already-authenticated
Describe function. No reviewed boundary yet composes those parts with the XForm
compiler, derives target object names from the mapping bundle or guarantees that
all local refusals happen before Salesforce metadata I/O.

The composition must not turn a transient caller-owned object into publication
state. In particular, form or mapping mutation while an asynchronous Describe
request is in flight must not make the returned XML disagree with the mappings
checked afterward. The result also must not be mistaken for an immutable stored
publication artifact or a successful Salesforce publication.

## Decision

Add a service-level `preflightPublication` function. It accepts an untrusted form
definition, an untrusted mapping bundle and the ADR 0021 Describe dependency that
is already bound to the tenant integration-user session. It has no route, CLI,
authorization, token, database or blob-storage responsibility.

Before the first Describe request, the preflight:

1. runs shared form preparation;
2. strictly decodes mappings against the prepared question graph;
3. takes bounded detached snapshots of the decoded definition and mappings;
4. compiles the detached definition with the existing XForm compiler; and
5. derives all distinct mapping target objects case-insensitively.

Target casing is selected and object names are ordered by deterministic code-unit
comparison, independent of mapping order. The ADR 0021 loader then makes one fresh
request per distinct target object in that order. Its strict normalized snapshot
is passed with the detached definition and mappings to the ADR 0019/0020 target
validator. No Describe call occurs when local form, mapping or compilation checks
fail. An explicitly empty mapping bundle remains valid and makes zero calls; this
unit does not invent a requirement that every collector form write Salesforce
records.

The first asynchronous boundary occurs only after the detached snapshots and XML
exist. Later caller mutation therefore cannot change target acquisition or final
validation. Provider errors and normalized metadata failures keep the existing
bounded, non-disclosing diagnostics and exact request count. Any refusal returns
diagnostics and the request count only: no XML, hash or partial target list.

Success is labelled `publication-preflight-only` and returns the deterministic XML,
its lowercase SHA-256 digest, the deterministic target-object list, the exact
Describe request count and target-validation warnings. The result, target list,
warning list and warning records are frozen in memory and share no mutable caller
data. This runtime result is not durable, is not a signature and is not the future
immutable publication artifact.

## Consequences and verification

Unit tests cover case-insensitive target deduplication, deterministic order and
hashing, exact request counts, zero I/O on local refusal, empty mappings, provider
and target refusal without partial output, warning propagation and mutation of the
original form and mappings while Describe is pending. Existing compiler, Describe
normalizer and target-validator tests continue to own their detailed structural,
access, datatype and picklist matrices.

This unit does not authenticate to Salesforce, choose an API version, implement the
concrete REST transport, store or refresh tokens, run JavaRosa, execute mapping
transforms, create a database/blob publication record, enforce draft lifecycle,
serve reviewer or collector files, or expose CLI/API publication. Record-type-
specific and dependent-picklist applicability remain open. No C10 acceptance test
or Phase 1 gate is claimed.

Note 34 advances because saved target names now drive fresh Describe and the full
validator refuses missing objects and fields. It remains open until the concrete
authenticated integration-user transport and the publisher using this preflight
are reviewed together. Notes 36, 37 and 39 remain open. Notes 47, 49 and 50 remain
informational. No Enketo dependency is installed and no Collect device/emulator
decision is made. The workflow, Salesforce harness pin and policy scripts are
unchanged.

## Revisit when

Adding tenant OAuth and the concrete Describe transport, canonical immutable
publication storage, automatic JavaRosa validation, executable transforms,
publication lifecycle/authorization, or the CLI/API publication command.
