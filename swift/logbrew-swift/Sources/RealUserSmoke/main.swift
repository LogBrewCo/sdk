import Foundation
import LogBrew

let client = try LogBrewClient.create(
    apiKey: "LOGBREW_API_KEY",
    sdkName: "logbrew-swift",
    sdkVersion: "0.1.0",
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
try client.issue(
    "evt_issue_001",
    timestamp: "2026-06-02T10:00:02Z",
    attributes: IssueAttributes(
        title: "Checkout timeout",
        level: .error,
        message: "Request timed out after retry budget",
    ),
)
try client.log(
    "evt_log_001",
    timestamp: "2026-06-02T10:00:03Z",
    attributes: LogAttributes(message: "worker started", level: .info, logger: "job-runner"),
)
try client.span(
    "evt_span_001",
    timestamp: "2026-06-02T10:00:04Z",
    attributes: SpanAttributes(
        name: "GET /health",
        traceId: "trace_001",
        spanId: "span_001",
        status: .ok,
        durationMs: 12.5,
    ),
)
try client.action(
    "evt_action_001",
    timestamp: "2026-06-02T10:00:05Z",
    attributes: ActionAttributes(name: "deploy", status: .success),
)

let preview = try client.previewJSON()
let transport = RecordingTransport(
    scriptedResponses: [
        .failure(.network("temporary network failure")),
        .status(202),
    ],
)
let response = try client.shutdown(transport: transport)

let httpClient = try LogBrewClient.create(
    apiKey: "LOGBREW_API_KEY",
    sdkName: "logbrew-swift-http",
    sdkVersion: "0.1.0",
    maxRetries: 1,
)
try httpClient.log(
    "evt_swift_http_transport",
    timestamp: "2026-06-02T10:00:06Z",
    attributes: LogAttributes(message: "swift http transport sent", level: .info, logger: "swift-http"),
)
var capturedAuthorization = ""
let httpTransport = try HTTPTransport(
    endpoint: URL(string: "https://example.logbrew.test/v1/events")!,
    headers: ["x-logbrew-source": "swift-smoke"],
    requester: { request in
        capturedAuthorization = request.value(forHTTPHeaderField: "authorization") ?? ""
        return capturedAuthorization.isEmpty ? 500 : 202
    },
)
let httpResponse = try httpClient.flush(transport: httpTransport)
precondition(capturedAuthorization == "Bearer LOGBREW_API_KEY")
let httpAttempts = httpResponse.attempts

let metricClient = try LogBrewClient.create(
    apiKey: "LOGBREW_API_KEY",
    sdkName: "logbrew-swift-metrics",
    sdkVersion: "0.1.0",
)
try metricClient.metric(
    "evt_metric_001",
    timestamp: "2026-06-02T10:00:06Z",
    attributes: MetricAttributes(
        name: "queue.depth",
        kind: .gauge,
        value: 42,
        unit: "items",
        temporality: .instant,
        metadata: ["queue": "checkout"],
    ),
)
let metricPreview = try metricClient.previewJSON()
precondition(metricPreview.contains(#""type" : "metric""#))
precondition(metricPreview.contains(#""name" : "queue.depth""#))
precondition(metricPreview.contains(#""temporality" : "instant""#))

let timelineClient = try LogBrewClient.create(
    apiKey: "LOGBREW_API_KEY",
    sdkName: "logbrew-swift-timeline",
    sdkVersion: "0.1.0",
)
let timelineContext = ProductTimelineContext(
    sessionId: "session_123",
    screen: "Checkout",
    traceId: "trace_abc",
    funnel: "checkout",
    step: "payment",
    metadata: ["platform": "ios"],
)
try timelineClient.captureProductAction(
    "evt_product_action_001",
    timestamp: "2026-06-02T10:00:07Z",
    name: "checkout.pay_tapped",
    context: timelineContext,
    metadata: ["component": "pay-button"],
)
try timelineClient.captureNetworkMilestone(
    "evt_network_milestone_001",
    timestamp: "2026-06-02T10:00:08Z",
    method: "post",
    routeTemplate: "https://mobile.example.test/api/checkout?itemId=123#pay",
    statusCode: 503,
    durationMs: 184.5,
    context: timelineContext,
)
let timelinePreview = try timelineClient.previewJSON()
precondition(timelinePreview.contains(#""source" : "swift.action""#))
precondition(timelinePreview.contains(#""source" : "swift.network""#))
precondition(timelinePreview.contains(#""name" : "POST \/api\/checkout""#))
precondition(timelinePreview.contains(#""routeTemplate" : "\/api\/checkout""#))
precondition(timelinePreview.contains(#""status" : "failure""#))
precondition(!timelinePreview.contains("itemId"))
precondition(!timelinePreview.contains("#pay"))

print(preview)
let flushAttempts = response.attempts
let summaryFields = [
    #""ok":true"#,
    #""status":\#(response.statusCode)"#,
    #""attempts":\#(flushAttempts)"#,
    #""events":6"#,
    #""metricEvents":1"#,
    #""timelineEvents":2"#,
    #""networkAction":"POST /api/checkout""#,
    #""httpAttempts":\#(httpAttempts)"#,
]
let summary = "{\(summaryFields.joined(separator: ","))}\n"
FileHandle.standardError.write(Data(summary.utf8))
