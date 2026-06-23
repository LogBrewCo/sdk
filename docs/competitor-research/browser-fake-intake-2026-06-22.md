# Browser Installed-Artifact Fake Intake - Competitor Research - 2026-06-22

## Goal

Prove the browser SDK behaves like a real installed package without turning the public SDK repo or downstream packages into default network telemetry producers. The proof uses installed packages, a temporary app, and a local fake intake for auth, retry, flush, shutdown, and high-volume logging behavior.

## Sources Read

- Sentry JavaScript: `getsentry/sentry-javascript@c5e245f869eca352e5d11833dd9b3264da448ac9`.
- Sentry files/functions: `packages/core/src/transports/base.ts` (`createTransport`, `send`, `recordEnvelopeLoss`, rate-limit filtering, promise-buffer queue), `packages/core/src/utils/ratelimit.ts` (`parseRetryAfterHeader`, `updateRateLimits`, `isRateLimited`), and `packages/browser/src/transports/fetch.ts` (`makeFetchTransport`, fetch `keepalive`, pending body/count limits).
- Datadog Browser SDK: `DataDog/browser-sdk@e387e045a32d41105ff49454aecc74edc7fd7d38`.
- Datadog files/functions: `packages/browser-core/src/transport/batch.ts` (`startBatch`, `flush`), `httpRequest.ts` (`createHttpRequest`, `sendOnExit`, sendBeacon exit path), and the retry helper for queueing, retry scheduling, and bandwidth accounting.
- PostHog JS: `PostHog/posthog-js@5486ab34301d64ed6da0dcbc775fbd3f0a854a3e`.
- PostHog files/functions: `packages/browser/src/posthog-core.ts` (`_send_request`, `_send_retriable_request`) and `packages/browser/src/request.ts` (`request`, `fetch`, `XMLHttpRequest` transport selection).

## Competitor Pattern

- Sentry wraps fetch transport in a bounded promise buffer, records dropped events, turns rate-limit headers or bare `429` responses into disabled-until state, and uses keepalive only under browser-safe pending byte/count limits.
- Datadog uses browser batching plus explicit retry queue state, bandwidth accounting, sendBeacon-on-exit fallback, and queue-full notifications.
- PostHog routes browser requests through a configurable request layer with queueing, rate-limit checks, callbacks, and retry queue delegation.

## LogBrew Implementation

- Added `scripts/real_user_browser_fake_intake_smoke.sh`.
- The smoke packs `@logbrew/sdk` and `@logbrew/browser`, installs them into a temporary npm app, and sends browser SDK telemetry to a local loopback fake intake through the real `createFetchTransport` path.
- It proves a generic account-recovery browser workflow with release, environment, log, issue, W3C-linked span, action, metric, and 250 additional log events.
- It verifies HTTP 503-to-202 retry, bearer auth header use without payload echo, invalid-key handling as redacted `unauthenticated`, queue retention after auth failure, explicit shutdown flush, post-shutdown failure, primitive service/release/environment/route/trace correlation, and no query/hash/email leakage.
- 2026-06-23 update: `createFetchTransport()` now defaults to a 64 KiB `maxKeepaliveBodyBytes` guard. Oversized keepalive payloads fail before `fetch` with non-retryable `keepalive_body_too_large`, preserving queued events for a later explicit `keepalive: false` large-batch flush. The byte check remains UTF-8 accurate even when `TextEncoder` is unavailable.
- 2026-06-23 update: `LogBrewClient` now has a default 1000-event in-memory queue bound, `maxQueueSize`, `droppedEvents()`, and `onEventDropped`. Overflow drops the incoming event, preserves already queued context, and reports `queue_overflow` without throwing from the callback.
- 2026-06-23 update: core flush now treats HTTP `429` as `SdkError` code `rate_limited`, preserves queued events, and avoids immediate retry. `RecordingTransport` and browser `createFetchTransport()` can carry `retryAfterMs`; the browser transport parses the standard `Retry-After` seconds/date header from local fake-intake responses.
- Wired the smoke into the local `scripts/check_public_sdks.sh` gate as `Browser installed-artifact fake-intake smoke` without adding another GitHub Actions or Blacksmith duplicate lint/static check.

## Tradeoffs

- Better for LogBrew's current public SDK boundary: the proof is realistic, local, installed-artifact based, and inert by default. It does not silently add network telemetry to public repos/packages.
- Lighter than Sentry/Datadog/PostHog: no hidden global browser batching layer, no background queue worker, no sendBeacon fallback, no persisted offline queue, and no local usage/quota derivation. Keepalive delivery, queue pressure, and rate-limit recovery signals are explicit and bounded instead of best-effort browser-dependent.
- Still worse than Sentry/Datadog/PostHog for production browser delivery under unload/offline pressure and for category-aware rate-limit stores. Future work should add lifecycle delivery and optional source-backed rate-limit suppression only when the SDK owns a framework/browser integration layer explicitly.

## Verification

- Red: `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest tests.test_check_public_sdks.CheckPublicSdksJsonContractTests.test_public_verifier_runs_browser_fake_intake_smoke` failed because `check_public_sdks.sh` did not include the new smoke.
- Red: `bash scripts/real_user_browser_fake_intake_smoke.sh` failed on the new oversized keepalive assertion because the packaged transport called `fetch` instead of failing before delivery.
- Red: `node --test js/logbrew-js/test/sdk.test.js --test-name-pattern 'bounded queue|invalid queue bound'` failed because the core client had an unbounded event array and accepted `maxQueueSize: 0`.
- Red: `bash scripts/real_user_browser_fake_intake_smoke.sh` failed because `createLogBrewBrowserClient()` did not forward `maxQueueSize`.
- Red: `node --test js/logbrew-js/test/sdk.test.js --test-name-pattern 'rate-limited response surfaces retry-after without retrying'` failed because `429` still raised generic `transport_error`.
- Red: `bash scripts/real_user_browser_fake_intake_smoke.sh` failed because the installed browser package surfaced the local fake-intake `429` as generic `transport_error` instead of `rate_limited`.
- Green: `bash scripts/real_user_browser_fake_intake_smoke.sh` passed with a local fake intake after unsandboxed execution allowed loopback binding.
- Green: focused JS rate-limit test passed, and the installed browser fake-intake smoke passed with `Retry-After: 2` parsed as `retryAfterMs: 2000`, one request, retained queue, and no immediate retry.
- Green: focused public-check tests passed for the new smoke wiring and step-label ordering.
