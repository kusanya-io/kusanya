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
root/service lockfiles pin the full dependency resolution. The generated
[transitive inventory](dependency-licences.md) records every locked npm dependency.
Regenerate it when any lockfile changes with `node scripts/dependency-licences.mjs`.

## Integration and build tools

Salesforce CLI is an external build tool; CI pins its version. GitHub Actions pins
the checkout/setup-node actions to reviewed commit hashes (MIT).
Local workflow validation for issue #5 uses actionlint 1.7.12 (MIT) and
ShellCheck 0.11.0 (GPL-3.0), standalone development tools, not service/runtime
dependencies. No tool binaries are committed or shipped with the product.
The container retains upstream licences/notices. Recheck the full image inventory
before a release, including operating-system packages and copied npm notices.

ADR 0014 introduces **ODK Validate 1.20.0** as an optional local development tool,
not a bundled service dependency. Its release includes JavaRosa 5.1.0. The pinned
[Validate licence](https://github.com/getodk/validate/blob/v1.20.0/LICENSE.md) is
Apache-2.0; [the tagged build](https://github.com/getodk/validate/blob/v1.20.0/build.gradle)
records JavaRosa and the other bundled libraries. The upstream jar stays in ignored
`work/`, retains upstream notices and is not committed or copied into any image.
`scripts/check-compiler-odk.mjs` checks the release SHA-256 before running synthetic
fixtures offline. Reinventory all transitive licences before any redistribution.

ODK Collect and Enketo remain planned runtime integrations, not shipped dependencies
or deployed services. ADR 0014 identifies intended compatibility targets, not proven
runtime compatibility. An Enketo server distribution and its renderer may have
different dependencies or licence obligations; inspect the selected distribution
before deployment. No upstream source was copied into the compiler.

### Optional client runtime probes (ADR 0015)

`scripts/runtime/package-lock.json` is a third, isolated tooling lockfile. Its
dependencies are not installed by CI or the service image and are not deployed:
Enketo Core 9.0.1, Enketo Transformer 4.2.0 and Playwright Core 1.63.0
(Apache-2.0), plus esbuild 0.28.2 (MIT). The inventory above now includes their
locked transitive and optional-platform packages under `runtime-probe`.
The Leaflet.draw source is the exact upstream-pinned commit
`ff730785db7fcccbf2485ffcf4dffe1238a7c617`, acquired as a hash-locked HTTPS
archive instead of requiring GitHub SSH credentials. There is no source patch.
Upstream package notices remain in the optional installed packages, and the
synthetic browser view retains a Powered by Enketo attribution.
`jquery-touchswipe` 1.6.19 uses an old plural `licenses` metadata field, so the
lockfile omits it. Its published LICENSE explicitly offers MIT or GPL Version 2;
the optional probe selects the MIT option, recorded by the version-specific
inventory override. Preserve that upstream notice.

The offline JVM probe verifies the four exact artifact hashes and upstream
license references in `scripts/runtime/javarosa-dependencies.json`: JavaRosa
6.0.0 and Joda-Time 2.10.13 (Apache-2.0), slf4j-api 1.7.33 (MIT), and kxml2
2.3.0 (BSD-style kXML2/public-domain XmlPull API). This small fixture runtime is
not a full JavaRosa distribution. JARs and portable Node remain ignored local
tools; none is bundled into the product.

**Security limitation:** the isolated npm audit on 2026-09-16 reported five
advisories: two high (`@xmldom/xmldom` 0.7.13 and `undici` 5.29.0) and three
moderate through their dependency chains. Versions are preserved to test the
upstream renderer, not approved for production. Only built-in synthetic XML is
fed to the probe; page requests are blocked and no server API is started. Do not
use this tooling with customer XML or deploy it. Reassess and resolve applicable
advisories before choosing a deployed Enketo distribution; do not apply npm's
suggested major downgrades as an automatic fix.

No paid dependency is introduced. Adding one requires Bill's approval under C12.
