# ADR 0024: Automatic ODK Validate publication gate

- Status: Accepted design decision; implementation awaiting independent verification
- Date: 2026-09-21
- Brief sections: C3.12/.16, C5 publish validation, C11 Phase 1
- Decision owner: Cobitech Solutions

## Context

ADR 0023 produces deterministic, content-addressed publication bytes after fresh
target-schema preflight, but deliberately labels success as package-only. The build
brief requires every published XForm to pass ODK Validate (JavaRosa). The existing
optional compiler probe runs reviewed ODK Validate 1.20.0 against synthetic fixtures;
it is not an automatic gate over each publication candidate.

Validation has a different trust boundary from compilation. It executes an external
JVM process over author-controlled text. A publisher must not search the host for a
tool, accept an unreviewed JAR, invoke a shell, disclose validator output, wait
forever, or leave candidate XML behind. It must also validate the exact XML placed
in the package, rather than a separately regenerated form.

## Decision

Require `createPublicationPackage` to receive a `ValidateXForm` capability. After
canonical authoring/workbook generation, fresh Describe preflight and target checks,
the package builder passes the exact preflight XML string to that capability. It
returns no package or component hashes unless validation succeeds. A validator
refusal is preserved as a stable structural diagnostic; a thrown provider error is
converted to `PUBLICATION_VALIDATOR_FAILURE` without its message.

Successful results are labelled `odk-validate-1.20.0`, replacing the earlier
`publication-package-only` label. The XForm string passed to validation is the same
string embedded in package JSON and covered by the returned XForm digest. Existing
local, Describe and target refusals still occur before validation and retain their
exact request counts.

Provide one concrete validator factory for ODK Validate 1.20.0. It requires explicit
absolute paths for Java and the validator JAR and never searches, downloads or
substitutes either. On every call it bounds the JAR at 64 MiB and verifies SHA-256
`92756ea4aed195355a07e5572f025f0921a31282387a870ae63e1f5cdf37e0c3`.
The verified bytes, rather than the original path, are copied into a private
per-call temporary directory before execution, preventing a path replacement after
the digest check. The XForm is written beside that copy with owner-only mode where
the platform supports it.

The adapter launches without a shell or stdin, hides the Windows process, uses a
small environment allowlist, fixes the JVM heap at 256 MiB, and passes only the
reviewed JAR and temporary XForm paths. It allows 60 seconds and 1 MiB combined
stdout/stderr; timeout or excess output terminates the child and is an infrastructure
failure. Output is counted and discarded, never returned or logged. A zero exit is
valid, a non-zero exit is `PUBLICATION_XFORM_INVALID`, and spawn, signal, missing-
tool and abnormal-exit failures are `PUBLICATION_VALIDATOR_FAILURE`.

The temporary directory is recursively removed on every path. Failure to clean it
overrides an otherwise successful result with `PUBLICATION_VALIDATOR_CLEANUP`, so a
publisher cannot claim success while candidate material may remain. Results and
diagnostics are frozen and never contain configured paths, process output, input
text or provider errors.

## Consequences and verification

Unit tests assert the exact validated/package XML identity, validation-before-
package behavior, invalid and throwing validator refusal without partial content,
configuration refusal, the reviewed digest constant, pin mismatch, missing tool,
bounded exit handling, timeout, output overflow, immutability and non-disclosure.
The existing offline ODK Validate integration probe
continues to exercise the genuine reviewed JAR with valid and negative fixtures.
No JAR is committed and normal CI does not acquire one.

This closes the automatic ODK Validate gate for the in-memory publication package.
It does not prove Collect or Enketo rendering, interactive behavior, offline use, or
C10.2/.3. JavaRosa 5.1.0 inside ODK Validate remains distinct from Collect's
JavaRosa 6.0.0 runtime. Notes 36 and 37 therefore remain open, and no Enketo or
Android decision is made.

This unit does not authenticate to Salesforce, add the deadline-enforcing Describe
transport required by notes 34/52, persist artifacts, change Form Version lifecycle,
execute mapping transforms, deliver content, or expose CLI/API publication. It adds
no dependency, lockfile, workflow, harness, policy-script or Salesforce metadata
change and makes no C10 or Phase 1 completion claim. Note 53 is not touched because
neither of its conflicting schema/XLSX boundaries changes here.

## Revisit when

Packaging the reviewed JAR and selected Java runtime for deployment, adding
transactional persistence and lifecycle/audit, implementing the authenticated
Describe transport, or exposing the CLI/API publication command.
