# Objective-C Trace Correlation Competitor Review - 2026-06-16

## Scope

Goal: close the Objective-C/mobile-native trace correlation gap without copying heavier competitor defaults. The implementation should let Objective-C and mixed Swift/Objective-C apps connect issues, logs, product actions, network milestones, metrics, spans, and outgoing W3C propagation while preserving LogBrew's privacy defaults.

## Public Source Reviewed

- Sentry Cocoa `getsentry/sentry-cocoa@4da7fcb73836342b63f1aca7449766c2c15f2822`
- Sentry paths/functions: `Sources/Sentry/SentryScope.m` `setSpan:`, `buildTraceContext:`, `propagationContextTraceId`; `Sources/Sentry/SentryTraceHeader.m` `value`; `Sources/Sentry/SentryTracePropagation.m` `addHeaderFieldsToRequest:traceHeader:baggageHeader:propagateTraceparent:`, `sessionTaskRequiresPropagation:tracePropagationTargets:`, `isTargetMatch:withTargets:`; `Sources/Sentry/SentrySpanContext.m` `initWithTraceId:spanId:parentId:operation:...`, `serialize`; `Sources/Sentry/SentryDefaultAppStateManager.m` `start`, `stop`, notification observer wiring; `Sources/Swift/Integrations/Session/SentryAutoSessionTrackingIntegration.swift` `tracker.start`, `tracker.stop`; `Sources/Swift/Integrations/Session/SessionTracker.swift` `didBecomeActive`, `startSession`, `willResignActive`, `willTerminate`.
- OpenTelemetry Swift `open-telemetry/opentelemetry-swift@291fe3fff413ae9277ac36aec9fd9b51c1caa7e0`
- OpenTelemetry paths/functions: `Sources/Importers/OpenTracingShim/Propagation.swift` `injectTextFormat`, `extractTextFormat`; `Sources/Bridges/OTelSwiftLog/LogHandler.swift` `log(event:)`; `Sources/Instrumentation/URLSession/URLSessionLogger.swift` `processAndLogRequest(...)`, `instrumentedRequest(...)`, `tracePropagationHTTPHeaders(...)`; `Sources/Instrumentation/Sessions/SessionManager.swift` `getSession`, `locked_startSession`, `locked_refreshSession`; `Sources/Instrumentation/Sessions/SessionEventInstrumentation.swift` `createSessionStartEvent`, `createSessionEndEvent`, `addSession`.
- Datadog iOS `DataDog/dd-sdk-ios@6462c0b81f5221072008443925d8bbf18aa5750b`
- Datadog paths/functions: `DatadogInternal/Sources/NetworkInstrumentation/TraceContext.swift` `TraceContext`; `DatadogInternal/Sources/NetworkInstrumentation/Datadog/HTTPHeadersWriter.swift` `write(traceContext:)`; `DatadogLogs/Sources/RemoteLogger.swift` `internalLog(...)`; `DatadogRUM/Sources/Instrumentation/Resources/URLSessionRUMResourcesHandler.swift` `DistributedTracing`, `interceptionDidStart(...)`, `interceptionDidComplete(...)`; `DatadogRUM/Sources/Instrumentation/AppState/AppStateManager.swift` `start`, `updateAppState`; `DatadogRUM/Sources/Instrumentation/Views/UIKit/UIViewControllerSwizzler.swift` `viewDidAppear`, `viewDidDisappear`; `DatadogRUM/Sources/Instrumentation/Views/RUMViewsHandler.swift` `start(view:)`, `stop(view:)`, app foreground/background handling.

## What Competitors Do Better

- Sentry Cocoa keeps current span/propagation context attached to scope and uses it to enrich event trace context. This makes error-to-trace navigation a default debugging path.
- Sentry can add trace headers to `NSURLSessionTask` when propagation targets match, including optional W3C `traceparent`.
- OpenTelemetry's log bridge can attach active span context to emitted logs.
- OpenTelemetry's URLSession instrumentation creates child spans, injects propagation headers, and closes spans from response/error paths.
- Datadog explicitly correlates logs with active span/RUM context and exposes header writer utilities for outbound propagation.
- Datadog's URLSession RUM resource handler connects resource timing, active context, and propagation headers through an interception lifecycle.
- Sentry, OpenTelemetry, and Datadog all model app lifecycle/session state so mobile users can connect foreground/background transitions with surrounding telemetry.
- Datadog's UIKit view instrumentation is deeper than LogBrew's current app-owned hooks because it can discover view appear/disappear without manual calls, at the cost of swizzling and a larger runtime surface.

## LogBrew Design Response

