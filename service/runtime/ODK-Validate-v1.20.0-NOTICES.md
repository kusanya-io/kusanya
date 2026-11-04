# ODK Validate 1.20.0 runtime notices

The Kusanya service image redistributes the unmodified
`ODK-Validate-v1.20.0.jar` release asset from
<https://github.com/getodk/validate/releases/tag/v1.20.0>.

- Release SHA-256: `92756ea4aed195355a07e5572f025f0921a31282387a870ae63e1f5cdf37e0c3`
- ODK Validate licence: Apache License 2.0
- The JAR retains its upstream `LICENSE` and `NOTICE` entries.

The tagged build and embedded Maven metadata identify these bundled components:

| Component                         | Version                    | Licence                           |
| --------------------------------- | -------------------------- | --------------------------------- |
| JavaRosa                          | 5.1.0                      | Apache-2.0                        |
| kXML2 / XmlPull API               | 2.3.0                      | BSD-style / public-domain notices |
| Joda-Time                         | 2.10.13                    | Apache-2.0                        |
| Jackson annotations/core/databind | 2.13.2 / 2.13.2 / 2.13.2.1 | Apache-2.0                        |
| Apache Commons CSV                | 1.4                        | Apache-2.0                        |
| Apache Commons IO                 | 2.5                        | Apache-2.0                        |
| Kotlin standard library           | 1.6.10                     | Apache-2.0                        |
| Bouncy Castle provider classes    | 1.77                       | MIT-style Bouncy Castle licence   |
| SLF4J API / NOP binding           | 1.7.33 / 1.7.25            | MIT                               |
| JetBrains annotations             | 13.0                       | Apache-2.0                        |
| QDox                              | 1.12                       | Apache-2.0                        |
| Hamcrest                          | 1.3                        | BSD-3-Clause                      |

The container also installs Debian's headless OpenJDK 17 runtime. Its package
copyright and licence files remain under `/usr/share/doc` in the image. Preserve
this notice and the JAR's embedded notices in every redistributed image.
