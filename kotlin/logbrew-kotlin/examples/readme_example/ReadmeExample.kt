import co.logbrew.sdk.ActionAttributes
import co.logbrew.sdk.EnvironmentAttributes
import co.logbrew.sdk.IssueAttributes
import co.logbrew.sdk.LogAttributes
import co.logbrew.sdk.LogBrewClient
import co.logbrew.sdk.RecordingTransport
import co.logbrew.sdk.ReleaseAttributes
import co.logbrew.sdk.SpanAttributes

fun main() {
    val client =
        LogBrewClient.create(
            apiKey = "LOGBREW_API_KEY",
            sdkName = "logbrew-kotlin",
            sdkVersion = "0.1.0",
        )
    enqueueCanonicalEvents(client)
    println(client.previewJson())
    val response = client.flush(RecordingTransport.alwaysAccept())
    System.err.println("""{"ok":true,"status":${response.statusCode},"attempts":${response.attempts},"events":6}""")
}

fun enqueueCanonicalEvents(client: LogBrewClient) {
    client.release(
        "evt_release_001",
        "2026-06-02T10:00:00Z",
        ReleaseAttributes.create("1.2.3").withCommit("abc123def456").withNotes("Public release marker"),
    )
    client.environment(
        "evt_environment_001",
        "2026-06-02T10:00:01Z",
        EnvironmentAttributes.create("production").withRegion("global"),
    )
    client.issue(
        "evt_issue_001",
        "2026-06-02T10:00:02Z",
        IssueAttributes.create("Checkout timeout", "error").withMessage("Request timed out after retry budget"),
    )
    client.log(
        "evt_log_001",
        "2026-06-02T10:00:03Z",
        LogAttributes.create("worker started", "info").withLogger("job-runner"),
    )
    client.span(
        "evt_span_001",
        "2026-06-02T10:00:04Z",
        SpanAttributes.create("GET /health", "trace_001", "span_001", "ok").withDurationMs(12.5),
    )
    client.action(
        "evt_action_001",
        "2026-06-02T10:00:05Z",
        ActionAttributes.create("deploy", "success"),
    )
}
