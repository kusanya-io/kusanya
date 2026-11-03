# ADR 0064: Bundled ODK Validate runtime

- Status: Proposed; implementation awaiting independent verification
- Date: 2026-11-03
- Brief sections: C2, C5 publish validation, C8, C11 Phase 1
- Decision owner: Cobitech Solutions
- Extends: ADRs 0024, 0046, 0057 and 0059

## Context

Every publication already passes the bounded ODK Validate 1.20.0 adapter from ADR
0024, but deployments must separately install Java, download the JAR and configure
two absolute paths. The service container contains neither asset. A correctly
configured source checkout can therefore become a running service that accepts
administrator sessions but cannot publish any form. The remaining ODK Validate
runtime-assets strand of note 34 requires one reproducible image-owned boundary.

The validator executes author-controlled XML in a child JVM. Bundling it must not
weaken the existing digest, private-copy, non-shell, environment, heap, time, output
or cleanup controls. The image must not download a mutable latest release at startup
or accept a same-named unreviewed local JAR. ODK Validate and its dependencies are
open-source; no paid dependency or Salesforce collector licence is introduced.

## Decision

The final service image installs Debian's headless OpenJDK 17 runtime and sets the
existing explicit configuration to `/usr/bin/java` and
`/opt/kusanya/ODK-Validate-v1.20.0.jar`. The Docker build acquires the single
official v1.20.0 release asset from its immutable release URL with Docker's
`ADD --checksum` bound to the same SHA-256 enforced on every adapter call:
`92756ea4aed195355a07e5572f025f0921a31282387a870ae63e1f5cdf37e0c3`.
No JAR is committed, accepted from the build context or downloaded when the service
starts. `runtime/*.jar` is excluded from the Docker context.

The image build runs that exact JAR with a tracked, synthetic minimal XForm under a
256 MiB heap and headless mode. A non-zero result fails the image build. It then
removes the build smoke file, makes the JAR and redistribution notice root-owned and
read-only, and retains the existing nonroot `node` runtime user. The final image
contains neither Maven, Gradle, a JDK compiler, curl nor wget.

Service startup performs a second positive control through the same concrete
`ValidateXForm` adapter used by publication. It validates a fixed synthetic XForm
before creating the PostgreSQL pool or opening a listening socket. Pin mismatch,
missing Java/JAR, invalid process execution, timeout, excessive output, invalid
smoke XML or cleanup failure all produce only the fixed startup failure and stop the
service. The full per-publication digest check and private per-call copy remain the
runtime authority; the startup result is never cached as permission to skip them.

The release JAR retains its embedded upstream licences and notices. A shipped notice
records the tagged artifact, digest, embedded dependency versions and licences.
Debian's OpenJDK package notices remain under `/usr/share/doc`. The npm manifests and
lockfiles do not change because neither runtime asset is an npm dependency.

## Consequences and verification

The ordinary final-image build is now a genuine validator smoke test. Static tests
pin the only allowed remote `ADD`, checksum, URL, Java package, image paths, build
smoke, nonroot ordering, notice inventory and exclusion of local JARs. Unit tests
prove startup sends the fixed positive control to the supplied validator and turns
both a refusal and an exception into the same non-disclosing startup failure. A
source tripwire fails on any different checksum, URL or broadened Docker copy/add.

Independent verification should build the final image without a local JAR, inspect
its filesystem and package inventory, verify the release and in-image hashes, run
the JAR as the final `node` user against valid and invalid synthetic XForms, and
prove startup fails before PostgreSQL/socket creation after separately removing or
changing Java and the JAR. It should confirm no validator output or authored XML is
logged or retained after a publication call.

This closes note 34's ODK Validate runtime-assets strand after independent
verification. It is publication infrastructure, not Collect or Enketo behavior and
does not add a C10 acceptance claim or complete Phase 1. Scheduled reconciliation
and retention, unlinked Salesforce File cleanup, privileged retry and privileged
disconnect/rebind remain separate note 34 strands. Note 140 remains an explicitly
unproven genuine-HTTP class-access boundary; no connected app is added here.

The same unit answers notes 138 and 139 by requiring the review-only Salesforce
identity to use `Minimum Access - Salesforce`, exercising that profile in hosted
Apex and changing the permission-set test to an exact top-level element whitelist.
The class-access limitation in note 140 is not restated as execution evidence.

## Revisit when

Changing the validator or Java major version, changing the service base image,
adding an OS sandbox for validator children, publishing multi-architecture images,
or a supported ODK Validate release changes embedded dependencies or licence terms.
