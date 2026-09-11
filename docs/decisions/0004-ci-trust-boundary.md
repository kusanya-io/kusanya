# ADR 0004: Separate public CI from approved Salesforce validation

- Status: Superseded in part by ADR 0005 (trigger and harness-selection policy)
- Date: 2026-09-10
- Brief sections: C8, C11 Phase 0, C12, C13; verification protocol
- Decision owner: Cobitech Solutions

Historical first implementation below. Bill approved the automatic same-repository
PR approach on 2026-09-10 after Claude's finding 1. ADR 0005 and `docs/ci.md` describe
the current policy; the manual-only bootstrap limitation below is no longer the
intended design. Environment/secret/required-check setup still needs a maintainer.

## Context

Public PRs can contain untrusted executable code. Salesforce tests require an
authenticated Dev Hub. C12a forbids self-hosted GitHub runners on this public
repository. C11 requires real Apex tests with at least 85% coverage.

## Decision

Run public PR lint, metadata checks, coverage-gate tests, service tests and container
tests on GitHub-hosted Ubuntu without Salesforce credentials. Pin actions to verified
commit hashes. Use a separate default-branch dispatch workflow and the `salesforce-ci`
environment with required reviewers for credentialed Salesforce validation.

The maintainer supplies the reviewed same-repository PR number and full head SHA.
The job checks that SHA against GitHub, checks out the trusted default-branch harness
separately, and runs it against reviewed Salesforce metadata. No PR npm/JavaScript or
shell script is executed with the Dev Hub credential. Reject direct fork metadata;
a maintainer must review and stage it in a repository branch before this validation.

Use API 64.0 for the initial source metadata, verified by real scratch deployment.
The smoke class exists solely to make deployment/test/coverage tooling executable.
It is not evidence for C10 capabilities. Coverage uses exact line counts, includes
every production source class/trigger and fails on missing or failed/skipped tests.

## Alternatives considered

Credentialed `pull_request_target`, unrestricted PR jobs and self-hosted runners
would expose credentials or Cobitech workloads to contributor code. Treating absent
credentials as a passing Apex test would conceal missing verification. Keeping the
trusted harness separate reduces which reviewed code executes beside the credential.

## Consequences and verification

The first PR cannot dispatch a new workflow before it exists on the default branch.
Its builder/verifier must record local scratch results separately; hosted Apex
validation needs maintainer bootstrap. A green public CI badge alone never passes
the phase gate. This is an explicit temporary departure from automatic Apex testing
on every PR; subsequent reviews require the separate Salesforce run for the exact SHA.
No builder merges or changes main to bootstrap the workflow.

Environment protections/secrets and branch-required checks need maintainer setup.
Discussions and release/deployment configuration are deferred. No deployment job is
introduced. See `docs/ci.md` for the concrete runbook and failure handling.

## Revisit when

The trusted harness is on main, external contributions increase, or a least-privilege
automation approach can safely attach approved Apex results directly to PR checks.
