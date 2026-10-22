using System;
using System.Collections.Generic;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using LogBrew;

internal static class ClientReportTests
{
    private const string ApiKey = "LOGBREW_API_KEY";
    private const string Timestamp = "2026-06-02T10:00:00Z";

    internal static int Run()
    {
        ReportCarriesEveryDropReasonOnce();
        RetryKeepsReportIdAndLaterDropsWaitForNewId();
        ReportWaitsForRequestWithRoom();
        return 3;
    }

    private static void ReportCarriesEveryDropReasonOnce()
    {
        var smallBytes = QueuedBytes(probe => probe.Log("evt_report_small", Timestamp, LogAttributes.Create("small", "info")));
        var crashBytes = QueuedBytes(probe => probe.Issue("evt_report_crash", Timestamp, IssueAttributes.Create("App crashed", "fatal")));
        var maxQueueBytes = smallBytes + Math.Max(smallBytes, crashBytes) + 10;
        var client = LogBrewClient.Create(ApiKey, "logbrew-dotnet", "0.1.0", maxQueueSize: 2, maxQueueBytes: maxQueueBytes);
        client.Log("evt_report_small", Timestamp, LogAttributes.Create("small", "info"));
        client.Log("evt_report_bytes", Timestamp, LogAttributes.Create(new string('b', maxQueueBytes * 2), "info"));
        client.Log("evt_report_kept", Timestamp, LogAttributes.Create("small", "info"));
        client.Log("evt_report_full", Timestamp, LogAttributes.Create("small", "info"));
        client.Log("evt_report_large", Timestamp, LogAttributes.Create(new string('x', 256 * 1024), "info"));
        client.Issue("evt_report_crash", Timestamp, IssueAttributes.Create("App crashed", "fatal"));
        AssertTrue(client.DroppedEvents() == 4, "expected four drops");

        var transport = RecordingTransport.AlwaysAccept();
        client.Flush(transport);
        var counts = ReportCounts(transport.SentBodies[0], out var reportId);
        AssertTrue(Regex.IsMatch(reportId, "^[A-Za-z0-9_-]{16,64}$"), "report ID does not match the batch schema");
        AssertTrue(counts.Count == 4, "expected one count per drop reason");
        foreach (var reason in new[] { "queue_bytes_overflow", "queue_overflow", "event_too_large", "evicted_for_fatal" })
        {
            AssertTrue(counts.TryGetValue(reason, out var count) && count == 1, "missing count for " + reason);
        }

        client.Log("evt_report_after", Timestamp, LogAttributes.Create("after", "info"));
        client.Flush(transport);
        AssertTrue(!transport.SentBodies[1].Contains("client_report", StringComparison.Ordinal), "acknowledged report was sent again");
    }

    private static void RetryKeepsReportIdAndLaterDropsWaitForNewId()
    {
        var client = LogBrewClient.Create(ApiKey, "logbrew-dotnet", "0.1.0", maxRetries: 0, maxQueueSize: 1);
        client.Log("evt_retry_1", Timestamp, LogAttributes.Create("first", "info"));
        client.Log("evt_retry_dropped_1", Timestamp, LogAttributes.Create("dropped", "info"));
        var failing = new RecordingTransport(new object[] { 503 });
        try
        {
            client.Flush(failing);
            throw new InvalidOperationException("expected the failed flush to throw");
        }
        catch (SdkException)
        {
        }

        client.Log("evt_retry_dropped_2", Timestamp, LogAttributes.Create("dropped while pending", "info"));
        var transport = RecordingTransport.AlwaysAccept();
        client.Flush(transport);
        AssertTrue(transport.SentBodies[0] == failing.SentBodies[0], "retry changed the request or its report ID");
        ReportCounts(transport.SentBodies[0], out var firstId);

        client.Log("evt_retry_2", Timestamp, LogAttributes.Create("second", "info"));
        client.Flush(transport);
        var counts = ReportCounts(transport.SentBodies[1], out var secondId);
        AssertTrue(secondId != firstId, "a later drop reused the acknowledged report ID");
        AssertTrue(counts.Count == 1 && counts["queue_overflow"] == 1, "the drop recorded during the retry was lost");
    }

    private static void ReportWaitsForRequestWithRoom()
    {
        var message = new string('m', 256 * 1024 - 20 - QueuedRequestBytes("m") + 1);
        AssertTrue(QueuedRequestBytes(message) == 256 * 1024 - 20, "probe did not size the request");
        var client = LogBrewClient.Create(ApiKey, "logbrew-dotnet", "0.1.0", maxQueueSize: 1, maxQueueBytes: 1024 * 1024);
        client.Log("evt_room_large", Timestamp, LogAttributes.Create(message, "info"));
        client.Log("evt_room_dropped", Timestamp, LogAttributes.Create("dropped", "info"));

        var transport = RecordingTransport.AlwaysAccept();
        client.Flush(transport);
        AssertTrue(!transport.SentBodies[0].Contains("client_report", StringComparison.Ordinal), "report pushed a request over its byte limit");
        client.Log("evt_room_small", Timestamp, LogAttributes.Create("small", "info"));
        client.Flush(transport);
        var counts = ReportCounts(transport.SentBodies[1], out _);
        AssertTrue(counts["queue_overflow"] == 1, "waiting report was not sent with the next request");
    }

    private static int QueuedBytes(Action<LogBrewClient> capture)
    {
        var probe = LogBrewClient.Create(ApiKey, "logbrew-dotnet", "0.1.0");
        capture(probe);
        using var preview = JsonDocument.Parse(probe.PreviewJson());
        var bytes = 0;
        foreach (var queued in preview.RootElement.GetProperty("events").EnumerateArray())
        {
            bytes += Encoding.UTF8.GetByteCount(queued.GetRawText());
        }

        return bytes;
    }

    private static int QueuedRequestBytes(string message)
    {
        var probe = LogBrewClient.Create(ApiKey, "logbrew-dotnet", "0.1.0", maxQueueBytes: 1024 * 1024);
        probe.Log("evt_room_large", Timestamp, LogAttributes.Create(message, "info"));
        return Encoding.UTF8.GetByteCount(probe.PreviewJson());
    }

    private static Dictionary<string, long> ReportCounts(string body, out string reportId)
    {
        using var document = JsonDocument.Parse(body);
        AssertTrue(document.RootElement.TryGetProperty("client_report", out var report), "request has no client report");
        reportId = report.GetProperty("report_id").GetString() ?? string.Empty;
        var counts = new Dictionary<string, long>(StringComparer.Ordinal);
        foreach (var pair in report.GetProperty("dropped_events").EnumerateObject())
        {
            counts[pair.Name] = pair.Value.GetInt64();
        }

        return counts;
    }

    private static void AssertTrue(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException(message);
        }
    }
}
