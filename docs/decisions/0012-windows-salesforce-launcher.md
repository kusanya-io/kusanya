# ADR 0012: Preserve validated Windows Salesforce CLI arguments

- Status: Proposed for Claude security review; Bill approved preparation only
- Date: 2026-09-14
- Brief sections: C8, C11 Phase 1 verification, C12; ADR 0006
- Decision owner: Cobitech Solutions

## Context and approval

While addressing PR #9 finding 26, Bill authorized exactly one development org
through `node scripts/builder-org.mjs acquire`, using local builder authentication
and the existing ownership/quota rules. The unmodified command failed during its
initial read-only discovery on Windows, before allocation or an ownership receipt.
No development deployment or Apex execution resulted.

`scripts/salesforce-client.mjs` deliberately invokes `cmd.exe /d /s /c` on Windows
to run the `sf.cmd` launcher. It constructs one command with separately quoted,
validated arguments. Node's default process argument escaping adds backslashes to
those quotes. An echo-only comparison reproduced the escaped arguments, and the
previous unit tests injected a fake `spawn` instead of crossing the real Windows
process boundary. Linux directly spawns `sf` and does not take this branch.

Bill approved preparing the minimal launcher correction for Claude's explicit
security review before another acquisition attempt. This approval does not allow
credentialed execution of the changed tool yet, acquisition before that review,
CI workflow or harness pin change, authentication/security setting change, or
package creation. Bill's one-development-org authorization remains the limit
after the changed launcher is reviewed.

## Proposed decision

Set `windowsVerbatimArguments: platform === 'win32'` on the existing `spawnSync`
call. Windows already receives manually quoted arguments; disable Node's second
quoting pass there only. On other platforms this option is false and ignored.
This follows the documented [Node child-process option](https://nodejs.org/api/child_process.html).
Retain `shell: false`, the explicit Windows `cmd.exe` invocation, the existing
executable names, JSON parsing, redaction, timeouts and environment controls.
`shell: false` is not a claim that no shell is involved: the Windows branch
explicitly starts `cmd.exe`.

Keep every current rejection of quotes, percent expansion, exclamation expansion,
shell operators and control characters. Also reject a Windows argument ending in
a backslash before starting any process. Real `cmd.exe` -> Node argument probes
show that its closing quote otherwise interacts with the trailing backslash and
can absorb the following argument; even two trailing backslashes are not preserved
exactly. This narrow restriction avoids introducing a second serializer in this
fix, consistent with the documented
[Windows argument-parsing rules](https://learn.microsoft.com/en-us/cpp/c-language/parsing-c-command-line-arguments?view=msvc-170).
For a directory argument, omit the trailing separator or use a forward slash;
interior backslashes and spaces remain supported. Non-Windows arguments are
unchanged. No input is silently rewritten, and errors do not echo rejected values.

Neither quota/ownership policy nor builder lifecycle code changes. The one-org
authorization and seven-day maximum still apply; deployment may use only the
positively owned development target. No existing-target input is added to the
fresh verification harness. The unchanged CI pin still selects its reviewed
client version; changing this source file does not silently move that pin. A
future pin update is a separate approval/security-review decision.

Executable discovery still relies on trusted working directories and PATH. This
fix does not harden that pre-existing assumption or authorize substituting a real
Salesforce launcher. Test fixtures intentionally supply an isolated fake launcher
and do not inherit Salesforce authentication or invoke the installed CLI.

## Alternatives considered

- Switch PowerShell to Git Bash: the installed Node is still a Windows process
  and selects the same `cmd.exe` branch.
- Inject a process-local replacement into `acquire`: would execute unreviewed
  allocation behavior outside Bill's approved exact-tool workflow.
- Use a fresh local verification org or manually create one: violates the
  authorized development-tool and verification capacity boundaries.
- Widen allowed shell syntax or replace the launcher/serializer: unnecessary for
  discovery and substantially expands the security review.

## Consequences and verification

Require a real Windows-process regression using the production client and a fake
`sf.cmd` that forwards arguments to a synthetic Node capture program. Check exact
argument boundaries for SOQL, spaces, single quotes, parentheses, colons, Unicode,
interior backslashes and forward-slash directory endings. A negative control
disables the new option and must fail to reproduce the expected arguments.
Check unsafe inputs and trailing backslashes are rejected before the fake process
can execute, with no command-injection side effects or reflected sensitive input.
Keep Linux argument behavior and existing error-redaction/timeout tests unchanged.

Run the Windows tests in both PowerShell and Git Bash. On non-Windows hosts the
real-process cases explicitly skip; the platform-neutral contract tests still run.
Linux public CI success is not proof of Windows process behavior. No fixture
allocates an org, performs authentication, or uses customer/collector data.

This proposal is not proof that finding 26 is fixed in Salesforce. After Claude
reviews the launcher, use only the reviewed builder tool under Bill's one-org
authorization, deploy/test the model there, and release it according to Bill's
instruction. Development output is never verification evidence. Claude's fresh
deployment/deletion probes and the approved exact-head hosted run remain required
before merge. No C10 acceptance test is claimed by this launcher correction.

## Revisit when

An authorized caller needs a trailing-backslash argument, the Salesforce launcher
changes its forwarding behavior, Windows Node process semantics change, or a
separately reviewed executable-discovery/pin update is needed.
