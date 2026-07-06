# Go Outbound HTTP Tracing Research - 2026-06-19

## Scope

Reduce the Go server-side outbound HTTP tracing gap. LogBrew already had inbound `net/http` request spans, `slog` correlation, W3C trace helpers, and first-useful telemetry examples; it did not have an idiomatic app-owned `http.Client` / `RoundTripper` helper comparable to mature observability SDKs.

## Competitor Source Read

- Sentry Go SDK, [`getsentry/sentry-go`](https://github.com/getsentry/sentry-go/tree/c299195fc44e4c637d24a6ba1f2b38e0ccedb816) at commit `c299195fc44e4c637d24a6ba1f2b38e0ccedb816`.
  - `httpclient/sentryhttpclient.go`: `NewSentryRoundTripper`, `SentryRoundTripper.RoundTrip`, `WithTracePropagationTargets`.
  - `httpclient/sentryhttpclient_test.go`: outbound span expectations, response status mapping, trace propagation target filtering, cloned request behavior.
- OpenTelemetry Go contrib, [`open-telemetry/opentelemetry-go-contrib`](https://github.com/open-telemetry/opentelemetry-go-contrib/tree/844e2a9ea49b8cadf3fc5346a615bbab31af3ecb) at commit `844e2a9ea49b8cadf3fc5346a615bbab31af3ecb`.
  - `instrumentation/net/http/otelhttp/transport.go`: `NewTransport`, `Transport.RoundTrip`, request clone before propagation injection, response/error span handling, response-body wrapper completion.
  - `instrumentation/net/http/otelhttp/transport_test.go`: transport formatter, request immutability, status/error behavior, parent-context propagation.
- Datadog `dd-trace-go`, [`DataDog/dd-trace-go`](https://github.com/DataDog/dd-trace-go/tree/63960b5bd115da8c484a938a1814c7e3cf963e00) at commit `63960b5bd115da8c484a938a1814c7e3cf963e00`.
  - `contrib/net/http/roundtripper.go`: `WrapRoundTripper`, `WrapClient`, `roundTripper.RoundTrip`.
  - `contrib/net/http/internal/wrap/roundtrip.go`: `ObserveRoundTrip`, request clone, propagation injection, status/error tags, optional client timings.
  - `contrib/net/http/roundtripper_test.go`: request copy regression, status check, propagation controls, baggage behavior.

## Observed Pattern

- Mature Go SDKs expose a `RoundTripper` wrapper so developers can adopt outbound tracing with normal `http.Client` configuration.
- The wrapper creates a client span, clones the request before injecting propagation headers, executes the base transport, then finalizes status/error metadata without replacing the application response or error.
- The tradeoff is broader capture surface: Sentry records query/fragment fields and Sentry-specific trace/baggage headers; OpenTelemetry and Datadog can add metrics, baggage, timing subspans, global propagation styles, and richer semantic attributes.

## LogBrew Adaptation

- Added dependency-free `NewHTTPClientTransport(...)` to `github.com/LogBrewCo/sdk/go/logbrew`.
- The transport starts from the active LogBrew `TraceContext` when present, otherwise creates a local W3C-shaped trace, clones the request, overwrites exactly one W3C `traceparent`, scopes the downstream call under the child context, and queues one span with method, query-free route, status code, duration, sampled flag, and primitive metadata. Invalid active trace state reports through `OnError` and falls back to a local trace. HTTP 4xx/5xx responses and transport errors are failed dependency spans.
- HTTP responses and transport errors are returned unchanged. Telemetry capture errors are reported through optional `OnError` and do not break app-owned HTTP calls.
- It avoids global client patching, request/response payload capture, header/cookie/full-URL/query/fragment capture, raw propagation metadata, baggage, tracestate, support tickets, and backend-owned behavior.

## Verification

- TDD red: `cd go/logbrew && go test ./... -run 'TestHTTPClientTransport'` failed with undefined `NewHTTPClientTransport` / `HTTPClientTransportConfig`.
- Unit proof covers request immutability, downstream `traceparent` injection, active child context, malformed active-trace fallback, span correlation, status/duration metadata, 4xx dependency failure status, query/header/propagation redaction, original transport error preservation, and non-fatal capture failure reporting.
- Installed-artifact proof is wired into `scripts/real_user_go_smoke.sh`: the proxy module zip includes `examples/http_client_trace`, the Makefile exposes `run-http-client-trace`, and the packaged example proves local downstream propagation and span capture.

## Phase Timing Follow-Up - 2026-07-06

### Additional Source Read

- Sentry Go SDK, [`getsentry/sentry-go`](https://github.com/getsentry/sentry-go/tree/8fbb80b557494db92d09b396bc2d79ecb24c64db) at commit `8fbb80b557494db92d09b396bc2d79ecb24c64db`.
  - `httpclient/sentryhttpclient.go`: `NewSentryRoundTripper`, `SentryRoundTripper.RoundTrip`, and `WithTracePropagationTargets`.
- OpenTelemetry Go contrib, [`open-telemetry/opentelemetry-go-contrib`](https://github.com/open-telemetry/opentelemetry-go-contrib/tree/7155189f62b7a9d27c319603fbd94fb0a97c274b) at commit `7155189f62b7a9d27c319603fbd94fb0a97c274b`.
  - `instrumentation/net/http/otelhttp/transport.go`: `NewTransport` and `Transport.RoundTrip`.
  - `instrumentation/net/http/httptrace/otelhttptrace/clienttrace.go`: `NewClientTrace`, `WithoutSubSpans`, `clientTracer.dnsStart`, `clientTracer.dnsDone`, `clientTracer.connectStart`, `clientTracer.connectDone`, `clientTracer.tlsHandshakeStart`, `clientTracer.tlsHandshakeDone`, `clientTracer.wroteRequest`, and `clientTracer.gotFirstResponseByte`.
- Datadog `dd-trace-go`, [`DataDog/dd-trace-go`](https://github.com/DataDog/dd-trace-go/tree/cc84f993c7eba2b7a90bdde215aa2c545708266e) at commit `cc84f993c7eba2b7a90bdde215aa2c545708266e`.
  - `contrib/net/http/internal/wrap/roundtrip.go`: `httpTraceTimings`, `newClientTrace`, and `ObserveRoundTrip`.
  - `contrib/net/http/option.go`: `WithClientTimings`.
  - `contrib/net/http/roundtripper_test.go`: `TestClientTimings` and `TestClientTimingsRace`.
- PostHog Go, [`PostHog/posthog-go`](https://github.com/PostHog/posthog-go/tree/67f00c8548126e190723e3755479bb71900fd95c) at commit `67f00c8548126e190723e3755479bb71900fd95c`.
  - Searched `RoundTripper`, `httptrace`, `ClientTrace`, `DNSStart`, `GotConn`, `ConnectStart`, `GotFirstResponseByte`, `TLSHandshake`, and `net/http`; found delivery/test transports and request-context helpers, but no comparable outbound trace phase instrumentation.

### Competitor Pattern

- Sentry's Go outbound wrapper stays simple and app-owned, but records broader URL/server/query metadata than LogBrew should copy by default.
- OpenTelemetry separates the main `otelhttp.Transport` from optional `httptrace` phase instrumentation. Its `httptrace` package can emit per-phase subspans or lower-overhead events, and it has explicit header redaction controls.
- Datadog keeps request-phase timings opt-in through `WithClientTimings(true)` and records DNS, connect, TLS, connection acquisition, and first-byte duration tags.
- The practical pattern is opt-in `httptrace.ClientTrace` enrichment on an app-owned transport, with care for callback overhead and existing application hooks.

### LogBrew Adaptation

- Added `CapturePhaseTimings` to `HTTPClientTransportConfig`.
- When enabled, `NewHTTPClientTransport` installs `httptrace.ClientTrace` callbacks on the cloned outbound request and preserves caller-installed `httptrace` hooks through Go's `httptrace.WithClientTrace` composition.
- LogBrew records only low-cardinality `dnsMs`, `connectMs`, `tlsMs`, `wroteRequestMs`, `timeToFirstByteMs`, `connectionReused`, and `connectionWasIdle` metadata on the existing outbound span.
- The implementation intentionally does not copy hosts, IPs, full URLs, query strings, fragments, headers, cookies, payloads, baggage, tracestate, raw propagation values, peer addresses, idle time, or phase error messages.

### Updated Proof

- RED focused test: `cd go/logbrew && go test ./... -run TestHTTPClientTransportRecordsSafePhaseTimingsAndPreservesCallerTrace -count=1` failed with missing `CapturePhaseTimings`.
- GREEN focused test proves phase timing metadata, caller `httptrace` hook preservation, and no host/IP/query/header/propagation leaks.
- `examples/http_client_trace` now opts into phase timings against a local `httptest` server.
- `scripts/real_user_go_smoke.sh` now verifies the packaged module README mentions `CapturePhaseTimings` and the installed-artifact HTTP client example emits `connectMs`, `wroteRequestMs`, `timeToFirstByteMs`, and connection reuse booleans without unsafe route or propagation values.

## Remaining Gaps

- Go still lacks richer span events/exceptions, baggage/tracestate support, automatic transport patching, response-body completion timing, and first-party framework/client integrations for common HTTP/router/database/cache/queue libraries.
- Keep those out of the core helper unless a focused integration package owns the broader dependency and capture surface.
