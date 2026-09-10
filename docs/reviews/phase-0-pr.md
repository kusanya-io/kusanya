# Phase 0: repository scaffold and verification foundation

Kusanya needs a reproducible source tree and a test gate before form collection is
implemented. This change adds the Salesforce scratch scaffold, a runnable service,
CI workflows, contribution guidance and recorded architecture decisions.

Brief sections implemented: C11 Phase 0; C2 service/component boundaries; C8 initial
operational/security foundation; C12/C12a environment constraints; C13 repository,
licence and contributor scaffolding.

Acceptance tests claimed (brief C10): **none**. C11 assigns no C10 product tests to
Phase 0. Later-phase tests are listed as unimplemented, not represented by stubs.

## Changes

- `salesforce/`: SFDX project, Developer scratch definition, runtime smoke class and
  its no-query/no-DML Apex test, plus source-deploy instructions.
- `service/`: TypeScript/Fastify, validated configuration, process and PostgreSQL
  probes, bounded pool/shutdown behavior, unit/integration tests, pinned lockfile
  and nonroot Docker test/runtime targets.
- `mobile/`: explicit stock Collect/future Kotlin client boundary.
- `scripts/`: safe scratch lifecycle, exact-line Apex coverage gate and negative
  tests, metadata checks and dependency licence inventory generator.
- `.github/`: credential-free public CI, approved Salesforce verification workflow,
  issue forms and PR template.
- `docs/`: architecture, threat model, API/status docs, roadmap, CI instructions,
  dependency inventory, four ADRs and reusable ADR template.
- Root: contribution/conduct guidance, formatting and secret/build ignores.

## Builder validation

- `npm run format:check`: passed.
- `npm test`: seven coverage-gate tests passed, including the exact 85% threshold,
  rounded percentages, missing coverage and failed/skipped tests.
- `npm run check:scaffold`: passed.
- Service lint, typecheck and unit suite: passed (eight unit tests).
- Service integration with disposable PostgreSQL 17.11: two passed with
  `REQUIRE_DATABASE_TESTS=true`, including a real successful readiness query and
  a real driver timeout. No customer data used.
- Real scratch-org deployment through `Kusanya-DevHub`: two Apex components
  deployed, one test passed, two of two executable lines covered (100%).
- Reusable `node scripts/verify-salesforce.mjs`: ran successfully against a new
  scratch org, enforced coverage and cleaned up its own org.
- GitHub workflow syntax: actionlint 1.7.12 passed; its download SHA-256 was checked
  against the upstream release asset digest.
- Both npm installs reported zero audit vulnerabilities at validation time.
- Runtime Docker base tag verified to publish a Linux amd64 image.
- [Hosted public CI run 34484972208](https://github.com/kusanya-io/kusanya/actions/runs/34484972208):
  passed for implementation commit `23c509b9f8892db7ea19b8e2a93bcef293c075f0`.
  Both jobs passed, including eight unit and two live PostgreSQL integration tests
  inside the Linux test container, plus the production runtime image build.
  The initial run caught a PostgreSQL health-command quoting error; this run
  confirms the corrected runner configuration.

## Reproduction

Follow `CONTRIBUTING.md`, `salesforce/README.md`, `service/README.md` and `docs/ci.md`.
From repository root in PowerShell:

```powershell
npm ci
npm run format:check
npm test
npm run check:scaffold
npm --prefix service ci
npm --prefix service run lint
npm --prefix service run typecheck
npm --prefix service test
$env:KUSANYA_DEV_HUB = 'Kusanya-DevHub'
node scripts/verify-salesforce.mjs
```

Inject a disposable PostgreSQL URL and TLS policy in the environment, set
`REQUIRE_DATABASE_TESTS=true` and run `npm --prefix service run test:integration`.
For the mandatory container check:

```sh
docker build --target test -t kusanya-service-tests ./service
docker run --rm kusanya-service-tests
docker build -t kusanya-service:phase0 ./service
```

## Decisions recorded

- ADR 0001: TypeScript, Fastify and PostgreSQL for the service.
- ADR 0002: One monorepo and Apache-2.0 for original service code.
- ADR 0003: Phase gates, client boundaries and deliberate exclusions.
- ADR 0004: Separate public CI from approved Salesforce validation.

## Known gaps and deviations

- A new Salesforce dispatch workflow must first exist on the trusted default
  branch. Its protected environment, required reviewers and dedicated secret need
  maintainer configuration. This temporary manual/local Apex gate is recorded in
  ADR 0004; the public CI badge alone does not close Phase 0.
- Package selection/registration, release IDs, exact client versions, tenant OAuth,
  product model/migrations, all C10 tests and deployment are deferred. No paid
  dependency or per-collector Salesforce licence is introduced.
- The seed has one worked form, not seven definitions, and no XLSForm exports.
  Supplied reference files and the brief are unchanged.
- No HP/Cobitech environment was deployed or altered. Discussions and release
  configuration are deferred, and production remains Azure-only.

## Verifier focus

Check the CI credential/approval boundary and first-PR bootstrap limitation, the
coverage parser's fail-closed behavior and scratch cleanup, and probe/TLS/timeout
behavior in the actual Linux container. Confirm no C10 capability is claimed.

The builder does not merge this PR or close the phase. Claude must record the gate
verdict under `docs/verification.md` after all required evidence is available.
