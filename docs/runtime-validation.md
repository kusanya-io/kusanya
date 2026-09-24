# Compiler runtime validation

This optional local runbook covers synthetic repeat and saved-instance regressions
under [ADR 0015](decisions/0015-client-runtime-regressions.md). It is not a
Salesforce run, deployment, publication approval or C10 acceptance claim.

**Evidence status:** independent exact-head verification of ADR 0028 closed finding
70 and answered note 36. The corrected hashes passed Enketo, JavaRosa and ODK
Validate 1.20.0, and the nested fixture was byte-identical to the candidate Claude
proved on Bill's BlueStacks Pie64 emulator with Android 9 and Collect v2026.3.4.
ADR 0029 separately governs the confirmed count-reduction difference.

## Targets and boundaries

| Layer                 | Target                                                                            | What this can establish                                                                                |
| --------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Compiler source tests | Existing Node 24 service toolchain                                                | Generated paths/wrappers, deterministic bytes and author-note exclusion                                |
| Browser engine        | Enketo Core 9.0.1; Transformer 4.2.0; installed Chromium version recorded per run | Real transformation, `Form` initialization, input changes, model/DOM repeats and saved-instance reload |
| JVM engine            | JavaRosa 6.0.0, as pinned by Collect v2026.3.4                                    | Parsing, traversal, answers, instance serialization/reload and engine count behavior                   |
| Android application   | ODK Collect v2026.3.4 on Bill's BlueStacks Pie64 emulator                         | Actual nested-count navigation, finalized XML and count-reduction behavior                             |

Node 22.23.2, Playwright Core 1.63.0 and esbuild 0.28.2 are isolated optional
tooling, not service runtime dependencies. The runtime package lockfile and JVM
runner hashes pin dependencies. Do not substitute a newer client/JAR silently.
ODK Validate 1.20.0 is a separate parsing check using JavaRosa 5.1.0.

Only built-in synthetic fixtures are accepted by these probes. There are no
production records, credentials, Task links, Salesforce operations or submissions
to a server. Keep output in the working checkout's ignored `work/` directories.
Neither a passing probe nor this document authorizes installs, device changes,
scratch orgs, CI changes or hosted Enketo deployment.

## Reproduce source checks

From `C:\Kusanya\codex\kusanya` in PowerShell:

```powershell
npm.cmd --prefix service test
npm.cmd --prefix service run lint
npm.cmd --prefix service run typecheck
```

The focused compiled test is:

```powershell
node --test service/dist/test/unit/compiler-repeat-runtime.test.js
```

Its fixture builders are in `service/test/fixtures/repeat-runtime.ts`; no original
seed data is copied. The test explicitly asserts `validation: 'structural-only'`.

## Optional browser and JVM probes

### Preparation

Use an explicitly selected portable Node 22.23.2 executable, JDK with `java` and
`javac`, and installed Chrome/Chromium. Do not change global PATH or the service
Node version. Obtain dependencies separately from their official distributions;
the runners must not download dependencies or browser binaries on execution.

The JVM directory must contain the four exact runtime JARs accepted by the
runner: `javarosa-6.0.0.jar`, `kxml2-2.3.0.jar`, `joda-time-2.10.13.jar` and
`slf4j-api-1.7.33.jar`. A matching filename is not enough: hash verification must
succeed. Extra source JARs or compiled prototype files are not inputs.

The following examples use the builder's explicit tool locations. If your tools
are elsewhere, replace only those absolute paths with reviewed local paths.
Dependency installation is a networked preparation step, separate from offline
probe execution:

```powershell
$runtimeNode = 'C:\Kusanya\codex\kusanya\work\node22\node-v22.23.2-win-x64\node.exe'
$runtimeNpm = 'C:\Kusanya\codex\kusanya\work\node22\node-v22.23.2-win-x64\node_modules\npm\bin\npm-cli.js'
& $runtimeNode $runtimeNpm ci --prefix scripts/runtime --ignore-scripts --cache work/npm-cache --no-audit --no-fund
```

Do not install packages in `service/` to satisfy optional probes. Review the
isolated lockfile before installing. Leaflet.draw uses an HTTPS archive of the
exact upstream Git commit, hash-locked, to avoid needing GitHub SSH credentials.
The packages prefer Yarn in their `engines.npm` metadata, so npm reports that
preference even under supported Node 22; this probe deliberately uses npm's
committed lock and disables lifecycle scripts. It does not change service tooling.

