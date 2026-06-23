# Browser Installed-Artifact Fake Intake - Competitor Research - 2026-06-22

## Goal

Prove the browser SDK behaves like a real installed package without turning the public SDK repo or downstream packages into default network telemetry producers. The proof uses installed packages, a temporary app, and a local fake intake for auth, retry, flush, shutdown, and high-volume logging behavior.

## Sources Read

- Sentry JavaScript: `getsentry/sentry-javascript@c5e245f869eca352e5d11833dd9b3264da448ac9`.
- Sentry files/functions: `packages/core/src/transports/base.ts` (`createTransport`, `send`, `recordEnvelopeLoss`, rate-limit filtering, promise-buffer queue) and `packages/browser/src/transports/fetch.ts` (`makeFetchTransport`, fetch `keepalive`, pending body/count limits).
- Datadog Browser SDK: `DataDog/browser-sdk@e387e045a32d41105ff49454aecc74edc7fd7d38`.
- Datadog files/functions: `packages/browser-core/src/transport/batch.ts` (`startBatch`, `flush`), `httpRequest.ts` (`createHttpRequest`, `sendOnExit`, sendBeacon exit path), and the retry helper for queueing, retry scheduling, and bandwidth accounting.
- PostHog JS: `PostHog/posthog-js@5486ab34301d64ed6da0dcbc775fbd3f0a854a3e`.
- PostHog files/functions: `packages/browser/src/posthog-core.ts` (`_send_request`, `_send_retriable_request`) and `packages/browser/src/request.ts` (`request`, `fetch`, `XMLHttpRequest` transport selection).

## Competitor Pattern

- Sentry wraps fetch transport in a bounded promise buffer, records dropped events, honors rate limits, and uses keepalive only under browser-safe pending byte/count limits.
- Datadog uses browser batching plus explicit retry queue state, bandwidth accounting, sendBeacon-on-exit fallback, and queue-full notifications.
- PostHog routes browser requests through a configurable request layer with queueing, rate-limit checks, callbacks, and retry queue delegation.

## LogBrew Implementation

- Added `scripts/real_user_browser_fake_intake_smoke.sh`.
- The smoke packs `@logbrew/sdk` and `@logbrew/browser`, installs them into a temporary npm app, and sends browser SDK telemetry to a local loopback fake intake through the real `createFetchTransport` path.
- It proves a generic account-recovery browser workflow with release, environment, log, issue, W3C-linked span, action, metric, and 250 additional log events.
- It verifies HTTP 503-to-202 retry, bearer auth header use without payload echo, invalid-key handling as redacted `unauthenticated`, queue retention after auth failure, explicit shutdown flush, post-shutdown failure, primitive service/release/environment/route/trace correlation, and no query/hash/email leakage.
- 2026-06-23 update: `createFetchTransport()` now defaults to a 64 KiB `maxKeepaliveBodyBytes` guard. Oversized keepalive payloads fail before `fetch` with non-retryable `keepalive_body_too_large`, preserving queued events for a later explicit `keepalive: false` large-batch flush. The byte check remains UTF-8 accurate even when `TextEncoder` is unavailable.
- Wired the smoke into the local `scripts/check_public_sdks.sh` gate as `Browser installed-artifact fake-intake smoke` without adding another GitHub Actions or Blacksmith duplicate lint/static check.

## Tradeoffs

- Better for LogBrew's current public SDK boundary: the proof is realistic, local, installed-artifact based, and inert by default. It does not silently add network telemetry to public repos/packages.
- Lighter than Sentry/Datadog/PostHog: no hidden global browser batching layer, no background queue worker, no sendBeacon fallback, no rate-limit store, and no persisted offline queue. Keepalive delivery is explicit and bounded instead of best-effort browser-dependent.
- Still worse than Sentry/Datadog/PostHog for production browser delivery under unload/offline/rate-limit/drop-reporting pressure. Future work should add bounded queue/drop reporting and lifecycle delivery behavior only when the SDK owns a framework/browser integration layer explicitly.

## Verification

- Red: `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest tests.test_check_public_sdks.CheckPublicSdksJsonContractTests.test_public_verifier_runs_browser_fake_intake_smoke` failed because `check_public_sdks.sh` did not include the new smoke.
- Red: `bash scripts/real_user_browser_fake_intake_smoke.sh` failed on the new oversized keepalive assertion because the packaged transport called `fetch` instead of failing before delivery.
- Green: `bash scripts/real_user_browser_fake_intake_smoke.sh` passed with a local fake intake after unsandboxed execution allowed loopback binding.
- Green: focused public-check tests passed for the new smoke wiring and step-label ordering.
