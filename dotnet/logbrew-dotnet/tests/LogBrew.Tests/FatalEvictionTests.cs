using System;
using System.Collections.Generic;
using System.Text;
using System.Text.Json;
using LogBrew;

internal static class FatalEvictionTests
{
    internal static int Run()
    {
        var tests = 0;
        CrashReportEvictsOldestQueuedEvent();
        tests++;
        CrashReportEvictsByQueueBytes();
        tests++;
        CrashReportKeepsFrozenBatchAndOtherCrashReports();
        tests++;
        CrashReportKeepsLastEventOfPendingFlush();
        tests++;
        return tests;
    }

    private static void CrashReportEvictsOldestQueuedEvent()
    {
        var drops = new List<DroppedEvent>();
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "logbrew-dotnet", "0.1.0", maxQueueSize: 3, onEventDropped: drops.Add);
        client.Log("evt_evict_log_1", "2026-06-02T10:00:00Z", LogAttributes.Create("first", "info"));
        client.Log("evt_evict_log_2", "2026-06-02T10:00:01Z", LogAttributes.Create("second", "info"));
        client.Log("evt_evict_log_3", "2026-06-02T10:00:02Z", LogAttributes.Create("third", "info"));
        client.Issue("evt_evict_crash", "2026-06-02T10:00:03Z", IssueAttributes.Create("App crashed", "fatal"));

        var preview = client.PreviewJson();
        AssertTrue(!preview.Contains("evt_evict_log_1", StringComparison.Ordinal), "expected the oldest event to be evicted");
        AssertTrue(preview.Contains("evt_evict_crash", StringComparison.Ordinal), "expected the crash report to be queued");
        AssertTrue(client.PendingEvents() == 3, "expected the queue to stay at its limit");
        AssertTrue(drops.Count == 1, "expected one eviction notice");
        AssertTrue(drops[0].EventId == "evt_evict_log_1", "expected the notice to name the evicted event");
        AssertTrue(drops[0].Reason == "evicted_for_fatal", "expected the eviction reason");
        AssertTrue(client.DroppedEvents() == 1, "expected eviction to count as a drop");

