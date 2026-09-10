# Dependency and licence inventory

Original Kusanya Salesforce, service and future mobile code uses the root
Apache-2.0 licence. ADR 0002 records the service decision. This inventory records
published package metadata; upstream licences/notices remain authoritative.

## Direct dependencies

| Component         | Dependency                     | Pinned version                | Licence                                      |
| ----------------- | ------------------------------ | ----------------------------- | -------------------------------------------- |
| Root tooling      | Prettier                       | 3.9.6                         | MIT                                          |
| Root tooling      | prettier-plugin-apex           | 2.3.0                         | MIT                                          |
| Service runtime   | Fastify                        | 5.12.3                        | MIT                                          |
| Service runtime   | pg                             | 8.23.0                        | MIT                                          |
| Service tooling   | TypeScript                     | 5.9.3                         | Apache-2.0                                   |
| Service tooling   | ESLint                         | 10.10.0                       | MIT                                          |
| Service tooling   | @eslint/js                     | 10.0.1                        | MIT                                          |
| Service tooling   | typescript-eslint              | 8.70.0                        | MIT                                          |
| Service tooling   | @types/node                    | 24.13.4                       | MIT                                          |
| Service tooling   | @types/pg                      | 8.23.1                        | MIT                                          |
| Container runtime | Node.js / Debian bookworm-slim | 24.19.0                       | Node MIT plus bundled third-party/OS notices |
| Database          | PostgreSQL                     | 17 (local verification 17.11) | PostgreSQL License                           |

Direct npm versions/licences were read from the npm registry on 2026-09-10. Both
lockfiles pin the full dependency resolution. The generated
[transitive inventory](dependency-licences.md) records every locked npm dependency.
Regenerate it when either lockfile changes with `node scripts/dependency-licences.mjs`.

## Integration and build tools

Salesforce CLI is an external build tool; CI pins its version. GitHub Actions pins
the checkout/setup-node actions to reviewed commit hashes (MIT).
The container retains upstream licences/notices. Recheck the full image inventory
before a release, including operating-system packages and copied npm notices.

ODK Collect, JavaRosa, ODK Validate and Enketo are planned integrations, not shipped
Phase 0 dependencies. Select exact versions and inspect each component's licence in
the integration ADR; an Enketo server distribution and its renderer may have
different dependencies or licence obligations. No upstream source was copied here.

No paid dependency is introduced. Adding one requires Bill's approval under C12.
