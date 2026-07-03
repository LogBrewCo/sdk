# Java OpenTelemetry Context Copy - 2026-06-29

## Goal

Improve Java trace correlation where LogBrew was weaker than Sentry, Datadog, and OpenTelemetry: apps that already run OpenTelemetry should be able to attach LogBrew logs, issues, spans, metrics, downstream `traceparent` headers, and ended OpenTelemetry spans to the active OTel trace without installing a Java agent or letting LogBrew own global OTel setup.

## Sources Read

- Sentry Java SDK: `https://github.com/getsentry/sentry-java.git` at `d8b6ce11cabd05be9a3f03a1d20fe247956d091d`.
- Sentry files/functions: `sentry-opentelemetry/sentry-opentelemetry-core/src/main/java/io/sentry/opentelemetry/OtelSpanContext.java`, `OtelSentrySpanProcessor.java` (`onStart`, `onEnd`, invalid-span guard), `OtelSentryPropagator.java` (`inject`, `extract`), `SentryPropagator.java` (`inject`, `extract`), `sentry-spring-boot/src/main/java/io/sentry/spring/boot/SentryAutoConfiguration.java` OpenTelemetry configuration imports, and sample controllers under `sentry-samples/.../PersonController.java` that create OTel spans and make them current.
- OpenTelemetry Java: `https://github.com/open-telemetry/opentelemetry-java.git` at `9b57914fc5fdfc5213cc2b4c980112cc987d3276`.
- OpenTelemetry files/functions: `api/all/src/main/java/io/opentelemetry/api/trace/Span.java` (`current`, `fromContext`, `wrap`, `getSpanContext`), `SpanContext.java` (`create`, `createFromRemoteParent`, `isValid`, `getTraceId`, `getSpanId`, `getTraceFlags`), `TraceFlags.java` (`getSampled`, `getDefault`, `asHex`), `api/all/src/main/java/io/opentelemetry/api/trace/propagation/W3CTraceContextPropagator.java` (`inject`, `extract`), and `context/src/main/java/io/opentelemetry/context/Context.java` (`current`, `root`, `with`, `makeCurrent`).
- Datadog Java tracer: `https://github.com/DataDog/dd-trace-java.git` at `ffb48aeb95a05df3d20c27afe3a7b1c5d0ba59c4`.
- Datadog files/functions: `dd-java-agent/agent-otel/otel-shim/src/main/java/datadog/opentelemetry/shim/trace/OtelSpanContext.java`, `trace/OtelSpan.java`, and `context/OtelContext.java`.
- Maven Central metadata checked on 2026-06-29: `io.opentelemetry:opentelemetry-api`, `opentelemetry-context`, and `opentelemetry-common` current release `1.63.0`.

## 2026-07-03 Exporter Follow-Up Sources

- Sentry Java SDK: `https://github.com/getsentry/sentry-java.git` at `34c912af8ac0b9def83ad0dbfe8d1452d460c7ed`.
- Sentry files/functions: `sentry-opentelemetry/sentry-opentelemetry-core/src/main/java/io/sentry/opentelemetry/OtelSentrySpanProcessor.java` (`onStart`, `onEnd`, parent/root handling), `sentry-opentelemetry/sentry-opentelemetry-bootstrap/src/main/java/io/sentry/opentelemetry/OtelSpanFactory.java` (OTel span creation/wrapping), `SentryWeakSpanStorage.java` (OTel-to-Sentry span lookup), and Spring 7 OpenTelemetry configuration files `SentryOpenTelemetryNoAgentConfiguration.java` and `SentryOpenTelemetryAgentWithoutAutoInitConfiguration.java`.
- OpenTelemetry Java: `https://github.com/open-telemetry/opentelemetry-java.git` at `4d974ba1bb300157d3cb296cd466f8d1d96b9333`.
- OpenTelemetry files/functions: `sdk/trace/src/main/java/io/opentelemetry/sdk/trace/export/SpanExporter.java` (`export`, `flush`, `shutdown`), `SimpleSpanProcessor.java` (`create`, ended-span export), `SpanProcessor.java` (`onEnd`, lifecycle), `ReadableSpan.java`, `data/SpanData.java` (`getName`, `getKind`, contexts, status, start/end nanos, attributes, events, links, instrumentation scope), `EventData.java`, `LinkData.java`, and `StatusData.java`.
- Datadog Java tracer: `https://github.com/DataDog/dd-trace-java.git` at `0eeac731fafa60d5e10c302cf7bf3560380e4127`.
- Datadog files/functions: `dd-java-agent/agent-otel/otel-shim/src/main/java/datadog/opentelemetry/shim/trace/OtelTracerProvider.java`, `OtelTracer.java`, `OtelSpan.java`, `OtelSpanBuilder.java`, `OtelSpanEvent.java`, `OtelSpanLink.java`, and `OtelConventions.java`.
- PostHog Java SDK: `https://github.com/PostHog/posthog-java.git` at `dcf8fd85d0f1a405ae3aca02d00e24a1daa4f17e`.
- PostHog files/functions: `posthog/src/main/java/com/posthog/java/PostHog.java` and `QueueManager.java`; no general OTel span exporter/processor path was found.

## Competitor Pattern

