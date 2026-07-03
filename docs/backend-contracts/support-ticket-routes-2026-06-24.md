# Backend Contract Report: Support Ticket Routes - 2026-06-24

## Status

Backend contract status is pending for deploy and live verification. SDK-facing contract notes
say support-ticket storage/routes are code-level verified locally but not deploy/live verified.
SDK-facing contract notes also say that a redacted post-deploy live verifier
exists for the route family; that verifier is useful next-step evidence, but it
does not clear SDK network-call gating until it passes against a deployed API.
This SDK-originated public contract note does not claim that any support-ticket
route is live, documented for users, or safe for SDK network calls yet.

## Priority

P1 - Support tickets are part of the real-user readiness loop because SDK,
CLI, website, docs, and mobile surfaces need a safe way to preserve diagnostics
when install, auth, ingest, billing, or dashboard workflows fail. The SDKs can
prepare explicit local diagnostics drafts today, but they must not open tickets
or call planned backend routes before deploy/live verification.

## User Impact

Without a verified support-ticket backend contract, SDK users can collect useful
local context but cannot rely on LogBrew-hosted ticket creation. If SDKs call the
routes too early, users may see silent failures, duplicate support flows, or
misleading claims that ticket storage exists in production. If SDKs collect too
much context, sensitive runtime or account values could leak into public
examples or diagnostics.

## Expected Backend Capability

Backend should provide authenticated, account-scoped support-ticket storage and
lookup after deploy/live verification, with a redacted post-deploy live verifier
as the required proof path before public SDKs send ticket traffic.

Suggested APIs:

- `POST /api/support/tickets` to create a ticket from an explicit user or agent
  action.
- `GET /api/support/tickets` to list tickets visible to the authenticated
  account.
- `GET /api/support/tickets/{ticket_id}` to inspect one account-visible ticket.

Suggested request fields:

- `source`: stable surface label such as `cli`, `sdk`, `website`, `docs`, or
  `mobile`.
- `category`: stable issue label such as `sdk_install_failure`,
  `ingest_failure`, `auth_failure`, `project_setup`, `dashboard_issue`,
  `docs_confusion`, `cli_issue`, `mobile_issue`, `billing_question`, or `other`.
- `title` and `description`: concise user-visible text.
- Optional context: `project_id`, `environment`, `runtime`, `framework`,
  `sdk_package`, `sdk_version`, `release`, `trace_id`, and `event_id`.
- Optional `diagnostics`: bounded, redacted structured diagnostics.

Required backend behavior:

- Accept ticket creation only from explicit user or agent action, never silent
  SDK background behavior.
- Scope list/detail reads to the authenticated account.
- Redact or reject sensitive auth, browser, account, network, filesystem, and
  exception text before storage or response.
- Return stable validation and method-error envelopes with actionable `next`
  guidance.
- Route each ticket to the expected owning automation lane without requiring
  SDKs to infer ownership locally.
- Publish the route as live only after deploy/live verification proves storage,
  lookup, redaction, and auth behavior against a safe environment. A verifier
  script existing in backend is not enough; the pass result must be reported.

## SDK Gap Observed

Several SDKs already have local-only support diagnostic draft helpers and
installed-artifact smoke coverage. Those helpers intentionally do not send data,
open tickets, call support-ticket routes, use account API material, or infer
backend ownership.

SDKs must not call `POST /api/support/tickets`, `GET /api/support/tickets`, or
`GET /api/support/tickets/{ticket_id}` until backend deploy/live verification
confirms the contract. The current SDK-safe subset is an explicit local
diagnostics draft that:

- validates the future ticket payload shape;
- redacts sensitive auth, browser, network, filesystem, and exception text;
- bounds diagnostic depth, field count, item count, and string size;
- records runtime/package context only when the app or user supplies it;
- leaves ticket submission as an explicit user or agent action.

After backend deploy/live verification, SDK work can add opt-in ticket creation
helpers, but only with explicit user/agent action, placeholder-only public docs,
redacted error handling, and fake-intake or safe-env tests that prove no
account API material is used as ingest configuration.

## Verification Needed

- Backend deploy/live smoke proof for `POST /api/support/tickets`,
  `GET /api/support/tickets`, and `GET /api/support/tickets/{ticket_id}` covering
  success, auth failure, method guidance, invalid payload, invalid ticket id,
  wrong-account lookup, redaction, and no sensitive value echo. The current
  backend live-verifier script can satisfy only the deployed happy-path portion
  after it passes; broader negative-path proof remains required before SDK
  ticket creation is release-ready.
- SDK fake-intake or safe-env tests for any future network helper covering
  success, validation failure, auth failure, retry/non-retry behavior, explicit
  user/agent action, and no silent background ticket creation.
- Installed-artifact smoke proof for each SDK that exposes ticket creation,
  showing local draft creation still works offline and network ticket creation
  remains opt-in.
- Confidentiality scans across public docs, READMEs, tests, examples, and
  reports to prove support-ticket examples use only placeholders and do not
  include private backend details, sensitive account material, screenshots, or
  real user data.
- SDK-facing contract update stating that the route is deployed
  and live verified before SDK docs or examples tell users to call it.
