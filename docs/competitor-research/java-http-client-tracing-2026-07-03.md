# Java HttpClient Tracing - 2026-07-03

## Goal

Close a high-value Java tracing gap from a real-user perspective: outbound
`java.net.http.HttpClient` calls should correlate with active LogBrew traces,
emit a useful client span, preserve app-owned request behavior, and avoid
capturing private values, URLs, query strings, headers, payloads, baggage, or
tracestate.

## Sources Read

- Sentry Java SDK: `getsentry/sentry-java` at
  `34c912af8ac0b9def83ad0dbfe8d1452d460c7ed`.
- Sentry files/classes read:
  `sentry-openfeign/src/main/java/io/sentry/openfeign/SentryFeignClient.java`
  (`execute` request wrapper and span lifecycle) and
  `sentry-okhttp/src/main/java/io/sentry/okhttp/SentryOkHttpInterceptor.kt`
  (`intercept`, request span creation, trace header propagation).
- OpenTelemetry Java Instrumentation:
  `open-telemetry/opentelemetry-java-instrumentation` at
  `43737cfdd5902e3d19c722f5f846bae085513ab4`.
- OpenTelemetry files/classes read:
  `instrumentation/java-http-client/library/src/main/java/io/opentelemetry/instrumentation/javahttpclient/JavaHttpClientTelemetry.java`
  (`newHttpClient`, builder seam) and
  `.../internal/OpenTelemetryHttpClient.java` (`send`, `sendAsync`, request
  copy, header injection, span completion).
- Datadog Java tracer: `DataDog/dd-trace-java` at
  `0eeac731fafa60d5e10c302cf7bf3560380e4127`.
- Datadog files/classes read:
  `dd-java-agent/instrumentation/java/java-net/java-net-11.0/src/main/java11/datadog/trace/instrumentation/httpclient/SendAdvice.java`,
  `SendAsyncAdvice.java`, and `JavaNetClientDecorator.java` for agent-owned
  sync/async span creation, continuation, and header injection.
- PostHog Java SDK: `PostHog/posthog-java` at
  `dcf8fd85d0f1a405ae3aca02d00e24a1daa4f17e`; no general outbound HTTP
  tracing instrumentation path was found in the source reviewed.

## Competitor Pattern

- Sentry wraps concrete framework/client APIs and injects trace headers while
  recording spans around the app-owned request call.
- OpenTelemetry Java Instrumentation exposes a wrapper seam around
  `HttpClient` plus sync/async completion handling, request copying, header
  injection, and status/error mapping.
- Datadog is broader but heavier: Java agent advice intercepts
  `HttpClient.send` and `sendAsync` globally, then injects headers and records
  spans through tracer internals.
- PostHog remains product/event oriented and did not provide a comparable Java
  HTTP client tracing pattern in the source reviewed.

## LogBrew Implementation

- Added `LogBrewHttpClientTracing.send(...)` and `sendAsync(...)` for Java 11
  `HttpClient`.
- The helper copies the request, removes any existing `traceparent`, writes one
  normalized W3C `traceparent`, sends through the app-owned `HttpClient`, and
  queues one `http.client` span.
- It creates a child context under active `LogBrewTrace` when present, or a
  local root trace when there is no active trace.
- Span metadata includes method, sanitized route template, status code,
  duration, sampled flag, and trace/span correlation. Failures add a type-only
  exception event.
- It avoids Java agents, global patching, OTel provider/exporter ownership,
  baggage, tracestate, full URLs, query strings, arbitrary headers, request or
  response payloads, exception messages, and stack traces.

## Tradeoffs

- Better for LogBrew's current product boundary: explicit helper, no hidden
  instrumentation, no global client patching, no new dependency, and strong
  installed-artifact privacy proof.
- Better than broad auto-instrumentation for teams that need predictable
  behavior and reviewable snippets.
- Worse than Sentry, Datadog, and OpenTelemetry for zero-code automatic
  outbound HTTP coverage, route inference breadth, semantic-convention depth,
  baggage/tracestate, request phase timings, and automatic framework
  integrations.

## Verification

- Red test first: `bash scripts/check_java_package.sh` failed before
  `LogBrewHttpClientTracing` existed.
- Green package gate: `bash scripts/check_java_package.sh` passed including
  the new Java `HttpClient` tracing tests, javadocs, binary/source jar
  assertions, README checks, and packaged examples.
- Installed-artifact smoke: `bash scripts/real_user_java_smoke.sh` passed with
  a packed LogBrew jar and a temporary app that exercised sync 202, async 503,
  existing-traceparent replacement, app-owned header preservation on the actual
  request, sanitized route templates, duration/status mapping, and payload
  omission.

## Remaining Gaps

- Java still trails Sentry, Datadog, and OpenTelemetry for automatic
  framework/client instrumentation breadth, baggage/tracestate, HTTP phase
  timings, rich semantic conventions, profiling, and backend trace-query
  maturity.
- Next Java focus should be source-backed framework integrations or richer
  request timing only when the installed-artifact privacy/failure proof remains
  strong enough to justify the extra coupling.
