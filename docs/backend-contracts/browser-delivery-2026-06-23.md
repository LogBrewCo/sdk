# Backend Contract Report: Browser Delivery Under Unload and Offline Pressure - 2026-06-23

## Status

Backend contract status is pending. This report is SDK-originated from public browser SDK verification and competitor source comparison. It does not claim any new backend route is live.

## Priority

P2 - Browser developers expect telemetry delivery to survive navigation, tab close, temporary connectivity loss, and quota/rate-limit responses. LogBrew now has bounded fetch keepalive, lifecycle flush reasons, return-online in-memory recovery, explicit persisted fetch-batch replay, retry-after parsing, and high-load queue-drop reporting, but remains weaker than Sentry, Datadog, and PostHog for beacon-style exit delivery until backend defines an authorization-safe browser unload contract.

## User Impact

Without a backend-owned browser unload contract, the browser SDK must keep using `fetch` with header-based client-key delivery. That is safer for today's public auth model, and the SDK can now persist failed fetch batches without storing the browser key, but it still cannot match competitor `sendBeacon` behavior in all page-exit cases. Users may still lose events during abrupt termination before JavaScript can persist or flush them.

## Expected Backend Capability

Backend should define a public browser delivery contract that preserves write-only project auth without requiring custom headers during browser exit delivery.

Suggested API options:

- Keep `POST /v1/events` as the canonical fetch transport with `Authorization: Bearer <project-scoped browser client key>`.
- Add an optional browser exit-delivery endpoint such as `POST /v1/browser/events/beacon` only if backend can authorize it without custom request headers.
- If using a beacon-specific endpoint, accept only a small JSON or text/plain envelope with a backend-defined browser delivery key shape, strict byte limits, project routing, and no query-string keys.
- Return or document no synchronous success guarantee for beacon delivery; SDKs should treat it as best-effort and keep explicit fetch/shutdown paths as the reliable delivery proof.

Suggested fields for a beacon-safe envelope:

- `client_key_id` or other public-safe key identifier if backend can mint one without exposing raw key values.
- `project_id` only if public-safe and already associated with the browser key.
- `sdk_name`, `sdk_version`, `runtime: "browser"`, `release`, and `environment` when supplied by the app.
- `events`: bounded, already validated SDK event payloads.
- `delivery_reason`: `pagehide`, `visibility_hidden`, or future stable lifecycle reason.

Required backend behavior:

- Reject payloads over a documented byte limit before storage side effects.
- Return or record redacted auth failures without echoing client keys, authorization values, event payloads, headers, cookies, URLs, or user data.
- Keep usage/quota ownership backend-side. HTTP `429` should remain a redacted delivery failure such as `usage_limit_exceeded` or another documented code, not an SDK-derived quota state.
- Document whether category-specific suppression exists. If it does, expose stable public event categories and retry windows; if not, SDKs should continue treating `429` as whole-batch backoff.
- Do not require account/session/provider auth values in browser SDK config.

## SDK Gap Observed

The public browser SDK now proves the safe subset:

- `createFetchTransport()` uses header-based client-key delivery and bounds `keepalive` body size before calling `fetch`.
- `createPersistentBrowserTransport()` and `installLogBrewBrowser({ persistOffline })` persist failed fetch batch bodies in app-provided/Web Storage without storing the browser key, headers, cookies, query strings, hash fragments, or raw request payloads.
- `installLogBrewBrowser()` flushes queued in-memory events for `pagehide`, hidden visibility, and browser `online` recovery.
- Persisted batches are bounded by count/bytes, exact-batch deduplicated, replayed on install/online, cleared after success, and skip same-session persisted copies while the in-memory queue still owns those events.
- `onFlush` and `onCaptureError` receive `details.reason` so apps can distinguish `capture`, `online`, `pagehide`, and `visibility_hidden`.
- HTTP `429` surfaces as `SdkError` code `rate_limited` with optional `retryAfterMs`, preserves queued events, and avoids immediate retry.
- The installed browser smokes prove auth failure, retry, shutdown, high-volume logging, pagehide flush, online recovery, persisted-batch replay, queue retention, and no client-key/query/hash/email leakage through packed packages.

Competitor source pattern:

- Sentry JavaScript `getsentry/sentry-javascript@c5e245f869eca352e5d11833dd9b3264da448ac9` uses bounded browser fetch keepalive, a promise buffer, dropped-event accounting, and category-aware rate-limit state.
- Datadog Browser SDK `DataDog/browser-sdk@e387e045a32d41105ff49454aecc74edc7fd7d38` uses browser batching, retry state, bandwidth accounting, and `sendBeacon` on exit with fetch fallback.
- PostHog JS `PostHog/posthog-js@5486ab34301d64ed6da0dcbc775fbd3f0a854a3e` has configurable request transports, retry callbacks, fetch keepalive thresholds, and a `sendBeacon` path for unload.

LogBrew should not copy those heavier mechanisms blindly because today's SDK auth uses headers, public browser storage can hold sensitive telemetry, and backend owns usage/quota/category semantics.

## Verification Needed

- Backend tests for any browser beacon/exit endpoint covering accepted delivery, invalid key, wrong-project key, oversized payload, malformed payload, usage limit, and no key or payload echo in errors.
- SDK fake-intake smoke for any final beacon contract proving success, auth failure, validation failure, retry/failure behavior, flush/shutdown fallback, and unload/online behavior from installed browser packages.
- Browser temporary-app proof for pagehide/visibility/online cases with query/hash-free route metadata and no payload/header/cookie capture.
- Confidentiality scans on public docs and examples so no account/session auth values or non-public backend details are used as browser ingest config.
- Product/API proof that usage and category-suppression state, if exposed, comes from backend responses or product APIs rather than SDK-local counters.