- Added dependency-free `LBWTraceContext` and `LBWTrace` for Objective-C instead of adding a Sentry-style global hub or automatic `NSURLSession` instrumentation.
- `LBWTraceContext` strictly validates W3C IDs, rejects all-zero trace/span IDs, exposes `traceparent`, creates local child contexts from incoming `traceparent`, and falls back non-fatally through `continueOrCreateContextFromTraceparent:`.
- `LBWTrace` uses a current-thread scope stack so Objective-C apps can correlate telemetry without global mutable request state. Out-of-order scope close removes the correct scope instead of leaking an older context.
- `LBWClient` now merges active trace metadata into issues, logs, actions, and metrics. Active trace fields override caller-provided trace keys to keep correlation internally consistent.
- `spanAttributesWithName:status:durationMs:metadata:error:` gives users a copyable way to create a span linked to the active local span ID and remote parent.
- `outgoingHeaders` returns only normalized `traceparent` for app-owned HTTP clients.
- `LBWTrace startURLSessionSpanForRequest:...` now returns a copied request with only `traceparent`, a fresh child span context, normalized method, and a query/fragment-free route template.
- `LBWClient captureURLSessionSpanWithID:...` records explicit completion spans with sanitized route/status/duration/error metadata while preserving app-owned request headers outside telemetry.
- URLSession spans and network milestones share `LogBrewNetworkValidation`, so method, route, status, and duration rules stay consistent across timeline and tracing helpers.
- `LBWClient captureLifecycleSpanWithID:...` records explicit app-owned lifecycle transitions such as `active -> background` as child spans under the active trace, with previous/current state, optional previous-state duration, primitive app metadata, and trace-key overwrite.
- Lifecycle spans intentionally avoid Sentry/Datadog-style notification observers, session-health derivation, and UIKit/AppKit swizzling until LogBrew has a precise public lifecycle contract for automatic instrumentation.

## Privacy and Footprint Choices

- No automatic `NSURLSession` patching or swizzling.
- No automatic application lifecycle notification observers.
- No UIKit/AppKit method swizzling.
- No local session-health or usage/quota derivation from lifecycle spans.
- No request/response payload capture.
- No arbitrary header capture.
- No raw incoming `traceparent` serialization.
- No query string or fragment capture in network milestones or URLSession span routes.
- No baggage/tracestate yet; this avoids accidentally capturing user/account/session data until a precise public contract is needed.

## Evidence Added

- `objc/logbrew-objc/src/LogBrewTrace.m`
- `objc/logbrew-objc/src/LogBrewNetworkValidation.m`
- `objc/logbrew-objc/src/LogBrewURLSession.m`
- `objc/logbrew-objc/src/LogBrewLifecycle.m`
- `objc/logbrew-objc/examples/trace_correlation.m`
- `scripts/check_objc_trace_correlation_payload.py`
- `bash scripts/check_objc_package.sh`
- `bash scripts/real_user_objc_smoke.sh`

## 2026-06-17 OpenTelemetry SpanContext Follow-Up

Public source re-read for this follow-up:

- OpenTelemetry Swift Core `open-telemetry/opentelemetry-swift-core@4f85f2a5c8138a72384be3edd1dcfc2cc97b297f`: read `Sources/OpenTelemetryApi/Trace/SpanContext.swift` (`SpanContext`, `create`, `createFromRemoteParent`, `isValid`, `isSampled`) and `Sources/OpenTelemetryApi/Trace/Propagation/W3CTraceContextPropagator.swift` (W3C extraction/injection flow). Pattern: the propagation unit carries trace ID, span ID, trace flags, remote state, and tracestate; validity rejects invalid IDs and sampled state comes from trace flags.
- Sentry Cocoa `getsentry/sentry-cocoa@4da7fcb73836342b63f1aca7449766c2c15f2822`: re-read `Sources/Sentry/SentryTracePropagation.m` and `Sources/Sentry/SentryScope.m`. Pattern: Sentry keeps propagation/scope context close to events and outbound propagation, but its richer scope model carries more SDK-owned state than LogBrew should copy into the lightweight Objective-C surface.
- Datadog iOS `DataDog/dd-sdk-ios@6462c0b81f5221072008443925d8bbf18aa5750b`: re-read `DatadogInternal/Sources/NetworkInstrumentation/Datadog/HTTPHeadersWriter.swift` and `DatadogInternal/Sources/NetworkInstrumentation/TraceContext.swift`. Pattern: Datadog separates a trace context from header writing and supports broader propagation styles; LogBrew should preserve only the W3C-compatible trace/span/flags subset for now.

Implemented a dependency-free Objective-C copy bridge:

- `LBWOpenTelemetrySpanContext` validates and normalizes only trace ID, span ID, and trace flags, with a sampled convenience constructor.
- `LBWTrace contextFromOpenTelemetrySpanContext:` creates a fresh LogBrew child context that uses the OpenTelemetry span ID as parent.
- `LBWTrace spanAttributesFromOpenTelemetrySpanContext:...` emits LogBrew span attributes linked to the OTel parent while overwriting spoofed trace metadata.
- Packaged `trace_correlation.m` now starts from an OTel-compatible parent and still proves one trace links Objective-C issue, log, action, network milestone, metric, manual span, URLSession span, lifecycle span, and outgoing W3C propagation.

The bridge intentionally avoids OpenTelemetry dependencies, exporters, processors, global context hooks, live `Context`/`Span` extraction, tracestate/baggage ingestion, raw propagation metadata, automatic `NSURLSession` instrumentation, and payload/header/full-URL/query/fragment capture.

## Remaining Gaps

- Objective-C still lacks automatic UIKit/AppKit lifecycle instrumentation, automatic `NSURLSession` instrumentation, live OpenTelemetry `Context`/`Span` extraction, baggage/tracestate, rich span events/exceptions, URLSession metrics phase breakdown, and native symbolication parity.
