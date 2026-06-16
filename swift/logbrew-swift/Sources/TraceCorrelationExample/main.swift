import Foundation
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

let trace = LogBrewTrace.continueOrCreateContext(
    fromTraceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
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

    let headers = LogBrewTrace.outgoingHeaders()
    precondition(headers["traceparent"] == trace.traceparent)
    precondition(headers["authorization"] == nil)
    precondition(headers["baggage"] == nil)
}

let preview = try client.previewJSON()
precondition(!preview.contains("cart_id"))
precondition(!preview.contains("#pay"))
precondition(!preview.contains("traceparent\""))
print(preview)

let summaryFields = [
    #""ok":true"#,
    #""events":8"#,
    #""traceId":"\#(trace.traceId)""#,
    #""spanId":"\#(trace.spanId)""#,
    #""parentSpanId":"\#(trace.parentSpanId ?? "")""#,
    #""traceSampled":\#(trace.sampled)"#,
]
let summary = "{\(summaryFields.joined(separator: ","))}\n"
FileHandle.standardError.write(Data(summary.utf8))
