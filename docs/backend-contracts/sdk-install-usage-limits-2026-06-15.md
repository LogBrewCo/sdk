# Backend Contract Report: SDK Install Tracking and Usage Limits - 2026-06-15

## Status

This is an SDK-originated backend contract request from backend, website, and mobile convergence work. Backend handoff is pending because no backend automation/thread target is exposed in this session. Backend coordination reports that the project setup and ingest-key contract is implemented but not confirmed production-available yet, so public SDK docs and examples must not claim this setup flow is live until backend confirms availability. The public SDK repo should not implement or document account lifecycle, provider OAuth, project creation semantics, subscription state, setup status computation, usage accounting, or quota enforcement independently.

## Priority

P1 - This is required for a market-ready onboarding loop. Developers need to know whether a project exists, whether an SDK was initialized, whether first telemetry was accepted, and whether usage is approaching or blocked by limits. SDKs can continue sending telemetry with the current stable ingest client behavior, but LogBrew should not claim setup tracking or usage-limit UX until backend APIs and redacted error envelopes are stable.

## User Impact

Without a shared backend-owned setup and usage contract, website, CLI, mobile, and SDK docs can drift. A real user may install an SDK, send no events yet, or hit a usage limit and still see unclear setup state or misleading next actions. Worse, SDK examples could accidentally teach users to treat account/session bearer values as ingestion keys, which would be unsafe and confusing.

## Expected Backend Capability

LogBrew should expose one shared account/project setup and usage model consumed by website, CLI, mobile, and SDK tooling.

Suggested APIs:

- `POST /api/projects` creates a project in the authenticated account context and may return a one-time project-scoped ingest key.
- `POST /api/projects/{project_id}/ingest-keys` returns a one-time raw submit-only key for an SDK/CLI/browser/server kind.
- `GET /api/projects/{project_id}/setup` returns setup status for onboarding surfaces.
- `GET /api/account/usage` returns account/project usage and limit state for website, CLI, and mobile.

Suggested setup status fields:

- `status`: `created`, `setup_started`, `sdk_seen`, `first_telemetry_seen`, or `active`.
- `project_id`: stable public project identifier.
- `runtime` or `platform`: finite SDK/runtime label such as `node`, `browser`, `python`, `go`, `java`, `dotnet`, `php`, `ruby`, `rust`, `swift`, `kotlin`, `unity`, `c`, `cpp`, or `objc`.
- `source`: finite setup source such as `sdk`, `cli`, `website`, or `mobile`.
- `sdk_name` and `sdk_version`.
- `first_seen_at` and `last_seen_at`.
- `first_telemetry_seen_at` and `last_telemetry_seen_at`.
- `last_release`, `last_environment`, and optional `last_signal`.
- `next_action`: stable onboarding hint for user-facing surfaces.

Suggested event fields on telemetry/check-in intake:

- `sdk_name`: already available in all core SDK client configuration.
- `sdk_version`: already available in all core SDK client configuration.
- `runtime` or `platform`: safely derivable by each SDK package or framework integration.
- `release`: available when the app sends release telemetry or configures release metadata; not reliably available at SDK init today.
- `environment`: available when the app sends environment telemetry or configures environment metadata; not reliably available at SDK init today.
- `project_id`: only if backend returns a public project id or the ingest key safely carries a public-safe id.
- `ingest_key_id`: only if backend returns or encodes a public-safe key id. SDKs must never derive or print it from a raw key.

Ingest key behavior:

- SDKs should accept an opaque project-scoped write-only ingestion key, currently represented in public SDK options as `api_key`.
- When backend availability is confirmed, project setup should return a one-time project-scoped write-only ingest-key DTO with public fields such as `id`, `label`, `kind`, `created_at`, `expires_at`, and a separate raw key value for one-time setup.
- Raw ingest keys should be displayed/used only once for SDK, CLI, browser, or server setup, should use a distinct `lbw_ingest_` prefix, and should authorize telemetry ingestion only for the matching `project_id`.
- Backend coordination reports that successful project-scoped ingest-key creation is expected to mark setup as `setup_started` in backend-owned project state and publish project catalog updates after safe key storage. This is not production-confirmed yet, so SDKs should treat it as pending backend-owned setup state rather than adding local setup markers.
- Key kinds `sdk`, `browser`, and `server` should map to SDK setup source for backend-owned setup tracking, while key kind `cli` should map to CLI setup source. Returned key metadata should still preserve the requested key kind.
- SDKs should continue sending the key as `authorization: Bearer <value>` unless backend publishes a replacement header contract.
- The key must not be a user session value, account bearer value, provider value, or key with read/admin scope.
- SDK docs should call the key submit-only or write-only and should avoid describing backend account/provider/session lifecycle.
- Invalid, expired, or wrong-project ingest keys should return a redacted `ingest_key_invalid` error with an actionable next step and no echoed key text.

Setup proof recommendation:

- First accepted telemetry should be the v1 installed-and-working proof because it proves configuration, network delivery, authorization, project routing, validation, and ingestion acceptance.
- A lightweight SDK check-in is useful only as an optional `sdk_seen` signal for "initialized but no telemetry yet." If added, it must use the same write-only project-key scope, include only primitive SDK/runtime metadata, send no logs/spans/actions/metrics payload, and return only redacted status.

Usage and limit behavior:

- Backend should enforce usage limits on ingest and return stable redacted error envelopes.
- Backend coordination reports configurable account usage/limit enforcement exists in backend code but is not production-confirmed yet, so SDKs should not claim the behavior is live until backend confirms availability.
- Native ingest may return HTTP `429` with redacted JSON fields `code: "usage_limit_exceeded"`, `limit: "events" | "bytes"`, `reset_at`, `error`, and actionable `next` when an incoming telemetry envelope would exceed configured account limits.
- Usage checks happen after auth and before acceptance side effects, so SDKs should treat HTTP `429` as a backend-owned account limit state, not an SDK retry-loop condition.
- `GET /api/account/usage` is the backend-owned source for usage and limit state; SDKs should not derive quota locally.
- Backend coordination reports the account-usage DTO is expected to include `percent_used`, `warning`, `blocked`, `limit`, and actionable `next` fields in addition to usage totals, configured limits, and reset fields. This is not production-confirmed yet, so SDKs and docs should keep treating it as pending backend-owned contract shape.
- Backend coordination also reports live account usage updates exist in backend code but are not production-confirmed yet. Successful native ingest can publish backend-owned usage feed events named `usage_updated`, `usage_limit_warning`, and `usage_limit_blocked`; their payload should match `GET /api/account/usage`, and SDKs should consume them only through backend-owned product surfaces or future stable public contracts.
- Suggested redacted fields also include `status`, `retryable`, optional `retry_after_ms`, and optional `limit_kind` if backend keeps those fields in the stable envelope.
- Error envelopes must never echo raw keys, authorization headers, request bodies, non-public project internals, account/provider details, or user telemetry payloads.

## SDK Gap Observed

Current SDKs already have the minimum metadata needed for first telemetry proof: each core client is configured with `api_key`, `sdk_name`, and `sdk_version`, and transports send JSON to the public event endpoint using an authorization bearer value. SDKs also support release/environment events and most first-useful examples now prove release, environment, log, action/network milestone, metric, and span output.

Gaps:

- There is no explicit SDK setup check-in API.
- There is no SDK-visible project id or ingest key id unless backend provides one.
- Release and environment are event-level signals today, not guaranteed init-time config across all SDKs.
- SDKs do not yet normalize backend usage-limit envelopes into a cross-language public error shape.
- Public docs still use `api_key` wording in many SDKs; future docs should clarify submit-only project-scoped ingestion-key wording after backend finalizes the contract.

SDK constraints:

- Required init fields can stay small: project ingestion key, SDK name, SDK version, and optional endpoint/transport overrides.
- SDKs can reliably add runtime/platform in each package without querying backend.
- SDKs can send release/environment on first telemetry when the app provides them, but should not invent defaults or claim setup completeness from missing release/environment.
- SDK telemetry examples should keep release and environment explicit, and SDK-facing error docs should keep canonical severity vocabulary to `info`, `warning`, `error`, and `critical`.
- SDKs should treat over-limit responses as delivery failures with a stable public code and redacted message. Retryability should follow backend fields; without an explicit retry hint, `usage_limit_exceeded` responses should not be aggressively retried.
- SDKs should preserve queued events on non-2xx responses unless the backend contract later defines a safe drop policy for non-retryable over-limit errors.

## Suggested SDK Work After Backend Contract

- Rename or alias public configuration wording toward `ingestKey` or `clientKey` while keeping backward-compatible `api_key`/`apiKey` where already published.
- Add a dependency-light optional setup check-in helper only after backend publishes the check-in endpoint, redacted response envelope, and auth scope.
- Add cross-language tests for setup check-in success, validation failure, auth failure, and over-limit redacted errors.
- Update public SDK READMEs to say first accepted telemetry is the strongest install proof and that usage/setup status is shown by backend-owned product surfaces.
- Keep SDK examples using placeholder ingest keys only, never account/session/provider bearer values.

## Verification Needed

- Backend tests for project creation, ingest key creation, setup status transitions, usage accounting, and quota/limit envelopes.
- Backend smoke proof that first accepted telemetry moves setup status from `setup_started` or `sdk_seen` to `first_telemetry_seen` or `active`.
- Backend proof that live usage feed events use the same redacted account-usage payload as `GET /api/account/usage`.
- SDK fake-intake tests for HTTP `429` redacted `usage_limit_exceeded` envelopes across at least JS, Python, Go, Java, .NET, PHP, Ruby, and Rust.
- SDK real-user setup proof after backend endpoints exist: create project, create write-only ingest key, send optional check-in, send first telemetry, read setup status from product/API surface, and assert no key or non-public payload appears in logs or errors.
- Confidentiality scans on public docs so account/provider/session/backend internals do not leak into SDK-facing material.