- OpenTelemetry Java gives a stable narrow API seam: `Span.current()`/`Span.fromContext(...)` yields a span, `SpanContext.isValid()` gates usable context, and `TraceFlags.asHex()` exposes the W3C flags needed for a `traceparent`.
- OpenTelemetry SDK exposes a clean app-owned seam for ended spans: apps add a `SimpleSpanProcessor` with a `SpanExporter`, and the exporter receives immutable `SpanData` containing contexts, status, duration, attributes, events, links, resource, and instrumentation scope.
- Sentry supports a much deeper bridge: span processors, wrapper storage, Sentry propagation headers, baggage handling, Spring conditional configuration, profiling/error hooks, and sample apps where OTel spans and Sentry spans coexist.
- Datadog goes heavier still with an agent shim that maps Datadog spans into OTel `Span`, `SpanContext`, context, baggage, logs, metrics, events, links, and conventions.
- PostHog Java remains event/product-analytics oriented and did not provide a comparable general OTel tracing bridge in the source reviewed.

## LogBrew Implementation

- Added optional Java `LogBrewOpenTelemetry` helpers:
  - `traceContextFromCurrentSpan(...)`
  - `traceContextFromContext(...)`
  - `traceContextFromSpan(...)`
  - `traceContextFromSpanContext(...)`
- Helpers return `Optional.empty()` when OTel has no valid active span, and otherwise create a LogBrew child `LogBrewTraceContext` using only OTel trace ID, OTel span ID as parent span ID, and OTel trace flags.
- Added optional Java `LogBrewOpenTelemetrySdk` helpers:
  - `spanExporter(LogBrewClient)`
  - `spanProcessor(LogBrewClient)`
- Added `LogBrewOpenTelemetrySpanExporter`, a small app-owned OTel SDK exporter that converts ended `SpanData` into existing `LogBrewClient.span(...)` queue events.
- The exporter preserves trace/span/parent IDs, status, duration, span kind, instrumentation scope, up to eight event summaries, up to eight span links, and allowlisted primitive metadata: HTTP method/route/status, database system/operation, messaging system/operation, RPC system/service/method, service name/version/environment, and exception type.
- The exporter drops baggage, tracestate, arbitrary resource attributes, full URLs, SQL statements, headers, payloads, exception messages, exception stack traces, and status descriptions.
- Added optional Maven dependency metadata for `opentelemetry-sdk-trace` at `1.63.0` in addition to `opentelemetry-api`, `opentelemetry-context`, and `opentelemetry-common`. They are optional so default LogBrew consumers do not get OTel pulled transitively.
- README now shows the app-owned OTel context-copy and span-exporter install paths and states the boundary clearly.

## Tradeoffs

- Better for LogBrew's current product boundary: typed OTel bridge, no Java agent, no Spring auto-configuration, no global provider ownership, no hidden HTTP/logging/client patching, and no arbitrary OTel attribute/resource copying.
- Better for privacy by default: context helpers only copy validated IDs and flags; the exporter uses an allowlist and type-only exception summaries instead of raw URLs, SQL, payloads, headers, exception messages, stack traces, baggage, or tracestate.
- Worse than Sentry and Datadog for automatic Spring/Servlet/JDBC/cache/messaging instrumentation, agent-managed context propagation, baggage/tracestate support, broad semantic-convention coverage, profiling, and automatic exception capture.

## Verification

- Red test first: `bash scripts/check_java_package.sh` failed on missing `LogBrewOpenTelemetry`.
- Green package gate: `bash scripts/check_java_package.sh` passed Java source tests, OTel context tests, Maven metadata checks, javadocs, source jar checks, binary jar checks, README assertions, and packaged examples.
- Installed-artifact smoke: `bash scripts/real_user_java_smoke.sh` passed using a packed LogBrew jar plus real `opentelemetry-api`, `opentelemetry-context`, and `opentelemetry-common` jars. The temporary app created an OTel span context, made it current, copied it into a LogBrew child span, asserted the downstream `traceparent`, rejected invalid OTel context, and proved tracestate values were not copied into telemetry.
- 2026-07-03 red test: `bash scripts/check_java_package.sh` failed on missing OTel exporter API, then the API-only installed smoke exposed that placing SDK-returning methods on `LogBrewOpenTelemetry` broke API-only context-copy apps.
- 2026-07-03 green package gate: `bash scripts/check_java_package.sh` passed 32 Java package tests plus trace, servlet, span event, OTel context/exporter, dependency tracing, Spring, Maven metadata, javadocs, source jar, binary jar, README, and packaged example checks.
- 2026-07-03 installed-artifact proof: `bash scripts/real_user_java_opentelemetry_smoke.sh` built a LogBrew jar, compiled one temporary API-only app with no `opentelemetry-sdk-trace` jar to prove `LogBrewOpenTelemetry` context copying still works, then compiled a second app against real OTel SDK jars, registered `LogBrewOpenTelemetrySdk.spanProcessor(client)` with `SdkTracerProvider`, exported an ended server span with event and link summaries, verified trace/span/parent IDs and allowlisted metadata, and proved raw URL/debug query, SQL statement, messaging ID, exception message, stacktrace, status description, and raw `traceparent` were absent.

## Remaining Gaps

- Java still lacks Sentry/Datadog-level automatic Spring/Servlet/JDBC/cache/messaging instrumentation, outbound HTTP client spans, baggage/tracestate, broad semantic-convention coverage, profiling, and automatic exception capture.
- Next high-impact Java work should move toward source-backed framework integration where user value clearly beats the added runtime coupling, with installed-artifact failure/retry/flush proof and explicit privacy tests.
