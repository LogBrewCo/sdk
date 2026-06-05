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

try print(client.previewJSON())

let transport = RecordingTransport.alwaysAccept()
let response = try client.shutdown(transport: transport)
let summary = "{\"ok\":true,\"status\":\(response.statusCode),\"attempts\":\(response.attempts),\"events\":6}\n"
FileHandle.standardError.write(Data(summary.utf8))
