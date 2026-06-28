# Java Span Event Summaries - 2026-06-29

## Goal

Improve Java trace detail where LogBrew was weaker than Sentry, Datadog, and OpenTelemetry: rich span timelines and exception context on dependency spans. Keep the core Java SDK explicit, JDK-first, and safer than broad automatic instrumentation.

## Sources Read

- Sentry Java SDK: `https://github.com/getsentry/sentry-java.git` at `d8b6ce11cabd05be9a3f03a1d20fe247956d091d`.
- Sentry files/functions: `sentry/src/main/java/io/sentry/ISpan.java` (`setThrowable`, `getThrowable`), `sentry/src/main/java/io/sentry/Span.java` (`setThrowable`, `getThrowable`), `sentry-jdbc/src/main/java/io/sentry/jdbc/SentryJdbcEventListener.java` (`finishSpan`), and `sentry-spring/src/main/java/io/sentry/spring/cache/SentryCacheWrapper.java` (`get`, `put`, `evict`, `clear` paths).
- OpenTelemetry Java: `https://github.com/open-telemetry/opentelemetry-java.git` at `9b57914fc5fdfc5213cc2b4c980112cc987d3276`.
- OpenTelemetry files/functions: `api/all/src/main/java/io/opentelemetry/api/trace/Span.java` (`addEvent`, `recordException`), `sdk/trace/src/main/java/io/opentelemetry/sdk/trace/SdkSpan.java` (`addEvent`, `addTimedEvent`, `recordException`), `sdk/trace/src/main/java/io/opentelemetry/sdk/trace/data/EventData.java`, and `sdk/trace/src/main/java/io/opentelemetry/sdk/trace/data/ExceptionEventData.java`.
- Datadog Java tracer: `https://github.com/DataDog/dd-trace-java.git` at `ffb48aeb95a05df3d20c27afe3a7b1c5d0ba59c4`.
- Datadog files/functions: `internal-api/src/main/java/datadog/trace/bootstrap/instrumentation/api/AgentSpan.java` (`addThrowable` and error APIs), `dd-trace-core/src/main/java/datadog/trace/core/DDSpan.java` (`addThrowable`), and `dd-trace-core/src/main/java/datadog/trace/common/writer/ddagent/TraceMapperV1.java` (`encodeSpanEvents`, `isEncodableSpanEvent`).

## Competitor Pattern

- OpenTelemetry Java exposes first-class span events and exception recording, with SDK-side limits and dedicated exception event data.
- Sentry Java integration code often records throwable and status on dependency spans, then relies on broader framework integrations for automatic capture.
- Datadog Java stores richer error metadata and can encode span events, but the agent-first model is heavier and may include exception messages/stacks depending on path.

## LogBrew Implementation

- Added `SpanEventSummary` to Java core spans. A span may include up to eight named event summaries with optional timestamps and primitive-only metadata.
- Added `SpanAttributes.event(...)`, `SpanAttributes.events(...)`, `Traceparent.SpanInput.event(...)`, and `Traceparent.SpanInput.events(...)`.
- Added `spanEvent(...)` and `spanEvents(...)` to Java database, cache, and queue operation helpers.
- Failed dependency helpers add one automatic `exception` event with `exceptionType` and `exceptionEscaped=true`, while rethrowing the original application exception.
- Dependency span events reuse existing privacy filters, so SQL text, parameters, hosts, cache keys, raw commands, payloads, message bodies, broker URLs, headers, cookies, auth-like keys, exception messages, and stack traces stay out of telemetry.

## Tradeoffs

- Better than competitors for privacy-first explicit instrumentation: no Java agent, no hidden framework patching, no new runtime dependency, no exception message/stack capture in span events, and clear event-count limits.
- Worse than Sentry, Datadog, and OpenTelemetry for automatic JDBC/cache/messaging instrumentation, full OTel event arrays, span links, baggage/tracestate, semantic-convention depth, and broad framework-owned exception hooks.
- This is the safe core step. Optional framework or client integrations can later add heavier automatic behavior when source-backed demand and privacy proof justify it.

## Verification

- Red test first: `bash scripts/check_java_package.sh` failed because `SpanEventSummary`, span event builders, and helper event support did not exist.
- Green package gate: `bash scripts/check_java_package.sh` passed 30 package tests, 6 trace-correlation tests, 2 span-event summary tests, 4 operation-tracing tests, 2 support-ticket draft tests, Maven metadata checks, javadocs, source jar checks, binary jar checks, and packaged examples.
- Installed-artifact smoke: `bash scripts/real_user_java_smoke.sh` proved a packaged jar contains `SpanEventSummary`, dependency spans include success events and type-only exception events, privacy filters drop raw queries/message bodies/exception messages, and existing flush/retry/failure behavior still works.

## Remaining Gaps

- Java still lacks automatic Spring/Servlet/JDBC/cache/messaging integrations, OpenTelemetry context ingestion, span links, baggage/tracestate, richer semantic conventions, and automatic outbound/client instrumentation.
- Next high-impact Java work should add optional framework-owned integrations only when installed-artifact and privacy evidence show the extra coupling is worth it.
