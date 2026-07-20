# LogBrew Swift SDK

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

Public Swift SDK for sending logs, errors, spans, actions, releases, environments, and explicit metrics from your Swift or Apple-platform app to the hosted LogBrew observability service.

For Apple app setup flows, choose the Swift path first. Use this SDK for iOS, macOS, tvOS, and watchOS Swift apps through SwiftPM. Objective-C and mixed Swift/Objective-C apps that cannot consume the Swift package can use the advanced source/header variant in [`objc/logbrew-objc`](../../objc/logbrew-objc).

## Install

```swift
.package(url: "https://github.com/LogBrewCo/sdk.git", from: "0.1.1")
```

Use the `LogBrew` product from the repository root SwiftPM package. Add the separate `LogBrewCrash` product only when your Apple app explicitly opts into native fatal-crash capture. Local contributors can also open the Swift package directly from `swift/logbrew-swift`.

The package ships a `LogBrew` library product plus copyable examples for creating a client, previewing queued JSON, flushing through a transport, and using the Swift logger facade in your own app. If you use an AI coding assistant, ask it to install the `LogBrew` product, create one app-owned client, wire your chosen signals, and keep personally sensitive values out of messages and metadata.

## Example

```swift
import LogBrew

let client = try LogBrewClient.create(
    apiKey: "LOGBREW_API_KEY",
    sdkName: "logbrew-swift",
    sdkVersion: "0.1.0"
)

try client.release(
    "evt_release_001",
    timestamp: "2026-06-02T10:00:00Z",
    attributes: ReleaseAttributes(version: "1.2.3", commit: "abc123def456", notes: "Public release marker")
)
try client.log(
    "evt_log_001",
    timestamp: "2026-06-02T10:00:03Z",
    attributes: LogAttributes(message: "worker started", level: .info, logger: "job-runner")
)
try client.metric(
    "evt_metric_001",
    timestamp: "2026-06-02T10:00:06Z",
    attributes: MetricAttributes(
        name: "queue.depth",
        kind: .gauge,
        value: 42,
        unit: "items",
        temporality: .instant,
        metadata: ["queue": "checkout"]
    )
)
try client.captureNetworkMilestone(
    "evt_network_milestone_001",
    timestamp: "2026-06-02T10:00:08Z",
    method: "POST",
    routeTemplate: "/api/checkout",
    statusCode: 202,
    durationMs: 184.5,
    context: ProductTimelineContext(sessionId: "session_123", screen: "Checkout")
)

let logger = try LogBrewLogger(
    client: client,
    subsystem: "co.logbrew.app",
    category: "checkout",
    metadata: ["build": "debug"]
)
logger.warning("checkout button tapped", metadata: ["screen": "Checkout"])

print(try client.previewJSON())

let transport = RecordingTransport.alwaysAccept()
let response = try client.shutdown(transport: transport)
print("status=\(response.statusCode) attempts=\(response.attempts)")
```

Use a clearly fake placeholder like `LOGBREW_API_KEY` in examples. Call `flush(transport:)` or `shutdown(transport:)` to send queued events through a transport, and use `previewJSON()` when you want a stable local JSON preview before sending anything.

## Automatic Delivery (Opt-In)

Manual capture and delivery remain the default. When the client should own delivery, start one explicit scheduler with an app-owned transport before capturing events:

```swift
let transport = try HTTPTransport(timeout: 5)
try client.startAutomaticDelivery(
    transport: transport,
    options: AutomaticDeliveryOptions(interval: 5, threshold: 100)
)

try client.log(
    "evt_log_automatic_001",
    timestamp: "2026-06-02T10:00:03Z",
    attributes: LogAttributes(message: "worker started", level: .info)
)

let health = client.deliveryHealth()
print("state=\(health.state) queued=\(health.queuedEvents) dropped=\(health.droppedEvents)")
_ = try client.shutdown()
```

