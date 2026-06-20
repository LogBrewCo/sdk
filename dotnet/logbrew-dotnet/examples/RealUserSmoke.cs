using System;
using System.Collections.Generic;
using LogBrew;

public static class Program
{
    public static void Main()
    {
        var client = NewClient();
        EnqueueAll(client);
        Console.WriteLine(client.PreviewJson());
        var response = client.Shutdown(RecordingTransport.AlwaysAccept());

        var retryClient = NewClient();
        EnqueueAll(retryClient);
        var retryResponse = retryClient.Flush(new RecordingTransport(new object[]
        {
            TransportException.Network("temporary outage"),
            202
        }));
        var supportDraftRedacted = SupportDraftRedacted();

        var rejectedAfterShutdown = false;
        try
        {
            client.Action("evt_action_002", "2026-06-02T10:00:06Z", ActionAttributes.Create("deploy", "success"));
        }
        catch (SdkException error)
        {
            rejectedAfterShutdown = error.Code == "shutdown_error";
        }

        Console.Error.WriteLine(
            "{\"ok\":" + (rejectedAfterShutdown ? "true" : "false") +
            ",\"status\":" + response.StatusCode +
            ",\"attempts\":" + response.Attempts +
            ",\"retryAttempts\":" + retryResponse.Attempts +
            ",\"supportDraftRedacted\":" + (supportDraftRedacted ? "true" : "false") +
            ",\"events\":6}");
    }

    private static LogBrewClient NewClient()
    {
        return LogBrewClient.Create("LOGBREW_API_KEY", "logbrew-dotnet", "0.1.0");
    }

    private static void EnqueueAll(LogBrewClient client)
    {
        client.Release("evt_release_001", "2026-06-02T10:00:00Z", ReleaseAttributes.Create("1.2.3").WithCommit("abc123def456").WithNotes("Public release marker"));
        client.Environment("evt_environment_001", "2026-06-02T10:00:01Z", EnvironmentAttributes.Create("production").WithRegion("global"));
        client.Issue("evt_issue_001", "2026-06-02T10:00:02Z", IssueAttributes.Create("Checkout timeout", "error").WithMessage("Request timed out after retry budget"));
        client.Log("evt_log_001", "2026-06-02T10:00:03Z", LogAttributes.Create("worker started", "info").WithLogger("job-runner"));
        client.Span("evt_span_001", "2026-06-02T10:00:04Z", SpanAttributes.Create("GET /health", "trace_001", "span_001", "ok").WithDurationMs(12.5));
        client.Action("evt_action_001", "2026-06-02T10:00:05Z", ActionAttributes.Create("deploy", "success"));
    }

    private static bool SupportDraftRedacted()
    {
        var draft = SupportTicketDraft.Create(
            SupportTicketDraftInput.Create("sdk", "ingest_failure", "Telemetry failed", "Flush failed")
                .WithProjectId("proj_123")
                .WithRuntime(".NET 10")
                .WithSdkPackage("LogBrew")
                .WithTraceId("4BF92F3577B34DA6A3CE929D0E0E4736")
                .WithDiagnostics(new Dictionary<string, object?>
                {
                    ["apiKey"] = string.Concat("lbw", "_ingest_", "sample"),
                    ["endpoint"] = "https://api.example/ingest?debug=true#fragment",
                    ["localPath"] = "/Users/example/app/.env",
                    ["error"] = new InvalidOperationException("raw message is omitted")
                }));
        var json = draft.ToJson();
        return json.Contains("\"apiKey\": \"[redacted]\"", StringComparison.Ordinal)
            && json.Contains("\"endpoint\": \"[redacted-url]/ingest\"", StringComparison.Ordinal)
            && json.Contains("\"localPath\": \"[redacted-path]\"", StringComparison.Ordinal)
            && json.Contains("\"trace_id\": \"4bf92f3577b34da6a3ce929d0e0e4736\"", StringComparison.Ordinal)
            && json.Contains("\"type\": \"System.InvalidOperationException\"", StringComparison.Ordinal)
            && !json.Contains("lbw_ingest_sample", StringComparison.Ordinal)
            && !json.Contains("api.example", StringComparison.Ordinal)
            && !json.Contains("/Users/example", StringComparison.Ordinal)
            && !json.Contains("raw message", StringComparison.Ordinal);
    }
}
