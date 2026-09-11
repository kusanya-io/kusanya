# Contributing to Kusanya

Read `docs/brief.md`, `docs/verification.md`, the worked seed example, then the rest
of `seed/`. Preserve production-derived references; use synthetic tests and do not
copy private payloads to logs, issues, images or fixtures.

## Work and review

Use a branch and one PR per unit of work. Name the brief sections, C10 tests actually
run, ADRs and known gaps. Do not merge your own PR. A phase closes only after Claude
records its independent gate verdict. Read `CODE_OF_CONDUCT.md`.

Record decisions in `docs/decisions/` using the template. Where C12 says ask, obtain
Bill's approval before choosing packaging or paid dependencies. No design may require
a Salesforce licence per collector. Keep customer fields as mapping metadata.

## Prerequisites

Node.js 24, npm, Salesforce CLI 2.135.7, an authorised dedicated Dev Hub, and Docker
for container checks. Bash (included in Git for Windows) runs the workflow-policy
regression tests. PostgreSQL 17 is required for the live integration test.
Developer source work and disposable CI tests do not change C12a hosting: application
development/staging run on Cobitech and production runs on Azure.

From the repository root:

```sh
npm ci
npm run format:check
npm test
npm run check:scaffold
npm --prefix service ci
npm --prefix service run lint
npm --prefix service run typecheck
npm --prefix service test
```

Use the builder-only development org for iterative Apex work; see
`salesforce/README.md`. Do not repeatedly invoke the fresh verification harness.
The builder's Apex evidence is hosted CI on the exact reviewed head. Claude uses
one independent fresh org or pair for the complete relevant suite. Development-org
output is never verification evidence. Read the quota/approval rules in
`docs/ci.md` before requesting a scratch org. Never deploy into the Dev Hub itself
or a customer org. On Windows PowerShell use `npm.cmd` when script policy blocks
the `npm.ps1` launcher; do not weaken system execution policy.

For service integration, inject an existing disposable database URL and TLS policy,
set `REQUIRE_DATABASE_TESTS=true`, and run `npm --prefix service run test:integration`.
The localhost synthetic database can disable TLS in test mode. Production requires
verified TLS. See `service/README.md` for image builds and container test commands.

## Style, dependencies and tests

Use TypeScript strict mode, ESLint and original neutral names. Root Prettier checks
docs, CI, scripts, Apex and service source/tests; generated service output is excluded.
The service also uses its own typed lint configuration. Every
Apex class needs a responsibility header, and every future object/field a description.
No application model exists in Phase 0. Health probes must not disclose credentials.

Commit lockfiles, pin direct dependencies and update `docs/licences.md` plus the
generated dependency inventory on upgrades. Run `node scripts/dependency-licences.mjs`
and `npm run format` after lockfile changes. Do not format the supplied seed or brief.
Put temporary files under ignored `work/`; `.sf/`, `.sfdx/`, `.env` and private keys
must never be committed. Review `git diff --cached` before committing.

No C10 suite exists yet. Add real acceptance tests according to the C11 roadmap;
never satisfy a gate using skipped tests or passing placeholders. Security, offline,
tenant and restore tests must grow with the corresponding capabilities.