Automatic delivery keeps at most 1,000 events and 4 MiB in memory, sends at most 100 events and 256 KiB per request, and retains the exact failed prefix for bounded retry. Interval and retry-delay options must not exceed 24 hours. Authentication, quota, validation, and other terminal failures pause delivery without dropping the queue; correct the condition and call `recoverAutomaticDelivery()`. `stopAutomaticDelivery()` returns the client to manual mode and preserves unacknowledged events. `deliveryHealth()` contains fixed counters and states only, never event content, identifiers, API keys, endpoints, headers, or raw transport errors. The queue is process-memory only; call `shutdown()` during an orderly app termination when the platform gives your app time to finish work.

## Durable Delivery (Opt-In)

Durable delivery is separate from automatic delivery. Enable it before starting automatic delivery when accepted events must survive process termination:

```swift
let applicationSupport = try FileManager.default.url(
    for: .applicationSupportDirectory,
    in: .userDomainMask,
    appropriateFor: nil,
    create: true
)
let logBrewDirectory = applicationSupport.appendingPathComponent("LogBrew", isDirectory: true)
try FileManager.default.createDirectory(
    at: logBrewDirectory,
    withIntermediateDirectories: true,
    attributes: [.posixPermissions: 0o700]
)

try client.enableDurableDelivery(
    options: DurableDeliveryOptions(directory: logBrewDirectory)
)
try client.startAutomaticDelivery(transport: transport)
```

Pass a private Application Support directory owned by your app. The SDK creates and exclusively owns only its fixed `logbrew-delivery-v1` child. It applies owner-only permissions, Apple file protection where available, and backup exclusion. Event payloads are stored, but API keys, endpoints, headers, and raw transport errors are not. One process and one client may own the child at a time.

Durable delivery preserves FIFO order and the exact failed request prefix across restart. Corrupt, unknown, or unreadable durable state pauses capture and delivery instead of silently deleting data. After inspecting the cause, call `purgeDurableDelivery()` to remove only the SDK-owned child and explicitly discard its queued events. At-least-once delivery can duplicate a request when a process stops after the server accepts it but before local acknowledgement completes. Atomic records detect incomplete or corrupt state; they do not guarantee survival when the operating system has not committed a write before sudden power loss. Manual and process-memory delivery remain the defaults.

## Metrics

Use `client.metric(...)` when your app owns a numeric measurement you want to send to LogBrew:

```swift
try client.metric(
    "evt_metric_001",
    timestamp: "2026-06-02T10:00:06Z",
    attributes: MetricAttributes(
        name: "checkout.queue.depth",
        kind: .gauge,
        value: 12,
        unit: "items",
        temporality: .instant,
        metadata: ["queue": "checkout"]
    )
)
```

Supported metric kinds are `counter`, `gauge`, and `histogram`. Counters and histograms use `delta` or `cumulative` temporality and must be non-negative. Gauges use `instant` temporality and may be negative. Keep metric metadata low-cardinality and primitive, such as service, route template, queue name, plan, or region. Avoid user ids, raw URLs, query strings, stack traces, and unbounded labels.

The Swift SDK does not automatically collect app runtime, URLSession, SwiftUI, or database metrics. Add explicit measurements where they are meaningful for your product, or keep those signals in framework-owned integrations when you add them.

## Product Timelines

Use `captureProductAction(...)` when your Swift, iOS, macOS, watchOS, or tvOS app owns a meaningful product step:

```swift
let context = ProductTimelineContext(
    sessionId: "session_123",
    screen: "Checkout",
    traceId: "trace_abc",
    funnel: "checkout",
    step: "payment"
)

try client.captureProductAction(
    "evt_product_action_001",
    timestamp: "2026-06-02T10:00:07Z",
    name: "checkout.pay_tapped",
    context: context,
    metadata: ["component": "pay-button"]
)
```

Use `captureNetworkMilestone(...)` for app-owned API milestones that should line up with actions, errors, logs, and traces:

```swift
try client.captureNetworkMilestone(
    "evt_network_milestone_001",
    timestamp: "2026-06-02T10:00:08Z",
    method: "POST",
    routeTemplate: "/api/checkout",
    statusCode: 503,
    durationMs: 184.5,
    context: context,
    metadata: ["retryable": true]
)
```

