# Objective-C Trace Correlation Competitor Review - 2026-06-16

## Scope

Goal: close the Objective-C/mobile-native trace correlation gap without copying heavier competitor defaults. The implementation should let Objective-C and mixed Swift/Objective-C apps connect issues, logs, product actions, network milestones, metrics, spans, and outgoing W3C propagation while preserving LogBrew's privacy defaults.

## Public Source Reviewed

- Sentry Cocoa `getsentry/sentry-cocoa@4da7fcb73836342b63f1aca7449766c2c15f2822`
- Sentry paths/functions: `Sources/Sentry/SentryScope.m` `setSpan:`, `buildTraceContext:`, `propagationContextTraceId`; `Sources/Sentry/SentryTraceHeader.m` `value`; `Sources/Sentry/SentryTracePropagation.m` `addHeaderFieldsToRequest:traceHeader:baggageHeader:propagateTraceparent:`, `sessionTaskRequiresPropagation:tracePropagationTargets:`, `isTargetMatch:withTargets:`; `Sources/Sentry/SentrySpanContext.m` `initWithTraceId:spanId:parentId:operation:...`, `serialize`.
- OpenTelemetry Swift `open-telemetry/opentelemetry-swift@291fe3fff413ae9277ac36aec9fd9b51c1caa7e0`
- OpenTelemetry paths/functions: `Sources/Importers/OpenTracingShim/Propagation.swift` `injectTextFormat`, `extractTextFormat`; `Sources/Bridges/OTelSwiftLog/LogHandler.swift` `log(event:)`.
- Datadog iOS `DataDog/dd-sdk-ios@6462c0b81f5221072008443925d8bbf18aa5750b`
- Datadog paths/functions: `DatadogInternal/Sources/NetworkInstrumentation/TraceContext.swift` `TraceContext`; `DatadogInternal/Sources/NetworkInstrumentation/Datadog/HTTPHeadersWriter.swift` `write(traceContext:)`; `DatadogLogs/Sources/RemoteLogger.swift` `internalLog(...)`.

## What Competitors Do Better

- Sentry Cocoa keeps current span/propagation context attached to scope and uses it to enrich event trace context. This makes error-to-trace navigation a default debugging path.
- Sentry can add trace headers to `NSURLSessionTask` when propagation targets match, including optional W3C `traceparent`.
- OpenTelemetry's log bridge can attach active span context to emitted logs.
- Datadog explicitly correlates logs with active span/RUM context and exposes header writer utilities for outbound propagation.

## LogBrew Design Response

- Added dependency-free `LBWTraceContext` and `LBWTrace` for Objective-C instead of adding a Sentry-style global hub or automatic `NSURLSession` instrumentation.
- `LBWTraceContext` strictly validates W3C IDs, rejects all-zero trace/span IDs, exposes `traceparent`, creates local child contexts from incoming `traceparent`, and falls back non-fatally through `continueOrCreateContextFromTraceparent:`.
- `LBWTrace` uses a current-thread scope stack so Objective-C apps can correlate telemetry without global mutable request state. Out-of-order scope close removes the correct scope instead of leaking an older context.
- `LBWClient` now merges active trace metadata into issues, logs, actions, and metrics. Active trace fields override caller-provided trace keys to keep correlation internally consistent.
- `spanAttributesWithName:status:durationMs:metadata:error:` gives users a copyable way to create a span linked to the active local span ID and remote parent.
- `outgoingHeaders` returns only normalized `traceparent` for app-owned HTTP clients.

## Privacy and Footprint Choices

- No `NSURLSession` patching.
- No request/response payload capture.
- No arbitrary header capture.
- No raw incoming `traceparent` serialization.
- No query string or fragment capture in network milestones.
- No baggage/tracestate yet; this avoids accidentally capturing user/account/session data until a precise public contract is needed.

## Evidence Added

- `objc/logbrew-objc/src/LogBrewTrace.m`
- `objc/logbrew-objc/examples/trace_correlation.m`
- `scripts/check_objc_trace_correlation_payload.py`
- `bash scripts/check_objc_package.sh`
- `bash scripts/real_user_objc_smoke.sh`

## Remaining Gaps

- Objective-C still lacks UIKit/AppKit lifecycle spans, `NSURLSession` child-span helpers, OpenTelemetry context ingestion, baggage/tracestate, and rich span events/exceptions.
- C, C++, Kotlin Android, Unity, and React Native still need the newer active trace/error-correlation model or richer mobile-native equivalents.
