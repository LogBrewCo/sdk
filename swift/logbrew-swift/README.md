# LogBrew Swift SDK

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

`LogBrewLogger` is an opt-in logger facade for Swift and Apple-platform apps. It mirrors common Apple logging levels such as `debug`, `info`, `notice`, `warning`, `error`, `fault`, and `critical`, records the category as the LogBrew logger name, adds subsystem/category and exact Swift level metadata, generates event ids and timestamps by default, and reports capture failures through `onError` instead of throwing from normal logging calls.