Network helpers normalize the method, strip query strings and fragments from route templates, default HTTP `4xx` and `5xx` milestones to `failure`, and store primitive metadata such as `sessionId`, `screen`, `traceId`, `funnel`, and `step`. They do not patch `URLSession`, record visual replay, collect headers, or capture request or response bodies. Keep user-entered text, raw URLs, query strings, headers, and payloads out of timeline metadata.

## Trace Correlation

Use `LogBrewTrace` when app-owned Swift work should keep logs, errors, product actions, metrics, and spans on the same W3C trace. Valid incoming `traceparent` values continue the upstream trace with a fresh local span id; missing or malformed propagation starts a local root trace without throwing into your app:

```swift
let trace = LogBrewTrace.continueOrCreateContext(
    fromTraceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
)

try await LogBrewTrace.withContext(trace) {
    logger.warning("checkout retry scheduled", metadata: ["screen": "Checkout"])
    try client.issue(
        "evt_issue_001",
        timestamp: "2026-06-02T10:00:02Z",
        attributes: IssueAttributes(title: "Checkout timeout", level: .error)
    )
    try client.captureNetworkMilestone(
        "evt_network_milestone_001",
        timestamp: "2026-06-02T10:00:08Z",
        method: "POST",
        routeTemplate: "/api/checkout",
        statusCode: 503,
        durationMs: 184.5
    )
    try client.span(
        "evt_span_001",
        timestamp: "2026-06-02T10:00:09Z",
        attributes: try LogBrewTrace.spanAttributes(name: "POST /api/checkout", status: .error, durationMs: 184.5)
    )

    var request = URLRequest(url: URL(string: "https://api.example.com/api/checkout")!)
    request.httpMethod = "POST"
    let requestSpan = try LogBrewTrace.startURLSessionSpan(for: request)
    // Send requestSpan.request with your app-owned URLSession.
    let timings = try LogBrewURLSessionTimings(
        fetchMs: 184.5,
        nameLookupMs: 2.5,
        connectMs: 10,
        tlsMs: 6.5,
        sendMs: 4,
        waitMs: 120.25,
        receiveMs: 25,
        responseBodyBytes: 4096
    )
    try client.captureURLSessionSpan(
        "evt_urlsession_span_001",
        timestamp: "2026-06-02T10:00:10Z",
        span: requestSpan,
        statusCode: 503,
        durationMs: 184.5,
        timings: timings,
        metadata: ["component": "checkout-api"]
    )

    let urlSessionTracer = try LogBrewURLSessionTracer(
        client: client,
        onCaptureError: { error in
            // Telemetry capture failures should not break app networking.
            print("LogBrew URLSession span capture failed: \(error)")
        }
    )
    let (_, response) = try await urlSessionTracer.data(
        for: request,
        routeTemplate: "/api/checkout",
        metadata: ["component": "checkout-api"]
    )
    print("status=\((response as? HTTPURLResponse)?.statusCode ?? 0)")

    let lifecycleTracker = try LogBrewLifecycleTracker(
        client: client,
        initialState: "active",
        initialTimestampMs: 1000,
        eventIDPrefix: "evt_lifecycle_span",
        context: ["screen": "Checkout"]
    )
    try lifecycleTracker.captureTransition(
        to: "background",
        timestamp: "2026-06-02T10:00:11Z",
        atMs: 2532.25,
        metadata: ["component": "scene-delegate"]
    )
}
```

If your app already uses OpenTelemetry, copy only the stable W3C fields from the app-owned `SpanContext` and let LogBrew create its own child span. This keeps LogBrew dependency-free and avoids installing an exporter or processor:

```swift
let otelParent = try LogBrewTrace.openTelemetrySpanContext(
    traceId: otelSpanContext.traceId.hexString,
    spanId: otelSpanContext.spanId.hexString,
    traceFlags: otelSpanContext.traceFlags.hexString
)
let trace = LogBrewTrace.context(fromOpenTelemetrySpanContext: otelParent)
```

For a live OpenTelemetry `SpanContext`, keep the conformance in your app target so LogBrew still does not depend on OpenTelemetry:

