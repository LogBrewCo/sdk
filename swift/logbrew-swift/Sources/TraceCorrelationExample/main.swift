import Foundation
#if canImport(FoundationNetworking)
    import FoundationNetworking
#endif
import LogBrew

let client = try LogBrewClient.create(
    apiKey: "LOGBREW_API_KEY",
    sdkName: "logbrew-swift-trace",
    sdkVersion: "0.1.0",
)
let logger = try LogBrewLogger(
    client: client,
    subsystem: "co.logbrew.app",
    category: "checkout",
    eventIDPrefix: "ios_log",
    timestampProvider: { "2026-06-02T10:00:03Z" },
)

let openTelemetryParent = try LogBrewTrace.openTelemetrySpanContext(
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
    traceFlags: "01",
)
let trace = LogBrewTrace.context(fromOpenTelemetrySpanContext: openTelemetryParent)
precondition(trace.traceId == openTelemetryParent.traceId)
precondition(trace.parentSpanId == openTelemetryParent.spanId)
let lifecycleTracker = try LogBrewLifecycleTracker(
    client: client,
    initialState: "active",
    initialTimestampMs: 1000,
    eventIDPrefix: "evt_lifecycle_span",
    context: ["screen": "Checkout", "traceId": "spoofed_trace"],
)

try client.release(
    "evt_release_001",
    timestamp: "2026-06-02T10:00:00Z",
    attributes: ReleaseAttributes(version: "1.2.3", commit: "abc123def456", notes: "Public release marker"),
)
try client.environment(
    "evt_environment_001",
    timestamp: "2026-06-02T10:00:01Z",
    attributes: EnvironmentAttributes(name: "production", region: "global"),
)

try LogBrewTrace.withContext(trace) {
    try client.issue(
        "evt_issue_001",
        timestamp: "2026-06-02T10:00:02Z",
        attributes: IssueAttributes(
            title: "Checkout timeout",
            level: .error,
            message: "Request timed out after retry budget",
        ),
    )
    logger.warning("checkout retry scheduled", metadata: ["screen": "Checkout"])
    try client.captureProductAction(
        "evt_action_001",
        timestamp: "2026-06-02T10:00:04Z",
        name: "checkout.pay_tapped",
        metadata: ["component": "pay-button"],
    )
    try client.captureNetworkMilestone(
        "evt_network_milestone_001",
        timestamp: "2026-06-02T10:00:05Z",
        method: "post",
        routeTemplate: "https://mobile.example.test/api/checkout?cart_id=123#pay",
        statusCode: 503,
        durationMs: 184.5,
        metadata: ["retryable": true],
    )
    try client.metric(
        "evt_metric_001",
        timestamp: "2026-06-02T10:00:06Z",
        attributes: MetricAttributes(
            name: "checkout.duration",
            kind: .histogram,
            value: 184.5,
            unit: "ms",
            temporality: .delta,
            metadata: ["routeTemplate": "/api/checkout"],
        ),
    )
    try client.span(
        "evt_span_001",
        timestamp: "2026-06-02T10:00:07Z",
        attributes: LogBrewTrace.spanAttributes(
            name: "POST /api/checkout",
            status: .error,
            durationMs: 184.5,
            metadata: ["routeTemplate": "/api/checkout"],
        ),
    )
    var request = URLRequest(url: URL(string: "https://api.example.com/api/checkout?cart_id=123#pay")!)
    request.httpMethod = "post"
    request.setValue("app-owned-header-value", forHTTPHeaderField: "x-app-context")
    let urlSessionSpan = try LogBrewTrace.startURLSessionSpan(for: request)
    let propagatedTraceparent = urlSessionSpan.request.value(forHTTPHeaderField: "traceparent")
    precondition(propagatedTraceparent == urlSessionSpan.traceContext.traceparent)
    precondition(urlSessionSpan.request.value(forHTTPHeaderField: "x-app-context") == "app-owned-header-value")
    precondition(urlSessionSpan.traceContext.parentSpanId == trace.spanId)
    let urlSessionTimings = try LogBrewURLSessionTimings(
        fetchMs: 184.5,
        nameLookupMs: 2.5,
        connectMs: 10,
        tlsMs: 6.5,
        sendMs: 4,
        waitMs: 120.25,
        receiveMs: 25,
        requestBodyBytes: 512,
        responseBodyBytes: 4096,
    )
    try client.captureURLSessionSpan(
        "evt_urlsession_span_001",
        timestamp: "2026-06-02T10:00:08Z",
        span: urlSessionSpan,
        statusCode: 503,
        durationMs: 184.5,
        metadata: ["component": "pay-api"],
        timings: urlSessionTimings,
    )
    let lifecycleCaptured = try lifecycleTracker.captureTransition(
        to: "background",
        timestamp: "2026-06-02T10:00:09Z",
        atMs: 2532.25,
        metadata: ["component": "scene-delegate"],
    )
    precondition(lifecycleCaptured)
    let duplicateLifecycle = try lifecycleTracker.captureTransition(
        to: "background",
        timestamp: "2026-06-02T10:00:10Z",
        atMs: 2600,
        metadata: ["component": "scene-delegate"],
    )
    precondition(!duplicateLifecycle)

    let headers = LogBrewTrace.outgoingHeaders()
    precondition(headers["traceparent"] == trace.traceparent)
    precondition(headers["authorization"] == nil)
    precondition(headers["baggage"] == nil)
}

let preview = try client.previewJSON()
precondition(!preview.contains("cart_id"))
precondition(!preview.contains("#pay"))
precondition(!preview.contains("app-owned-header-value"))
precondition(!preview.contains("traceparent\""))
print(preview)

let summaryFields = [
    #""ok":true"#,
    #""events":10"#,
    #""traceId":"\#(trace.traceId)""#,
    #""spanId":"\#(trace.spanId)""#,
    #""parentSpanId":"\#(trace.parentSpanId ?? "")""#,
    #""traceSampled":\#(trace.sampled)"#,
]
let summary = "{\(summaryFields.joined(separator: ","))}\n"
FileHandle.standardError.write(Data(summary.utf8))
