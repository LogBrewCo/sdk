# Swift Trace Correlation Research - 2026-06-16

## Gap

LogBrew Swift had product timeline helpers and explicit span attributes, but it did not expose an active trace context for Apple-platform code. That made Swift worse than Sentry, Datadog, and OpenTelemetry for the debugging path users expect: one trace connecting logs, errors, product actions, network milestones, metrics, spans, and outgoing propagation.

## Public Source Reviewed

- Sentry Cocoa `getsentry/sentry-cocoa@4da7fcb73836342b63f1aca7449766c2c15f2822`
- Sentry files/functions read: `Sources/Sentry/SentryHub.m` capture/scope paths, `Sources/Sentry/SentryScope.m` span and propagation-context storage, `Sources/Sentry/SentryTracer.m` transaction/span lifecycle, `Sources/Sentry/SentryTraceHeader.m` propagation serialization, `Sources/SentryObjCCompat/SentryObjCSDK.swift` static span/capture wrappers.
- OpenTelemetry Swift `open-telemetry/opentelemetry-swift@291fe3fff413ae9277ac36aec9fd9b51c1caa7e0`
- OpenTelemetry files/functions read: `Sources/Bridges/OTelSwiftLog/LogHandler.swift` active span-to-log record correlation, `Sources/Importers/OpenTracingShim/Propagation.swift` text-map extraction/injection, `Sources/Instrumentation/URLSession/URLSessionLogger.swift` URLSession span creation and propagation injection.
- Datadog iOS `DataDog/dd-sdk-ios@6462c0b81f5221072008443925d8bbf18aa5750b`
- Datadog files/functions read: `DatadogLogs/Sources/RemoteLogger.swift` active span IDs on log events, `DatadogInternal/Sources/NetworkInstrumentation/TraceContext.swift`, `DatadogInternal/Sources/NetworkInstrumentation/Datadog/HTTPHeadersWriter.swift`, and `DatadogRUM/Sources/Instrumentation/Resources/URLSessionRUMResourcesHandler.swift` active-span reuse for resource traces and propagation.
- URLSession helper follow-up reread the same current source commits, focusing on OpenTelemetry `URLSessionLogger.processAndLogRequest(...)` / `instrumentedRequest(...)`, Datadog `DistributedTracing.modify(...)` / `URLSessionRUMResourcesHandler.interceptionDidStart(...)`, and Sentry `SentryTracePropagation.addBaggageHeader(...)` / `addHeaderFieldsToRequest(...)` plus public `urlSession`, `urlSessionDelegate`, and `tracePropagationTargets` options.

## Competitor Pattern

- Sentry gives Apple apps a scope/hub model: captures read the current scope, and scopes hold the active span/transaction plus propagation context. This is ergonomic but heavier and framework-oriented.
- OpenTelemetry keeps trace context in a provider and bridges active span context into logs; URLSession instrumentation can auto-create spans and inject propagation headers. This is standards-aligned but carries a larger instrumentation surface.
- Datadog correlates logs with active span IDs and reuses active span trace IDs as parents for network/RUM resources when available. It also supports multiple propagation formats and baggage, but the RUM/network path is broad and intentionally invasive.

## LogBrew Implementation

- Added dependency-free `LogBrewTraceContext` and `LogBrewTrace` in `swift/logbrew-swift/Sources/LogBrew/LogBrewTrace.swift`.
- `LogBrewTrace.continueOrCreateContext(fromTraceparent:)` continues valid W3C `traceparent` values with a fresh local span ID and falls back to a local root when propagation is missing or malformed.
- `LogBrewTrace.current` uses Swift `@TaskLocal`, so async work inside `withContext(...)` can read the active trace without global mutable trace state.
- `LogBrewClient` now adds active trace metadata to issue, log, action, and metric events. Active trace fields overwrite caller-provided trace keys to avoid spoofed correlation IDs.
- `LogBrewLogger` gets active trace correlation through the client while preserving app-owned logger setup and non-throwing logging calls.
- `captureProductAction(...)` and `captureNetworkMilestone(...)` now merge active trace metadata while keeping existing route/query privacy behavior.
- `LogBrewTrace.spanAttributes(...)` creates span attributes from the active context, including `traceId`, `spanId`, `parentSpanId`, `traceFlags`, and `traceSampled` metadata.
- `LogBrewTrace.outgoingHeaders()` returns only a normalized W3C `traceparent` header for app-owned `URLRequest` usage.
- `LogBrewTrace.startURLSessionSpan(...)` now creates an explicit child span context, returns a copied `URLRequest` with only `traceparent` injected, and keeps the request span ID aligned with `LogBrewClient.captureURLSessionSpan(...)`.
- `captureURLSessionSpan(...)` records sanitized method, route template, status code, duration, primitive metadata, and error type without serializing the raw URL, request/response headers, request/response bodies, or raw propagation header.
- `LogBrewClient` event queue access is now lock-protected for logger and async trace usage.

## Privacy and Weight Tradeoff

LogBrew intentionally did not copy Sentry scope internals, OpenTelemetry URLSession patching, or Datadog RUM/network auto-instrumentation. The Swift SDK still does not patch `URLSession`, capture request/response bodies, collect arbitrary headers, store raw propagation headers, emit visual replay, or create automatic DB/network child spans. URLSession spans are app-owned and explicit: the helper only prepares the request the app passes to URLSession and records a matching span when the app reports completion. Richer automatic instrumentation should remain in dedicated framework packages.

## Evidence

- `swift test --package-path swift/logbrew-swift --scratch-path /tmp/logbrew-swift-trace-test`
- `swift run --package-path swift/logbrew-swift --scratch-path <tmp>/build TraceCorrelationExample` plus `python3 scripts/check_swift_trace_correlation_payload.py <payload>`
- `bash scripts/check_swift_style.sh`
- `bash scripts/check_swift_package.sh`
- `bash scripts/real_user_swift_smoke.sh`

## Remaining Gaps

- Swift still lacks dedicated SwiftUI/UIKit/AppKit lifecycle spans, automatic URLSession instrumentation, baggage/tracestate, existing OpenTelemetry context ingestion, and rich span events/exceptions.
- Objective-C, C, C++, Kotlin Android, Unity, and React Native still need the newer active trace/error-correlation pattern or richer mobile-native equivalents.
