using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Text.RegularExpressions;
using LogBrew;

internal static partial class DurableDeliveryContractTests
{
    private static readonly Regex ReportIdPattern = new Regex("^[A-Za-z0-9_-]{16,64}$", RegexOptions.CultureInvariant);

    private static string ChildDirectory(string parentDirectory)
    {
        return System.IO.Path.Combine(parentDirectory, ".logbrew-delivery-v1");
    }

    private static JsonElement? SentReport(string body)
    {
        using var document = JsonDocument.Parse(body);
        return document.RootElement.TryGetProperty("client_report", out var report) ? report.Clone() : null;
    }

    private static Dictionary<string, int> ReportedCounts(JsonElement report)
    {
        return report.GetProperty("dropped_events").EnumerateObject().ToDictionary(pair => pair.Name, pair => pair.Value.GetInt32());
    }

    private static void LogSmall(LogBrewClient client, string id)
    {
        client.Log(id, "2026-06-02T10:00:03Z", LogAttributes.Create("queued", "info"));
    }

    private static void LogTooLarge(LogBrewClient client, string id)
    {
        client.Log(id, "2026-06-02T10:00:02Z", LogAttributes.Create(new string('x', 256 * 1024), "info"));
    }

    private static void DropCountsSurviveARestartInAnotherProcess()
    {
        using var root = new TemporaryDirectory();
        RunDurableChild("--durable-child-drops", root.Path);
        var transport = new RecordingTransport(new object[] { 202, 202 });
        var client = CreateDurableClient(root.Path, transport: transport);

        LogSmall(client, "evt_drop_after_restart");
        AssertTrue(client.Flush().StatusCode == 202, "restart flush failed");
        var report = SentReport(transport.SentBodies[0]);
        AssertTrue(report != null && ReportIdPattern.IsMatch(report.Value.GetProperty("report_id").GetString()!), "restart lost the drop counts");
        AssertTrue(ReportedCounts(report!.Value).SequenceEqual(new Dictionary<string, int> { ["event_too_large"] = 1 }), "restart changed the drop counts");
        LogSmall(client, "evt_drop_after_report");
        AssertTrue(client.Flush().StatusCode == 202, "second flush failed");
        AssertTrue(SentReport(transport.SentBodies[1]) == null, "accepted drop counts were sent again");
        AssertTrue(client.Shutdown().StatusCode == 204, "drop count restart shutdown failed");
        AssertTrue(!File.Exists(System.IO.Path.Combine(ChildDirectory(root.Path), "client-report.lbd")), "a drained store kept its saved drop counts");
    }

    private static void ASentReportKeepsItsIdAfterARestart()
    {
        using var root = new TemporaryDirectory();
        RunDurableChild("--durable-child-drops-frozen", root.Path);
        var expected = File.ReadAllText(System.IO.Path.Combine(root.Path, "expected-body.txt"));
        var transport = new RecordingTransport(new object[] { 202, 202 });
        var client = CreateDurableClient(root.Path, transport: transport);

        LogTooLarge(client, "evt_drop_after_exit");
        AssertTrue(client.Flush().StatusCode == 202, "frozen retry flush failed");
        AssertTrue(transport.SentBodies[0] == expected, "restart rebuilt the frozen request");
        var sentBefore = SentReport(expected);
        AssertTrue(sentBefore != null && ReportedCounts(sentBefore.Value)["event_too_large"] == 1, "frozen request lost its drop counts");
        LogSmall(client, "evt_drop_later");
        AssertTrue(client.Flush().StatusCode == 202, "later flush failed");
        var later = SentReport(transport.SentBodies[1]);
        AssertTrue(later != null && later.Value.GetProperty("report_id").GetString() != sentBefore!.Value.GetProperty("report_id").GetString(), "a drop after the first request reused the sent report ID");
        AssertTrue(ReportedCounts(later!.Value)["event_too_large"] == 1, "a drop after the first request was not reported once");
        AssertTrue(client.Shutdown().StatusCode == 204, "frozen report restart shutdown failed");
    }

