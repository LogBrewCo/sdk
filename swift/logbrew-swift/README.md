# LogBrew Swift SDK

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

Public Swift SDK for sending logs, errors, spans, actions, releases, environments, and explicit metrics from your Swift or Apple-platform app to the hosted LogBrew observability service.

## Install

```swift
.package(url: "https://github.com/LogBrewCo/sdk.git", from: "0.1.0")
```

Use the `LogBrew` product from the `swift/logbrew-swift` package directory.

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

try LogBrewTrace.withContext(trace) {
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

`LogBrewTrace.current` is task-local, so async work started inside `withContext(...)` can read the active context without global state. `LogBrewClient` automatically adds active `traceId`, `spanId`, `parentSpanId`, `traceFlags`, and `traceSampled` metadata to issue, log, action, and metric events. `LogBrewLogger` receives the same correlation through the client. `LogBrewTrace.spanAttributes(...)` reuses the active span id for a span event, `LogBrewTrace.outgoingHeaders()` creates only a normalized `traceparent` header for app-owned requests, and `LogBrewTrace.startURLSessionSpan(...)` creates a child span context plus a copied `URLRequest` with only `traceparent` injected. Call `captureURLSessionSpan(...)` after your URLSession completion to record sanitized method, route template, status, duration, and primitive metadata. If your app collects `URLSessionTaskMetrics` through its own delegate, pass `try LogBrewURLSessionTimings(taskMetrics: metrics)` or app-supplied `LogBrewURLSessionTimings(...)` to include bounded phase timings such as name lookup, connect, TLS, send, wait, receive, and body byte counts.

Use `LogBrewLifecycleTracker` from your own SwiftUI, UIKit, AppKit, or SceneDelegate lifecycle hooks when you want app state transitions such as `active -> background` to appear as child spans on the active trace. The tracker dedupes repeated states, computes previous-state duration from app-owned timestamps, records primitive metadata only, and overwrites spoofed trace metadata with the active child span context. Use the lower-level `captureLifecycleSpan(...)` helper only when your app already owns previous/current state and duration values.

The Swift SDK does not patch `URLSession`, install notification observers, swizzle SwiftUI/UIKit/AppKit lifecycle APIs, add an OpenTelemetry dependency, install OpenTelemetry exporters or processors, read baggage or tracestate, collect arbitrary headers, capture request or response bodies, serialize the raw `traceparent` value into event metadata, derive local session health, or start automatic database/network child spans. URLSession timing metadata is explicit and limited to numeric phase durations and byte counts; it does not include URLs, headers, payloads, cookies, or response text. URLSession and lifecycle spans are explicit and app-owned; keep route templates low-cardinality and query-free, and add richer framework instrumentation only in a dedicated integration package.

## HTTP Delivery

Use `HTTPTransport` when the app is ready to send queued batches to LogBrew. It posts JSON to the production intake by default, passes the SDK key through the `authorization` header, and supports custom endpoints, headers, and timeouts for local collectors or proxies:

```swift
let transport = try HTTPTransport(
    endpoint: URL(string: "https://api.logbrew.com/v1/events")!,
    headers: ["x-logbrew-source": "checkout-ios"],
    timeout: 10
)

let response = try client.flush(transport: transport)
print("status=\(response.statusCode) attempts=\(response.attempts)")
```

Keep personally sensitive values out of event messages and metadata before calling `flush(transport:)`. Use `RecordingTransport` when you want to inspect queued JSON before network delivery.

`LogBrewLogger` is an opt-in logger facade for Swift and Apple-platform apps. It mirrors common Apple logging levels such as `debug`, `info`, `notice`, `warning`, `error`, `fault`, and `critical`, but serializes LogBrew severities as `info`, `warning`, `error`, or `critical`. It records the category as the LogBrew logger name, adds subsystem/category and exact Swift level metadata, generates event ids and timestamps by default, and reports capture failures through `onError` instead of throwing from normal logging calls.