The Windows portable Node archive is the official
[Node 22.23.2 ZIP](https://nodejs.org/dist/v22.23.2/node-v22.23.2-win-x64.zip),
verified against the official SHASUMS256 value
`1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97`.
Other platforms must select and verify their matching official Node 22 artifact.

To prepare the four JVM dependencies in this checkout without replacing existing
files, run the following separately from the offline probe:

```powershell
$runtimeJarDir = Join-Path (Get-Location) 'work/javarosa-deps'
New-Item -ItemType Directory -Force -Path $runtimeJarDir | Out-Null
$runtimeArtifacts = (Get-Content scripts/runtime/javarosa-dependencies.json -Raw | ConvertFrom-Json).artifacts
foreach ($runtimeArtifact in $runtimeArtifacts) {
  $runtimeJar = Join-Path $runtimeJarDir $runtimeArtifact.file
  if (-not (Test-Path -LiteralPath $runtimeJar)) {
    Invoke-WebRequest -UseBasicParsing -Uri $runtimeArtifact.url -OutFile $runtimeJar
  }
  if ((Get-FileHash -LiteralPath $runtimeJar -Algorithm SHA256).Hash.ToLowerInvariant() -ne $runtimeArtifact.sha256) {
    throw "Hash mismatch: $($runtimeArtifact.file)"
  }
}
```

The browser tooling's upstream dependency tree has **five npm audit advisories**
(two high, three moderate) as of 2026-09-16. See [the inventory](licences.md).
Do not feed it customer XML, start its server API or treat this as deployment
approval. This probe preserves the upstream renderer's dependency versions for
reproduction; it is not a production security clearance.

### Run

Build the service fixtures first:

```powershell
npm.cmd --prefix service run build
```

Run the real browser transformer and Core engine:

```powershell
& $runtimeNode scripts/runtime/check-enketo.mjs 'C:\Program Files\Google\Chrome\Application\chrome.exe'
```

Run the Collect-pinned JavaRosa engine:

```powershell
& $runtimeNode scripts/runtime/check-javarosa.mjs 'C:\Program Files\Zulu\zulu-21\bin\java.exe' 'C:\Program Files\Zulu\zulu-21\bin\javac.exe' $runtimeJarDir
```

Both commands passed with the tracked runners. Each creates a fresh directory
under `work/runtime-*`, including `nested.xml`, `section.xml`, `fixtures.json`
and `report.json`. The JVM output also contains compiler/runtime logs and four
saved/reduced draft XML files. The browser output retains draft XML and an
isolated synthetic-only browser profile; no operator profile is used.

Record the compiler commit, fixture SHA-256 values, exact engine/browser/Java
versions, exit codes and output paths under `work/runtime-*`. Retain the generated
XML and synthetic saved instances for review. Use a fresh isolated browser
context, not the operator's profile. Page requests are intercepted and aborted;
background networking is disabled and the successful run observed zero fixture
requests. This is not an OS-level network sandbox. Close only the test-owned
browser/processes. Do not expose a web server or remove unrelated
files while cleaning up.

## Required probe matrix

| Fixture                     | Positive checks                                                                                                                                                            | Sensitive comparison                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `nestedCountRuntimeForm()`  | Two `families`; initial `member_count=0`; change counts independently to 2 and 3; three `checks` per family; `once_note` exists once                                       | `../member_count` and `../_ksny_count_checks` preserve each family's context                     |
| `sectionCountRuntimeForm()` | Two `households`; `settings/member_limit` independently becomes 2 and 3; `survey/people` follows it; root `root_count=1` creates one `root_counted` instance per household | `../../settings/member_limit` crosses sibling sections; `/data/root_count` stays once-only       |
| Both                        | Enter distinct synthetic child answers, change nested counts, save, reload and compare per-parent values, counts and metadata                                              | No cross-instance answers; count changes keep a nonempty instance ID; unchanged drafts retain it |
| Answer-driven repeats       | Reduce an already answered count, then save/reload                                                                                                                         | Record retained or removed rows for each engine; do not assume parity                            |

Count each parent's children separately; a matching global total can hide wrong
parent assignment. Check initialization errors, transformed controls, model data
and serialized/reloaded data, not only standalone XPath results. Author Notes
must remain absent while collector Hint text remains present.

Negative controls must demonstrate that the probes detect a wrong nested count
path and the previous metadata/ID defects, as applicable to each engine. Enketo
restores the null-namespace reset and must report `Invalid XML`; JavaRosa removes
the guarded `once()` calculation and must regenerate the identifier on reload. A
negative control's expected failure is separate from the positive suite's exit
status. Do not transfer deliberately broken forms to a user's Collect project.

Enketo natively removes trailing repeats when counts decrease; Collect/JavaRosa
can retain instances. Compiler warning `DYNAMIC_REPEAT_CLIENT_SPECIFIC` records
that divergence. ADR 0029 makes the submitted count authoritative during later
ingestion and excludes trailing instances from normalized Answers/mapping while
retaining the raw submission. The engine probes continue to report raw behavior;
they do not themselves prove the ingestion boundary or C10.2/.3.

## Collect emulator check and repeat procedure

Generate the two positive fixtures and their hash manifest without running any
engine or contacting a device:

```powershell
npm.cmd --prefix service run build
node scripts/runtime/export-fixtures.mjs
```

The 2026-09-23 run used Bill's approved BlueStacks Pie64 emulator, Android 9 and
Collect v2026.3.4. It confirmed per-parent nested counts and retained answered rows
after reduction. It also produced finding 60: changing a nested count could clear
the former qualified `orx:instanceID`, while the otherwise identical conventional
unprefixed metadata retained its UUID. Claude later ran the finding 70 candidate on
the same real Collect boundary: removing `xmlns=""` parsed successfully, nested
counts expanded during entry and finalization retained a populated instance ID.
No continuing device access, installation, upgrade or deletion is implied. A
different client version requires a recorded test-matrix change, not an unlabelled
substitution.

With that approval, use a dedicated offline synthetic-test project and no real
collector credentials. Bill controls any USB debugging authorization. Official
[ODK USB loading instructions](https://docs.getodk.org/collect-forms/#managing-forms-without-a-server)
and [ADB directory guidance](https://docs.getodk.org/collect-adb/#identifying-the-collect-directory-on-your-device)
describe direct form transfer. Modern Collect stores separate project directories;
identify the approved project by its name marker rather than assuming the first
directory is disposable.

1. Select the reviewed generated XML artifacts and record their SHA-256 values.
   Copy only the two positive fixtures by USB into the approved project's
   `forms` directory, retaining explicit filenames. Do not overwrite an existing
   definition with the same identity without Bill's approval.
2. Start the nested fixture. Enter a once-only note and follow both families.
   Initially enter zero members; then set family 1 to two and family 2 to three.
   Enter distinct values such as `F1-M1`, `F1-M2`, `F2-M1` through `F2-M3`.
   Confirm three fixed checks per family and enter distinct check notes.
3. Save as a draft, exit the form, reopen that exact draft and compare every
   answer and each family's count. Do not finalize or send it to a server.
4. Repeat with the section fixture: household limits two and three; the root
   count remains one. Confirm per-household person rows and one shared-count
   observation per household; enter distinct notes and save/reopen.
5. On a separate synthetic draft, reduce an answered count. Record what the UI
   retains, hides or removes and compare saved XML, without assuming it should
   match Enketo's deletion behavior. Save/reopen and record the result again.
6. If Bill approves reading those test instances, copy only their identified
   synthetic instance files back by USB. Compare original/reopened instance IDs
   and confirm a newly started draft has a different ID. Do not bulk-pull other
   project data, logs, databases or device bug reports.

Screenshots must show only this synthetic project and no unrelated notifications
or identifiers. Do not reset, uninstall, clear app data or recursively delete
project directories. Bill decides whether to retain or remove the test forms and
drafts afterward. If debugging was enabled for this check, Bill should disable it
when finished, following [ODK's ADB safety guidance](https://docs.getodk.org/collect-adb/).

## Evidence record

| Check                           | Result                                                         | Evidence to record                                                                            |
| ------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Final source/unit suite         | Service 216/216; targeted renderer 10/10 passed                | Includes namespace, metadata and warning regressions; engine tests are not service unit tests |
| ODK Validate 1.20.0             | Six candidate fixtures accepted; two negative controls refused | Reviewed JAR SHA-256 `92756ea4`; both exact runtime fixtures parse                            |
| Tracked Enketo runner           | Passed, exit 0, Chromium 153.0.8010.53                         | `work/runtime-enketo-82D6HG/report.json`; null-namespace negative reproduces `Invalid XML`    |
| Tracked JavaRosa runner         | Passed, exit 0, JavaRosa 6.0.0                                 | `work/runtime-javarosa-g6ukde/report.json`; count changes kept a nonempty stable ID           |
| Real Collect UI                 | Finding 70 candidate proved after the earlier finding 60 run   | BlueStacks Pie64, Android 9, Collect v2026.3.4; verifier evidence is attached to issue #46    |
| Claude independent verification | Pending exact-head PR review                                   | Review URL and verdict                                                                        |

Note 36 is answered for Collect and has matching authorized Enketo candidate
evidence, but remains open until exact-head independent verification. No C10 test
is claimed: C10.2/.3 also
require mapping/Task/cardinality behavior, and C10.13 requires real browser/phone
delivery and Task-link workflow. Keep earlier carried notes and normal Salesforce
CI approval requirements separate from these probes.

Both tracked engine runs consumed exactly these compiled bytes:

- `nested.xml`: SHA-256 `1f040f016e182f2fa9525f46e2c19cd1fc74d843f8422bf2ee5a72c6383c75b3`
- `section.xml`: SHA-256 `b7fed74296c2f74140b525c9206ce46734ba80620dc35d7ffe486ca86bb70f60`

Reports are local builder evidence, not Claude's verdict. The PR supplies the
reviewed source commit. Re-run from that exact source after building the service;
generated UUIDs and saved-instance hashes naturally differ between new runs.