    private static void ADropBurstSavesOncePerSecondAndShutdownSavesTheRest()
    {
        using var root = new TemporaryDirectory();
        var client = CreateDurableClient(root.Path);
        var saves = 0;
        SetStoreCheckpoint(name =>
        {
            if (name == "client_report_persisted")
            {
                saves++;
            }
        });
        try
        {
            for (var index = 0; index < 5; index++)
            {
                LogTooLarge(client, "evt_drop_burst_" + index);
            }

            AssertTrue(saves == 1, "a burst of one reason saved " + saves + " times before shutdown");
            AssertTrue(client.Shutdown().StatusCode == 204, "burst shutdown failed");
            AssertTrue(saves == 2, "shutdown did not save the rest of the burst");
        }
        finally
        {
            SetStoreCheckpoint(null);
        }

        var transport = new RecordingTransport(new object[] { 202 });
        var restarted = CreateDurableClient(root.Path, transport: transport);
        LogSmall(restarted, "evt_drop_after_burst");
        AssertTrue(restarted.Flush().StatusCode == 202, "burst restart flush failed");
        var report = SentReport(transport.SentBodies[0]);
        AssertTrue(report != null && ReportedCounts(report.Value)["event_too_large"] == 5, "restart did not recover the burst counts");
        AssertTrue(restarted.Shutdown().StatusCode == 204, "burst restart shutdown failed");
    }

    private static void UnreadableSavedDropCountsAreIgnored()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        using var root = new TemporaryDirectory();
        RunDurableChild("--durable-child-write", root.Path);
        var junk = System.IO.Path.Combine(ChildDirectory(root.Path), "client-report.lbd");
        File.WriteAllBytes(junk, new byte[] { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 });
        File.SetUnixFileMode(junk, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        var transport = new RecordingTransport(new object[] { 202 });
        var client = CreateDurableClient(root.Path, transport: transport);

        AssertTrue(client.PendingEvents() == 3, "unreadable drop counts blocked recovery of queued events");
        AssertTrue(client.Flush().StatusCode == 202, "flush after unreadable drop counts failed");
        AssertTrue(SentReport(transport.SentBodies[0]) == null, "unreadable drop counts were sent");
        AssertTrue(client.Shutdown().StatusCode == 204, "unreadable drop counts shutdown failed");
    }

    private static void InvalidSavedDropCountsAreDropped()
    {
        var codec = typeof(LogBrewClient).Assembly.GetType("LogBrew.DurableRecordCodec", throwOnError: true)!;
        var serialize = codec.GetMethod("SerializeClientReport", BindingFlags.Static | BindingFlags.NonPublic)!;
        var deserialize = codec.GetMethod("DeserializeClientReport", BindingFlags.Static | BindingFlags.NonPublic)!;
        var saved = new Dictionary<string, int>
        {
            ["Not-A-Reason"] = 1,
            ["event_too_large"] = 0,
            ["queue_bytes_overflow"] = 1_000_000_001,
            ["evicted_for_fatal"] = 2,
        };
        var bytes = (byte[])serialize.Invoke(null, new object[] { saved })!;
        var loaded = (Dictionary<string, int>)deserialize.Invoke(null, new object[] { bytes })!;
        AssertTrue(loaded.Count == 1 && loaded["evicted_for_fatal"] == 2, "invalid saved drop counts were kept");

        var many = Enumerable.Range(0, 20).ToDictionary(index => "reason_" + (char)('a' + index), _ => 1);
        var limited = (Dictionary<string, int>)deserialize.Invoke(null, new object[] { serialize.Invoke(null, new object[] { many })! })!;
        AssertTrue(limited.Count == 16, "saved drop counts exceeded 16 reasons");
        var garbage = (Dictionary<string, int>)deserialize.Invoke(null, new object[] { new byte[] { 255, 255, 255, 127, 1 } })!;
        AssertTrue(garbage.Count == 0, "garbage saved drop counts were kept");
    }

    private static void AFailedDropCountSaveNeverFailsCapture()
    {
        using var root = new TemporaryDirectory();
        var client = CreateDurableClient(root.Path);
        SetStoreCheckpoint(name =>
        {
            if (name == "client_report_persisted")
            {
                throw new IOException("simulated drop count save failure");
            }
        });
        try
        {
            LogTooLarge(client, "evt_drop_save_failure");
        }
        finally
        {
            SetStoreCheckpoint(null);
        }

        AssertTrue(client.DroppedEvents() == 1, "a failed save changed the drop count");
        LogSmall(client, "evt_drop_after_failed_save");
        AssertTrue(client.PendingEvents() == 1, "capture failed after a failed drop count save");
        AssertTrue(client.Shutdown().StatusCode == 202, "shutdown failed after a failed drop count save");
    }
}
