# Java OpenTelemetry Context Copy - 2026-06-29

## Goal

Improve Java trace correlation where LogBrew was weaker than Sentry, Datadog, and OpenTelemetry: apps that already run OpenTelemetry should be able to attach LogBrew logs, issues, spans, metrics, and downstream `traceparent` headers to the active OTel trace without installing a Java agent or letting LogBrew own exporters/processors.

## Sources Read

- Sentry Java SDK: `https://github.com/getsentry/sentry-java.git` at `d8b6ce11cabd05be9a3f03a1d20fe247956d091d`.
- Sentry files/functions: `sentry-opentelemetry/sentry-opentelemetry-core/src/main/java/io/sentry/opentelemetry/OtelSpanContext.java`, `OtelSentrySpanProcessor.java` (`onStart`, `onEnd`, invalid-span guard), `OtelSentryPropagator.java` (`inject`, `extract`), `SentryPropagator.java` (`inject`, `extract`), `sentry-spring-boot/src/main/java/io/sentry/spring/boot/SentryAutoConfiguration.java` OpenTelemetry configuration imports, and sample controllers under `sentry-samples/.../PersonController.java` that create OTel spans and make them current.
- OpenTelemetry Java: `https://github.com/open-telemetry/opentelemetry-java.git` at `9b57914fc5fdfc5213cc2b4c980112cc987d3276`.
- OpenTelemetry files/functions: `api/all/src/main/java/io/opentelemetry/api/trace/Span.java` (`current`, `fromContext`, `wrap`, `getSpanContext`), `SpanContext.java` (`create`, `createFromRemoteParent`, `isValid`, `getTraceId`, `getSpanId`, `getTraceFlags`), `TraceFlags.java` (`getSampled`, `getDefault`, `asHex`), `api/all/src/main/java/io/opentelemetry/api/trace/propagation/W3CTraceContextPropagator.java` (`inject`, `extract`), and `context/src/main/java/io/opentelemetry/context/Context.java` (`current`, `root`, `with`, `makeCurrent`).
- Datadog Java tracer: `https://github.com/DataDog/dd-trace-java.git` at `ffb48aeb95a05df3d20c27afe3a7b1c5d0ba59c4`.
- Datadog files/functions: `dd-java-agent/agent-otel/otel-shim/src/main/java/datadog/opentelemetry/shim/trace/OtelSpanContext.java`, `trace/OtelSpan.java`, and `context/OtelContext.java`.
- Maven Central metadata checked on 2026-06-29: `io.opentelemetry:opentelemetry-api`, `opentelemetry-context`, and `opentelemetry-common` current release `1.63.0`.

## Competitor Pattern

- OpenTelemetry Java gives a stable narrow API seam: `Span.current()`/`Span.fromContext(...)` yields a span, `SpanContext.isValid()` gates usable context, and `TraceFlags.asHex()` exposes the W3C flags needed for a `traceparent`.
- Sentry supports a much deeper bridge: span processors, Sentry propagation headers, baggage handling, Spring Boot conditional configuration, and sample apps where OTel spans and Sentry spans coexist.
- Datadog goes heavier still with an agent shim that maps Datadog spans into OTel `Span`, `SpanContext`, context, baggage, logs, metrics, and event/link structures.

## LogBrew Implementation

- Added optional Java `LogBrewOpenTelemetry` helpers:
  - `traceContextFromCurrentSpan(...)`
  - `traceContextFromContext(...)`
  - `traceContextFromSpan(...)`
  - `traceContextFromSpanContext(...)`
- Helpers return `Optional.empty()` when OTel has no valid active span, and otherwise create a LogBrew child `LogBrewTraceContext` using only OTel trace ID, OTel span ID as parent span ID, and OTel trace flags.
- Added optional Maven dependencies for `opentelemetry-api`, `opentelemetry-context`, and `opentelemetry-common` at `1.63.0`. They are optional so default LogBrew consumers do not get OTel pulled transitively.
- README now shows the app-owned OTel install path and states the boundary clearly.

## Tradeoffs

- Better for LogBrew's current product boundary: tiny typed bridge, no Java agent, no Spring auto-configuration, no exporter/processor ownership, no OTel attribute/event/link ingestion, no baggage/tracestate copy, and no hidden HTTP/logging/client patching.
- Better for privacy by default: the helper cannot read payloads, headers, SQL, URLs, exception messages, stacks, baggage, or tracestate values because it only copies validated IDs and flags.
- Still worse than Sentry and Datadog for automatic Spring/Servlet/JDBC/cache/messaging integrations, full OTel span processor/exporter interop, OTel event/link arrays, baggage/tracestate propagation, semantic-convention depth, and agent-managed context propagation.

## Verification

- Red test first: `bash scripts/check_java_package.sh` failed on missing `LogBrewOpenTelemetry`.
- Green package gate: `bash scripts/check_java_package.sh` passed Java source tests, OTel context tests, Maven metadata checks, javadocs, source jar checks, binary jar checks, README assertions, and packaged examples.
- Installed-artifact smoke: `bash scripts/real_user_java_smoke.sh` passed using a packed LogBrew jar plus real `opentelemetry-api`, `opentelemetry-context`, and `opentelemetry-common` jars. The temporary app created an OTel span context, made it current, copied it into a LogBrew child span, asserted the downstream `traceparent`, rejected invalid OTel context, and proved tracestate values were not copied into telemetry.

## Remaining Gaps

- Java still lacks automatic Spring/Servlet/JDBC/cache/messaging instrumentation, full OTel processor/exporter interop, OTel span events/links ingestion, baggage/tracestate, and broad framework-owned context propagation.
- Next high-impact Java work should move toward one source-backed automatic integration where user value clearly beats the added runtime coupling, with installed-artifact failure/retry/flush proof and explicit privacy tests.
