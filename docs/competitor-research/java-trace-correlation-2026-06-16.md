# Java Trace Correlation Comparison - 2026-06-16

## Scope

Follow-up to the all-SDK tracing priority. The Java SDK already had dependency-free W3C `traceparent` parsing, explicit spans, JUL capture, and optional Logback capture. It lacked the Sentry-competitive request-local correlation path where one request trace links Java logs, captured issues, request spans, and request-duration metrics without a Java agent.

## Source Reviewed

- Sentry Java `getsentry/sentry-java` at commit `6dff1c9970ad612ac431980c08abb138218465e0`.
- Read `sentry-servlet/src/main/java/io/sentry/servlet/SentryServletRequestListener.java`: `requestInitialized` and `requestDestroyed`.
- Read `sentry-servlet/src/main/java/io/sentry/servlet/SentryRequestHttpServletRequestProcessor.java`: `process` and `resolveHeadersMap`.
- Read `sentry-spring/src/main/java/io/sentry/spring/SentrySpringFilter.java`: `doFilterInternal`, `configureScope`, and request body gating.
- Read `sentry-spring/src/main/java/io/sentry/spring/SentryTaskDecorator.java`: `decorate`.
- Read `sentry-logback/src/main/java/io/sentry/logback/SentryAppender.java`: `append`, `createEvent`, `captureLog`, and MDC handling.
- Read `sentry/src/main/java/io/sentry/logger/LoggerApi.java`: `captureLog`.
- Read `sentry/src/main/java/io/sentry/metrics/MetricsApi.java`: metric trace/span correlation block.
- OpenTelemetry Java instrumentation `open-telemetry/opentelemetry-java-instrumentation` at commit `8f759eec78231d806bc38aebfcbd93f901ff1615`.
- Read `instrumentation/logback/logback-appender-1.0/library/src/main/java/io/opentelemetry/instrumentation/logback/appender/v1_0/OpenTelemetryAppender.java`: `start`, `append`, and capture toggles.
- Read `instrumentation/logback/logback-appender-1.0/library/src/main/java/io/opentelemetry/instrumentation/logback/appender/v1_0/internal/LoggingEventMapper.java`: `mapLoggingEvent`.
- Read servlet instrumentation file list around `Servlet3Advice`, `Servlet3AsyncContextStartAdvice`, `Servlet5TelemetryFilter`, and `ServletInstrumenterBuilder` to confirm active-context and route-span patterns.
- Datadog Java tracer `DataDog/dd-trace-java` at commit `a099456128b53425e34e5147ec1f15ea2d28dc9b`.
- Read `dd-java-agent/instrumentation-testing/src/main/groovy/TraceCorrelationTest.groovy`: `access trace correlation only under trace`.
- Read `dd-java-agent/instrumentation-testing/src/main/groovy/datadog/trace/agent/test/log/injection/LogContextInjectionTestBase.groovy`: active-scope log injection and thread isolation tests.
- Read `internal-api/src/main/java/datadog/trace/api/propagation/W3CTraceParent.java`: `from`.

## Competitor Patterns

- Sentry forks and closes request contexts around servlet and Spring request handling, then lets events, logs, metrics, and async work read trace/span identity from the active context.
- Sentry and OpenTelemetry both treat request body/header capture as configurable or gated; LogBrew should stay stricter by default and capture neither.
- Sentry's `TaskDecorator` and Datadog's log-injection tests make async/thread boundaries explicit: request trace state should not leak to unrelated threads, and explicit wrapping should carry it when the app chooses.
- Sentry, OpenTelemetry, and Datadog all make logs more useful by attaching active trace/span IDs rather than forcing developers to manually thread IDs through every logger call.

## LogBrew Improvement From This Pass

- Added `LogBrewTraceContext` for immutable W3C-shaped trace/span identity, generated local contexts, incoming `traceparent` continuation, outbound `traceparent`, and primitive correlation metadata.
- Added `LogBrewTrace` with request-local thread context, previous-context reinstatement, current trace access, primitive metadata merging, and explicit `wrapCurrent(...)` helpers for async handoffs.
- Added `LogBrewHttpRequestTelemetry` to emit one request span plus optional `http.server.duration` metric using the same trace/span IDs as logs and issues. The request-entry overload ignores missing or malformed incoming propagation non-fatally and starts a local root trace, while strict `Traceparent.parse(...)` remains available for explicit validation.
- Updated `LogBrewJulHandler` and `LogBrewLogbackAppender` to attach active trace metadata automatically while preserving app-owned logger handlers and existing primitive metadata.
- Made `LogBrewClient` synchronized so request handlers and logger appenders can queue telemetry safely from multiple request threads.
- Added `examples/HttpTraceCorrelation.java` and installed-artifact validation for JUL log, issue, request span, and request-duration metric correlation from one W3C trace.

## Where LogBrew Is Better Today

- Lighter than Sentry, Datadog, and OpenTelemetry for teams that want trace-log-error-metric correlation without a Java agent, global HTTP instrumentation, servlet dependency, Logback replacement, payload capture, header capture, or raw URL capture.
- The request helper records framework route templates and strips query strings/fragments even when route placeholders use braces.
- The core package remains JDK-only except the optional Logback appender, so Spring, Servlet, Micronaut, Quarkus, and other framework-specific packages can layer on top later.

## Where LogBrew Is Still Worse

- No Servlet/Spring filter package yet; Java users must call `LogBrewHttpRequestTelemetry` from app-owned middleware or handlers.
- No automatic async executor/task decorator integration yet beyond explicit `LogBrewTrace.wrapCurrent(...)`.
- No OpenTelemetry context bridge yet; LogBrew continues W3C headers but does not read an active OTel span.
- No JDBC, messaging, cache, outbound HTTP, or framework route resolver integrations yet.

## Updated Evidence

- `bash scripts/check_java_package.sh`: compiles with `javac -Xlint:all -Werror --release 11`, runs 30 package tests plus 6 trace-correlation tests, builds javadocs, packages source/binary jars, and runs `HttpTraceCorrelation` from the packaged jar.
- `bash scripts/check_java_static.sh`: SpotBugs `4.9.8`.
- `bash scripts/real_user_java_smoke.sh`: installed-artifact Java smoke, extracted examples, packaged examples, and HTTP trace-correlation payload proof.
- `bash scripts/check_shell_static.sh`: ShellCheck `0.11.0`.
- `python3 scripts/check_markdown_links.py`.
- `python3 scripts/check_confidentiality_scan.py`.
- `python3 scripts/check_backend_contract_reports.py`.
- `PYTHONDONTWRITEBYTECODE=1 python3 scripts/check_generated_artifacts.py`.
- `git diff --check`.

The trace example verifies one trace/span pair across JUL log, issue, request span, and `http.server.duration` metric metadata; verifies outbound W3C `traceparent`; checks malformed incoming propagation does not fail request setup; and checks query strings, fragments, and raw propagation headers are not serialized into LogBrew telemetry.