```swift
extension SpanContext: LogBrewOpenTelemetrySpanContextCarrier {
    public var logBrewOpenTelemetryTraceId: String { traceId.hexString }
    public var logBrewOpenTelemetrySpanId: String { spanId.hexString }
    public var logBrewOpenTelemetryTraceFlags: String { traceFlags.hexString }
    public var logBrewOpenTelemetryIsValid: Bool { isValid }
}

if let otelParent = try LogBrewTrace.openTelemetrySpanContext(from: appOwnedOpenTelemetrySpan.context) {
    let trace = LogBrewTrace.context(fromOpenTelemetrySpanContext: otelParent)
    // Run LogBrew work under trace.
}
```

`LogBrewTrace.current` is task-local, so async work started inside `withContext(...)` can read the active context without global state. `LogBrewClient` automatically adds active `traceId`, `spanId`, `parentSpanId`, `traceFlags`, and `traceSampled` metadata to issue, log, action, and metric events. `LogBrewLogger` receives the same correlation through the client. `LogBrewTrace.spanAttributes(...)` reuses the active span id for a span event, `LogBrewTrace.outgoingHeaders()` creates only a normalized `traceparent` header for app-owned requests, and `LogBrewTrace.startURLSessionSpan(...)` creates a child span context plus a copied `URLRequest` with only `traceparent` injected. Call `captureURLSessionSpan(...)` after your URLSession completion to record sanitized method, route template, status, duration, and primitive metadata. Use `LogBrewURLSessionTracer` when you want a small app-owned wrapper around `URLSession.data(for:)`: it injects one `traceparent`, measures monotonic duration, captures success or failure spans, reports span-capture failures through `onCaptureError`, and rethrows the original request error. If your app collects `URLSessionTaskMetrics` through its own delegate, pass `try LogBrewURLSessionTimings(taskMetrics: metrics)` or app-supplied `LogBrewURLSessionTimings(...)` to include bounded phase timings such as name lookup, connect, TLS, send, wait, receive, and body byte counts.

Use `LogBrewLifecycleTracker` from your own SwiftUI, UIKit, AppKit, or SceneDelegate lifecycle hooks when you want app state transitions such as `active -> background` to appear as child spans on the active trace. The tracker dedupes repeated states, computes previous-state duration from app-owned timestamps, records primitive metadata only, and overwrites spoofed trace metadata with the active child span context. Use the lower-level `captureLifecycleSpan(...)` helper only when your app already owns previous/current state and duration values.

The Swift SDK does not patch `URLSession`, install notification observers, swizzle SwiftUI/UIKit/AppKit lifecycle APIs, add an OpenTelemetry dependency, install OpenTelemetry exporters or processors, read baggage or tracestate, collect arbitrary headers, capture request or response bodies, serialize the raw `traceparent` value into event metadata, derive local session health, or start automatic database/network child spans. URLSession timing metadata is explicit and limited to numeric phase durations and byte counts; it does not include URLs, headers, payloads, cookies, or response text. URLSession and lifecycle spans are explicit and app-owned; keep route templates low-cardinality and query-free, and add richer framework instrumentation only in a dedicated integration package.

## Native Fatal Crashes

Add the opt-in `LogBrewCrash` SwiftPM product when one app-owned integration should capture fatal Apple process crashes and replay a privacy-bounded issue on the next launch. `LogBrewCrash` uses the established KSCrash recording engine; LogBrew does not implement signal or Mach exception handling itself.

```swift
import Foundation
import LogBrew
import LogBrewCrash

let applicationSupport = try FileManager.default.url(
    for: .applicationSupportDirectory,
    in: .userDomainMask,
    appropriateFor: nil,
    create: true
)
let crashCapture = NativeCrashCapture(
    configuration: try NativeCrashConfiguration(
        storageDirectory: applicationSupport.appendingPathComponent("LogBrewCrash", isDirectory: true),
        maxStoredReports: 5
    )
)

try crashCapture.install()

let replay = try crashCapture.replayPendingReports { record in
    do {
        try record.enqueue(in: client)
        let response = try client.flush(transport: transport)
        return (200 ..< 300).contains(response.statusCode)
    } catch {
        return false
    }
}
print("acknowledged=\(replay.acknowledged) pending=\(replay.pending)")
```

