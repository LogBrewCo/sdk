import co.logbrew.sdk.ActionAttributes;
import co.logbrew.sdk.EnvironmentAttributes;
import co.logbrew.sdk.IssueAttributes;
import co.logbrew.sdk.LogAttributes;
import co.logbrew.sdk.LogBrewClient;
import co.logbrew.sdk.RecordingTransport;
import co.logbrew.sdk.ReleaseAttributes;
import co.logbrew.sdk.SpanAttributes;
import co.logbrew.sdk.TransportResponse;

public final class ReadmeExample {
    private ReadmeExample() {
    }

    public static void main(String[] args) {
        LogBrewClient client = LogBrewClient.create("LOGBREW_API_KEY", "logbrew-java", "0.1.0");
        enqueueAll(client);

        System.out.println(client.previewJson());
        TransportResponse response = client.shutdown(RecordingTransport.alwaysAccept());
        System.err.println(
            "{\"ok\":true,\"status\":"
                + response.statusCode()
                + ",\"attempts\":"
                + response.attempts()
                + ",\"events\":6}"
        );
    }

    static void enqueueAll(LogBrewClient client) {
        client.release(
            "evt_release_001",
            "2026-06-02T10:00:00Z",
            ReleaseAttributes.create("1.2.3").commit("abc123def456").notes("Public release marker")
        );
        client.environment(
            "evt_environment_001",
            "2026-06-02T10:00:01Z",
            EnvironmentAttributes.create("production").region("global")
        );
        client.issue(
            "evt_issue_001",
            "2026-06-02T10:00:02Z",
            IssueAttributes.create("Checkout timeout", "error").message("Request timed out after retry budget")
        );
        client.log(
            "evt_log_001",
            "2026-06-02T10:00:03Z",
            LogAttributes.create("worker started", "info").logger("job-runner")
        );
        client.span(
            "evt_span_001",
            "2026-06-02T10:00:04Z",
            SpanAttributes.create("GET /health", "trace_001", "span_001", "ok").durationMs(12.5)
        );
        client.action(
            "evt_action_001",
            "2026-06-02T10:00:05Z",
            ActionAttributes.create("deploy", "success")
        );
    }
}
