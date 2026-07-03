# JavaScript High-Load Transport and Queue Proof - 2026-06-23

## Scope

Improve LogBrew's real-user confidence for heavy JavaScript/Node logging bursts without adding hidden background workers, broad buffering policy, or private backend assumptions. This cycle adds a public installed-artifact verifier, not a new runtime transport contract.

## Competitor Source Read

- Sentry JavaScript `getsentry/sentry-javascript@edd901169db9e65e239858d874730a4323cafaa2`
  - `packages/core/src/transports/base.ts`
  - `packages/core/src/utils/promisebuffer.ts`
  - Pattern: transport work is bounded by a promise buffer (`DEFAULT_TRANSPORT_BUFFER_SIZE = 64`), buffer-full records `queue_overflow`, flush drains in-flight promises, and rate limits are enforced before send.
- Datadog Browser SDK `DataDog/browser-sdk@2536d1d26f5ac98560ac097f8e45d8a1400f1b53`
  - `packages/browser-core/src/transport/batch.ts`
  - `packages/browser-core/src/transport/flushController.ts`
  - Pattern: batches flush on byte, message, duration, and page-exit signals; individual messages have a 256 KiB cap; non-worker batch size is 50 messages.
- PostHog JS `PostHog/posthog-js@4d59d0e10f92ad3444e14dc171997c21aba57929`
  - `packages/browser/src/request-queue.ts`
  - Pattern: request queue batches by URL/batch key, timer, and unload behavior, with explicit enable/pause state.

## LogBrew Decision

LogBrew already keeps a bounded in-memory client queue and explicit app-owned flush/shutdown behavior. The missing market-proof was installed-artifact evidence under a realistic burst. The new `scripts/real_user_js_high_load_smoke.sh` installs packed `@logbrew/sdk` and `@logbrew/node` into a temporary app, queues 1,500 log events, proves the 1,000-event queue bound and 500 advisory `queue_overflow` drops, sends the retained batch through a local `127.0.0.1` fake intake with a 503-to-202 retry, verifies the flushed payload count and trace/release/environment metadata, proves drop callbacks cannot interrupt app logging, and checks shutdown blocks later writes.

## Tradeoffs

LogBrew intentionally does not copy Sentry's in-flight promise-buffer transport abstraction, Datadog's autonomous browser batch controller, or PostHog's timed request queue. Those are useful for broad automatic collection, but LogBrew keeps the public SDK simpler: explicit in-memory queue, explicit local fake-intake proof, app-owned flush timing, no background persistence, no hidden unload transport in Node, no application payload capture, no local usage/quota derivation, and no support ticket creation.

## Evidence

- TDD red: `python3 -m unittest tests/test_js_high_load_smoke.py` failed because `scripts/real_user_js_high_load_smoke.sh` was missing.
- Green local smoke: `bash scripts/real_user_js_high_load_smoke.sh` passed after sandbox escalation for loopback binding, reporting `1500 logs, 1000 flushed, 500 dropped, retryAttempts=2`.
- Public verifier wiring: `scripts/check_public_sdks.sh` now runs `JavaScript high-load installed-artifact smoke` immediately after `JavaScript real-user smoke`, and `tests/test_check_public_sdks.py` checks the label/order.

## Remaining Gaps

LogBrew still lacks configurable byte-based batch splitting, timeout-based autonomous flush, and a browser-safe backend unload/beacon contract. Browser fetch-batch persistence is now explicit SDK-owned recovery, but beacon-style exit delivery remains future work because it affects billing, privacy, retry semantics, and backend ingestion guarantees.
