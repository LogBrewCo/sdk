using System;
using LogBrew;

public static class Program
{
    public static void Main()
    {
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "logbrew-dotnet", "0.1.0");
        EnqueueAll(client);

        Console.WriteLine(client.PreviewJson());
        var response = client.Shutdown(RecordingTransport.AlwaysAccept());
        Console.Error.WriteLine("{\"ok\":true,\"status\":" + response.StatusCode + ",\"attempts\":" + response.Attempts + ",\"events\":6}");
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
}
