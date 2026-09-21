# ADR 0025: Bounded Salesforce REST Describe transport

- Status: Accepted design decision; implementation awaiting independent verification
- Date: 2026-09-21
- Brief sections: C3.5/.16/.20, C5 publish checks, C8, C11 Phase 1
- Decision owner: Cobitech Solutions

## Context

ADRs 0021 through 0024 normalize fresh Describe metadata and use it to build and
validate an exact publication package, but every composition still receives an
injected `DescribeObject` callback. No reviewed boundary constructs a Salesforce
REST request, attaches an integration-user token, bounds network/body latency or
prevents a provider response from consuming unbounded memory. Note 52 specifically
requires both a per-request timeout and an overall Describe deadline.

Tenant OAuth grant selection, refresh-token persistence and key rotation are later
connection work. This unit must not pre-empt that decision or store a credential,
but the HTTP boundary can consume a short-lived token capability supplied by that
future connection layer.

## Decision

Add `createSalesforceDescribeTransport`, a concrete Node `fetch` adapter satisfying
the existing `DescribeObject` contract. Create one adapter for one publication
attempt. It receives a trusted Salesforce instance origin, an asynchronous
short-lived access-token capability, a per-request timeout and an overall timeout.
The overall deadline starts immediately before the first token request and is
shared by every later Describe call through that adapter.

The adapter pins REST API version 64.0, matching `salesforce/sfdx-project.json`,
and constructs this path itself:

`/services/data/v64.0/sobjects/<encoded-api-name>/describe`

Configuration and object names are strictly decoded before token acquisition.
The origin must be an exact HTTPS origin without credentials, a path, query, hash
or explicit port, and its hostname must end in `.salesforce.com`. Government-cloud
or other future Salesforce domains require a reviewed extension rather than a
generic arbitrary-origin escape hatch. Object names use the same bounded lexical
API-name vocabulary as the normalization boundary.

Each request obtains a fresh token, uses GET with JSON accept headers, disables
caching and ambient credentials, follows no redirects and makes no retry. Tokens
are bounded printable non-whitespace ASCII and exist only in the Authorization
header. The transport never logs or returns tokens, URLs, response text, status
text or provider errors.

The per-request timer covers token acquisition, fetch and streamed body reading.
It is capped at 30 seconds. The shared overall timeout is capped at 120 seconds and
must be at least the per-request timeout. Expiry aborts the fetch and cancels a
locked response reader. A response must be a non-redirected HTTP 200 response with an
`application/json` media type. Both a declared length and the decoded response
stream are capped at 8 MiB; decompressed bytes exposed by `fetch` are what count.
UTF-8 is decoded fatally before JSON parsing. All configuration, token, network,
timeout, status, media, size, encoding and JSON failures throw one static internal
transport failure, which ADR 0021 converts to the existing non-disclosing
`PUBLISH_DESCRIBE_REQUEST` diagnostic and exact request count.

The adapter returns parsed JSON only. ADR 0021 remains the sole authority for the
hostile-object, identity, access, type and aggregate metadata checks. The adapter
does not cache Describe results or tokens and must not be reused across publication
attempts because its overall deadline is attempt-scoped.

## Consequences and verification

Unit tests cover the exact pinned URL and request options, a fresh token on each
call, hand-off to the strict normalizer, zero token/network work for invalid object
names, hostile configuration without accessor execution, status and redirect
refusal, wrong media, invalid UTF-8/JSON, declared and streamed size limits, hanging
token/fetch/body operations, body cancellation, the shared deadline and
non-disclosure of provider and token errors.

This implements note 52's deadline requirement at the concrete Describe HTTP
boundary. Note 34 still remains open: this unit does not select an OAuth grant,
persist or rotate tenant credentials, prove integration-user FLS with a restricted
principal, load authoring definitions, persist publication artifacts or expose a
refusing CLI/API publisher. The future connection layer must bind the supplied
origin and token capability to the authenticated tenant; an inbound tenant header
must never select them.

No dependency, lockfile, Salesforce metadata, workflow, verification harness or
policy script changes. No Enketo package is installed and no Collect device or
emulator decision is made. Notes 36, 37 and 39 remain open. Notes 47, 49, 50, 53,
55, 56 and 58 remain informational; note 57 stays with Bill.

## Revisit when

Selecting tenant OAuth and encrypted token storage, supporting a non-commercial
Salesforce domain, changing the repository API version, composing the authenticated
definition reader and refusing publisher, or measuring a lower safe response cap
against customer-org metadata.
