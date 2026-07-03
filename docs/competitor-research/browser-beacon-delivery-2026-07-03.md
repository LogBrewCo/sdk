# Browser Beacon Delivery Competitor Review - 2026-07-03

## Sources Checked

- Sentry JavaScript public repo `getsentry/sentry-javascript@68fe9e8fbcf70f1a92468410a1686787d4f724a6`
- Sentry paths read: `packages/browser/src/transports/fetch.ts`, `packages/browser/test/transports/fetch.test.ts`, `packages/browser/src/client.ts`
- Datadog browser SDK public repo `DataDog/browser-sdk@d2c7e303e4533f40e93d447042a67571f7ba97ff`
- Datadog paths read: `packages/browser-core/src/transport/httpRequest.ts`, `packages/browser-core/src/transport/httpRequest.spec.ts`
- PostHog JS public repo `PostHog/posthog-js@e480a3e23ecff45d2f9cf50332f6f59c54a7c736`
- PostHog paths read: `packages/browser/src/request.ts`, `packages/browser/src/posthog-logs.ts`
- OpenTelemetry JS public repo `open-telemetry/opentelemetry-js@d9c170c94884e345dff6d67322794e85e6e07f18`
- OpenTelemetry paths read: `packages/opentelemetry-exporter-zipkin/src/platform/browser/util.ts`, `experimental/packages/otlp-exporter-base/src/transport/fetch-transport.ts`

## Competitor Pattern

Sentry uses browser fetch transport with `keepalive` and caps it by pending body bytes and pending request count so navigation-time sends avoid browser keepalive failures. Datadog exposes a separate `sendOnExit` path: use `navigator.sendBeacon` for small payloads, then fall back to fetch when beacon is unavailable, refused, thrown, or too large. PostHog keeps explicit fetch/XHR/beacon transports, wraps beacon payloads in a `Blob` for JSON content type, and uses thresholding so oversized keepalive bodies do not fail. OpenTelemetry uses both approaches: Zipkin can use `sendBeacon` only when custom headers are absent, while OTLP fetch transport tracks cumulative keepalive byte/count limits.

## LogBrew Tradeoff

LogBrew should not silently switch default browser delivery to beacon because beacon cannot send the existing Authorization header. The safer SDK-native version is an explicit `createBeaconTransport()` for endpoints that accept an Authorization-headerless browser envelope. It keeps the key out of URLs and request headers, falls back to fetch when beacon cannot queue, and preserves the existing persistent-queue behavior where local storage stores only the telemetry envelope, never the client key.

## Implemented LogBrew Subset

`@logbrew/browser` now exports `createBeaconTransport({ endpoint, sendBeacon, fetchImpl, maxBeaconBodyBytes })`. It sends `{ ingest_key, envelope }` as JSON, uses a `Blob` payload when available, returns a queued best-effort response when `sendBeacon` accepts the body, falls back to fetch for refused/unavailable/oversized beacon delivery, disables fallback keepalive for oversized bodies, and preserves `Retry-After` on fallback fetch responses.

The default browser install still uses the existing fetch transport unless the app explicitly passes a beacon transport.

## Evidence

- Failing-first focused test: `node --test js/logbrew-browser/test/beacon-transport.test.mjs`
- Browser package gate: `npm test --prefix js/logbrew-browser`
- Installed tarball smoke: `bash scripts/real_user_browser_smoke.sh`
- Local fake-intake/high-volume gate: `bash scripts/real_user_browser_fake_intake_smoke.sh`

## Remaining Gaps

Sentry, Datadog, and PostHog are still stronger for fully automatic page-exit delivery integration and mature hosted intake behavior. LogBrew now has the SDK-side explicit transport and local fake-intake proof, but hosted browser beacon intake must be verified before public docs can claim default hosted support.