The replay handler must return `true` only after the issue has been accepted by delivery. Returning `false` retains that report and every later report. Replay is oldest-first, uses the crash report's stable UUID as the event id, verifies the raw report did not change before acknowledgement, and fails closed on malformed, oversized, replaced, or undeletable reports. Enqueueing the same retained crash into the same in-memory client is idempotent, while a different event with that ID fails closed. `purge()` is an explicit local deletion operation; `status()` exposes only lifecycle, pending/acknowledged counts, and a fixed outcome enum. KSCrash does not expose a directory-fsync acknowledgement API, so a power loss immediately after deletion can conservatively replay the same stable event ID on a later launch rather than silently dropping a visible pending report.

Capture is process-wide and intentionally single-owner because fatal signal and Mach exception handlers cannot be safely stacked. Installation is idempotent for the owning object, but ownership cannot be transferred or uninstalled until process restart, and an inherited post-fork object fails closed. Use a dedicated directory whose parent already exists. LogBrew normalizes it, rejects a symlink or non-directory target, pins its inode for the integration lifetime, and tightens it to owner-only access before engine installation. The engine keeps at most five raw reports by default; replay rejects a raw report larger than 4 MiB by default. KSCrash's raw app-local report can still contain stack, binary, system, and application details even though memory introspection, queue names, user context, and console capture are disabled. Treat that directory as app-controlled sensitive data and apply your own cloud-synchronization, data-protection, consent, and retention policy.

Only fixed title, critical severity, replay marker, allowlisted crash mechanism, and privacy-bounded native frame identities and offsets are added to the LogBrew issue. Raw reports, exception reasons, messages, stack memory, thread names, console logs, paths, process data, user data, headers, authentication data, and device identity are not uploaded by this integration. These frames are capture-only metadata; native artifact upload and user-visible hosted symbolication are not part of this feature.

The same product exposes Objective-C names through its generated module header for mixed and Objective-C SwiftPM targets:

```objective-c
@import LogBrewCrash;

NSError *error = nil;
LBWNativeCrashConfiguration *configuration =
    [[LBWNativeCrashConfiguration alloc] initWithStorageDirectory:directoryURL
                                                 maxStoredReports:5
                                                   maxReplayBytes:4 * 1024 * 1024
                                                              error:&error];
LBWNativeCrashCapture *capture =
    [[LBWNativeCrashCapture alloc] initWithConfiguration:configuration];
[capture installAndReturnError:&error];

LBWNativeCrashReplayResult *result =
    [capture replayPendingReportsWithHandler:^BOOL(LBWNativeCrashRecord *record) {
      // Send one fixed critical issue with record.eventID, record.timestamp, and record.mechanism.
      // Return YES only after the app's LogBrew transport accepts it.
      return NO;
    } error:&error];
```

## HTTP Delivery

Use `HTTPTransport` when the app is ready to send queued batches to LogBrew. It posts JSON to the production intake by default, passes the SDK key through the `authorization` header, and supports custom endpoints, headers, and timeouts for local collectors or proxies:

```swift
let transport = try HTTPTransport(
    endpoint: URL(string: "https://api.logbrew.co/v1/events")!,
    headers: ["x-logbrew-source": "checkout-ios"],
    timeout: 10
)

let response = try client.flush(transport: transport)
print("status=\(response.statusCode) attempts=\(response.attempts)")
```

Keep personally sensitive values out of event messages and metadata before calling `flush(transport:)`. Use `RecordingTransport` when you want to inspect queued JSON before network delivery.

`LogBrewLogger` is an opt-in logger facade for Swift and Apple-platform apps. It mirrors common Apple logging levels such as `debug`, `info`, `notice`, `warning`, `error`, `fault`, and `critical`, but serializes LogBrew severities as `info`, `warning`, `error`, or `critical`. It records the category as the LogBrew logger name, adds subsystem/category and exact Swift level metadata, generates event ids and timestamps by default, and reports capture failures through `onError` instead of throwing from normal logging calls.
