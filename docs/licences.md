# Dependency and licence inventory

Original Kusanya Salesforce, service and future mobile code uses the root
Apache-2.0 licence. ADR 0002 records the service decision. This inventory records
published package metadata; upstream licences/notices remain authoritative.

## Direct dependencies

| Component          | Dependency                     | Pinned version                | Licence                                      |
| ------------------ | ------------------------------ | ----------------------------- | -------------------------------------------- |
| Root tooling       | Prettier                       | 3.9.6                         | MIT                                          |
| Root tooling       | prettier-plugin-apex           | 2.3.0                         | MIT                                          |
| Service runtime    | Fastify                        | 5.12.7                        | MIT                                          |
| Service runtime    | pg                             | 8.23.0                        | MIT                                          |
| Service runtime    | jose                           | 6.2.12                        | MIT                                          |
| Service tooling    | TypeScript                     | 5.9.3                         | Apache-2.0                                   |
| Service tooling    | ESLint                         | 10.10.0                       | MIT                                          |
| Service tooling    | @eslint/js                     | 10.0.1                        | MIT                                          |
| Service tooling    | typescript-eslint              | 8.70.0                        | MIT                                          |
| Service tooling    | @types/node                    | 24.13.4                       | MIT                                          |
| Service tooling    | @types/pg                      | 8.23.1                        | MIT                                          |
| Container runtime  | Node.js / Debian bookworm-slim | 24.19.0                       | Node MIT plus bundled third-party/OS notices |
| Container runtime  | OpenJDK headless (Debian)      | 17                            | GPL-2.0 with Classpath Exception             |
| Service runtime    | ODK Validate                   | 1.20.0                        | Apache-2.0                                   |
| Test image tooling | OpenSSL (Debian package)       | Test-stage package repository | Apache-2.0                                   |
| Database           | PostgreSQL                     | 17 (local verification 17.11) | PostgreSQL License                           |

Direct npm versions/licences were read from the npm registry on 2026-09-10. Both
root/service lockfiles pin the full dependency resolution. The generated
[transitive inventory](dependency-licences.md) records every locked npm dependency.
Regenerate it when any lockfile changes with `node scripts/dependency-licences.mjs`.

## Integration and build tools

Salesforce CLI is an external build tool; CI pins its version. GitHub Actions pins
the checkout/setup-node actions to reviewed commit hashes (MIT).
Workflow validation uses actionlint 1.7.12 (MIT) and ShellCheck (GPL-3.0) as
standalone development tools, not service/runtime dependencies. Public CI verifies
the official actionlint archive against its published SHA-256 digest and uses the
hosted runner's ShellCheck executable, logging both versions. Local reviewers may
use ShellCheck 0.11.0. No tool binaries are committed or shipped with the product.
The service test stage installs Debian's OpenSSL package solely to create a
short-lived localhost certificate for the ADR 0058 wire-contract integration test.
The final runtime stage starts from the clean Node base, so OpenSSL and generated
test keys are not copied into the shipped service image.
The container retains upstream licences/notices. Recheck the full image inventory
before a release, including operating-system packages and copied npm notices.

ADR 0014 introduces **ODK Validate 1.20.0** as the reviewed validation tool, and ADR
0064 redistributes its unmodified release JAR in the service image. The pinned
[Validate licence](https://github.com/getodk/validate/blob/v1.20.0/LICENSE.md) is
Apache-2.0. Docker fetches the immutable release URL only at image build under the
publisher's exact SHA-256; the binary is not committed and is never downloaded at
service startup. The JAR retains its embedded licence/notice entries, and the image
ships `service/runtime/ODK-Validate-v1.20.0-NOTICES.md` with the observed embedded
inventory: JavaRosa 5.1.0, kXML2 2.3.0, Joda-Time 2.10.13, Jackson 2.13.2/2.13.2.1,
Commons CSV 1.4, Commons IO 2.5, Kotlin 1.6.10, selected Bouncy Castle 1.77 classes,
SLF4J 1.7.25/1.7.33, JetBrains annotations 13.0, QDox 1.12 and Hamcrest 1.3. Preserve
that notice, the JAR entries and Debian OpenJDK package notices in redistributed
images. `scripts/check-compiler-odk.mjs` remains the offline fixture probe.

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