        client.Log("evt_evict_log_4", "2026-06-02T10:00:04Z", LogAttributes.Create("fourth", "error"));
        AssertTrue(drops.Count == 2 && drops[1].Reason == "queue_overflow", "expected other events to be dropped at a full queue");
    }

    private static void CrashReportEvictsByQueueBytes()
    {
        var drops = new List<DroppedEvent>();
        var probe = LogBrewClient.Create("LOGBREW_API_KEY", "logbrew-dotnet", "0.1.0");
        probe.Log("evt_bytes_log_1", "2026-06-02T10:01:00Z", LogAttributes.Create(new string('a', 150), "info"));
        probe.Log("evt_bytes_log_2", "2026-06-02T10:01:01Z", LogAttributes.Create(new string('b', 150), "info"));
        var maxQueueBytes = 10;
        using (var preview = JsonDocument.Parse(probe.PreviewJson()))
        {
            foreach (var queued in preview.RootElement.GetProperty("events").EnumerateArray())
            {
                maxQueueBytes += Encoding.UTF8.GetByteCount(queued.GetRawText());
            }
        }

        var client = LogBrewClient.Create(
            "LOGBREW_API_KEY", "logbrew-dotnet", "0.1.0", maxQueueSize: 10, onEventDropped: drops.Add, maxQueueBytes: maxQueueBytes);
        client.Log("evt_bytes_log_1", "2026-06-02T10:01:00Z", LogAttributes.Create(new string('a', 150), "info"));
        client.Log("evt_bytes_log_2", "2026-06-02T10:01:01Z", LogAttributes.Create(new string('b', 150), "info"));
        client.Issue("evt_bytes_crash", "2026-06-02T10:01:02Z", IssueAttributes.Create(new string('x', 150), "critical"));

        var queuedPreview = client.PreviewJson();
        AssertTrue(!queuedPreview.Contains("evt_bytes_log_1", StringComparison.Ordinal), "expected byte pressure to evict the oldest event");
        AssertTrue(queuedPreview.Contains("evt_bytes_log_2", StringComparison.Ordinal), "expected eviction to stop once the crash report fits");
        AssertTrue(queuedPreview.Contains("evt_bytes_crash", StringComparison.Ordinal), "expected the crash report to be queued");
        AssertTrue(client.PendingEvents() == 2, "expected one event to make room for the crash report");
        AssertTrue(drops.Count == 1 && drops[0].Reason == "evicted_for_fatal", "expected one eviction notice");
    }

    private static void CrashReportKeepsFrozenBatchAndOtherCrashReports()
    {
        var drops = new List<DroppedEvent>();
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "logbrew-dotnet", "0.1.0", maxRetries: 0, maxQueueSize: 3, onEventDropped: drops.Add);
        client.Log("evt_frozen_log_1", "2026-06-02T10:02:00Z", LogAttributes.Create("first", "info"));
        client.Log("evt_frozen_log_2", "2026-06-02T10:02:01Z", LogAttributes.Create("second", "info"));
        var failing = new RecordingTransport(new object[] { 400 });
        try
        {
            client.Flush(failing);
        }
        catch (SdkException)
        {
        }

        client.Issue("evt_frozen_crash_1", "2026-06-02T10:02:02Z", IssueAttributes.Create("First crash", "fatal"));
        client.Issue("evt_frozen_crash_2", "2026-06-02T10:02:03Z", IssueAttributes.Create("Second crash", "fatal"));

        AssertTrue(drops.Count == 1, "expected only the crash report without room to be dropped");
        AssertTrue(drops[0].EventId == "evt_frozen_crash_2", "expected the new crash report to be dropped");
        AssertTrue(drops[0].Reason == "queue_overflow", "expected the overflow reason");
        var transport = RecordingTransport.AlwaysAccept();
        client.Flush(transport);
        AssertTrue(transport.SentBodies[0] == failing.SentBodies[0], "expected the failed batch to be retried unchanged");
    }

    private static void CrashReportKeepsLastEventOfPendingFlush()
    {
        var drops = new List<DroppedEvent>();
        LogBrewClient? client = null;
        var transport = new CallbackTransport(() =>
            client!.Issue("evt_pending_crash", "2026-06-02T10:03:59Z", IssueAttributes.Create("Crash during flush", "fatal")));
        client = LogBrewClient.Create("LOGBREW_API_KEY", "logbrew-dotnet", "0.1.0", maxQueueSize: 101, onEventDropped: drops.Add);
        for (var index = 0; index < 101; index++)
        {
            client.Log("evt_pending_log_" + index, "2026-06-02T10:03:00Z", LogAttributes.Create("pending", "info"));
        }

        client.Flush(transport);

        AssertTrue(drops.Count == 1 && drops[0].EventId == "evt_pending_crash", "expected the crash report to be dropped");
        AssertTrue(transport.SentBodies.Count == 2, "expected the flush to send both batches");
        AssertTrue(transport.SentBodies[1].Contains("evt_pending_log_100", StringComparison.Ordinal), "expected the last flushed event to be sent");
        AssertTrue(client.PendingEvents() == 0, "expected the flush to deliver every event it covered");
    }

    private static void AssertTrue(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException(message);
        }
    }

    private sealed class CallbackTransport : ITransport
    {
        private readonly Action onFirstSend;

        internal CallbackTransport(Action onFirstSend)
        {
            this.onFirstSend = onFirstSend;
        }

        internal List<string> SentBodies { get; } = new List<string>();

        public TransportResponse Send(string apiKey, string body)
        {
            SentBodies.Add(body);
            if (SentBodies.Count == 1)
            {
                onFirstSend();
            }

            return new TransportResponse(202, 1);
        }
    }
}
