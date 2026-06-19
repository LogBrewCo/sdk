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

## Remaining Gaps

- Go still lacks DB/cache/queue spans, richer span events/exceptions, baggage/tracestate support, automatic transport patching, response-body completion timing, and opt-in detailed request-phase timing.
- Keep those out of the core helper unless a focused integration package owns the broader dependency and capture surface.
