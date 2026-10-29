# ADR 0058: Fail-closed publish CLI executable contract

- Status: Proposed; implementation awaiting independent verification
- Date: 2026-10-29
- Brief sections: C3 defect 16, C5 publish, C8, C11 Phase 1
- Decision owner: Bill Owiti / Cobitech Solutions
- Extends: ADRs 0044 and 0057

## Context

ADR 0057 made the publish CLI a bounded client of the mounted service, but review
found three executable-contract gaps. First, Node can exit successfully while an
awaited Promise is still pending when the underlying transport owns no referenced
handle. An unreferenced deadline timer therefore cannot by itself prevent a silent
exit with code zero. Second, failures before a safe structured result used the same
exit code as a known non-success result. Third, the server and CLI separately stated
the hardened administrator cookie, and the client unnecessarily depended on one
attribute order.

Injected transports prove the client state machine but do not prove that the shipped
binary, Node's global `fetch`, real TLS, the mounted application and PostgreSQL agree
on their wire contracts. Review had to construct that missing end-to-end probe
outside the repository.

## Decision

### A failing process state is the executable default

The executable sets exit code 2 before it parses input or starts asynchronous work.
Only after one complete structured result is written may it replace that default:

- exit 0 means `published` with confirmed session cleanup;
- exit 1 means a bounded structured non-success result was written to standard
  output; and
- exit 2 means no safe structured result was produced and standard error contains
  only the fixed `Publication CLI failed` line, or the process lost all live handles
  while an operation was still pending.

This makes the no-live-handle case fail closed without relying on the transport to
honour abort or to keep the event loop alive. Exit codes remain operational signals,
not permission to retry an uncertain publication.

### The browser-session cookie has one shared contract

`service/src/tenant/administrator-cookie.ts` owns the cookie name, opaque value
shape, lifetime bounds, canonical server serializer and client parser. Browser
routes and the CLI both import it. The server still emits one canonical form. The
client requires exactly `Path=/`, `Secure`, `HttpOnly`, `SameSite=Lax` and one
bounded `Max-Age`, while allowing those attributes in any order. It rejects missing,
duplicated or additional attributes, including `Domain`.

### The repository owns a real executable wire-contract test

The PostgreSQL integration suite launches the compiled CLI as a child process with
its real global `fetch`. It crosses a generated, trusted-for-the-test TLS certificate
and the real mounted application, authenticates a synthetic OIDC actor, reaches the
durable publication route, records the expected tenant-scoped rejection, revokes the
session and checks the database. A second invocation proves that an authentication
failure returns exit 2 with no standard-output document and no credential
reflection.

The CLI deliberately accepts only an origin without an explicit port. The test
therefore uses a local CONNECT proxy to map logical `https://kusanya.test:443` to an
ephemeral TLS listener instead of requiring a privileged host port. The test stage
installs `openssl` only to generate a temporary self-signed localhost certificate;
the final runtime image starts again from the clean Node base and does not contain
that package or the generated key material.

## Alternatives considered

- Reference the deadline timer. Rejected as the primary guarantee because process
  correctness should not depend on a timer being the last live handle; the default
  non-zero exit state protects every pre-result path.
- Call `process.exit(2)` from the timer. Rejected because forced exit can truncate
  output and bypass cleanup. `process.exitCode` preserves normal unwinding.
- Keep one non-zero exit code. Rejected because automation can safely distinguish
  “structured result available” from “no safe result” without revealing provider or
  credential details.
- Duplicate the cookie string and add an equality test. Rejected because two
  implementations can still drift together with their fixtures. One shared module
  makes the server serializer and client parser the contract.
- Bind the integration server directly to port 443. Rejected because it requires
  unnecessary local privilege and makes parallel tests collide.
- Disable TLS verification for the test. Rejected because it would fail to exercise
  the shipped client's certificate-validation boundary.

## Consequences and verification

Unit tests spawn the compiled executable with a transport Promise that never settles
and creates no live handle; it must exit 2 with empty output. Cookie tests cover the
shared canonical form, safe attribute reordering, security-attribute drift,
duplicates, hostile values and lifetime bounds. Existing route and CLI suites then
exercise the shared contract from both sides.

The integration test requires PostgreSQL in protected CI, runs the shipped binary
through real TLS and real composed routes, checks the durable attempt and session
cleanup, and removes all generated certificates and database rows. The test-only
OpenSSL package increases the test image but not the runtime image.

This unit answers notes 123, 124 and 125 if independently verified. It claims no C10
acceptance test: C10 test 12 still requires the seven supplied forms through the
selected real CI workload identity. Note 39 and the remaining note 34 strands remain
open.

## Revisit when

Changing the administrator cookie, CLI output or exit contract, replacing Node's
global fetch, selecting the production workload identity, or running C10 test 12.
