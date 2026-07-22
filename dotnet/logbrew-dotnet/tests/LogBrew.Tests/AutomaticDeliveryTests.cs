using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using LogBrew;

internal static class AutomaticDeliveryTests
{
    private const string ApiKey = "LOGBREW_API_KEY";
    private const string Timestamp = "2026-06-02T10:00:03Z";

    internal static int Run()
    {
        AutomaticThresholdAndIntervalDelivery();
        AutomaticIntervalDelivery();
        ExtremeIntervalClampsWithoutOverflow();
        ImmutableRetryRetainsLaterCapture();
        TerminalPauseRequiresExplicitRecovery();
        CaptureDoesNotWaitForTransport();
        ManualFlushRecomputesLiveWakeWithoutConsumingLaterCapture();
        ManualFlushUsesBoundedImmutablePrefixes();
        QueueBoundsAndDropCallbacksStaySafe();
        RetryExhaustionPausesWithoutLosingWork();
        ShutdownSerializesWithInflightDelivery();
        HealthIsStableJsonAndContentFree();
        MalformedTransportFailureDoesNotEscapeCapture();
        return 13;
    }

    private static AutomaticDeliveryOptions Options(
        int threshold = 2,
        int maxRetries = 2,
        TimeSpan? interval = null,
        TimeSpan? retryDelay = null)
    {
        return new AutomaticDeliveryOptions
        {
            FlushAtQueueSize = threshold,
            FlushInterval = interval ?? TimeSpan.FromMilliseconds(120),
            RetryBaseDelay = retryDelay ?? TimeSpan.FromMilliseconds(40),
            MaxRetryDelay = TimeSpan.FromMilliseconds(250),
            MaxQueueSize = 1000,
            MaxQueueBytes = 4 * 1024 * 1024,
            MaxRetries = maxRetries,
        };
    }

    private static LogBrewClient AutomaticClient(
        ITransport transport,
        AutomaticDeliveryOptions? options = null,
        Action<DroppedEvent>? onEventDropped = null)
    {
        return LogBrewClient.CreateAutomatic(
            ApiKey,
            "logbrew-dotnet-automatic-tests",
            "0.1.0",
            transport,
            options ?? Options(),
            onEventDropped);
    }

    private static void AutomaticThresholdAndIntervalDelivery()
    {
        var transport = new ControlledTransport(202, 202);
        var client = AutomaticClient(transport, Options(interval: TimeSpan.FromSeconds(10)));

        client.Log("evt_threshold_1", Timestamp, LogAttributes.Create("threshold one", "info"));
        AssertTrue(transport.Bodies.Length == 0, "sub-threshold event sent before threshold");
        client.Log("evt_threshold_2", Timestamp, LogAttributes.Create("threshold two", "info"));
        AssertTrue(transport.WaitForRequests(1, TimeSpan.FromSeconds(2)), "threshold delivery did not run");
        AssertTrue(transport.Bodies[0].Contains("evt_threshold_1", StringComparison.Ordinal), "missing first threshold event");
        AssertTrue(transport.Bodies[0].Contains("evt_threshold_2", StringComparison.Ordinal), "missing second threshold event");
        AssertTrue(client.PendingEvents() == 0, "automatic delivery did not drain queue");
        AssertTrue(client.Shutdown().StatusCode == 204, "empty automatic shutdown was not a no-op");
    }

    private static void AutomaticIntervalDelivery()
    {
        var transport = new ControlledTransport(202);
        var client = AutomaticClient(
            transport,
            Options(threshold: 100, interval: TimeSpan.FromMilliseconds(80)));
        client.Log("evt_interval_1", Timestamp, LogAttributes.Create("interval", "info"));
        AssertTrue(transport.WaitForRequests(1, TimeSpan.FromSeconds(2)), "interval delivery did not run");
        AssertTrue(transport.Bodies[0].Contains("evt_interval_1", StringComparison.Ordinal), "missing interval event");
        AssertTrue(client.Shutdown().StatusCode == 204, "interval client shutdown failed");
    }

    private static void ExtremeIntervalClampsWithoutOverflow()
    {
        var transport = new ControlledTransport(202);
        var client = AutomaticClient(
            transport,
            Options(threshold: 100, interval: TimeSpan.MaxValue));
        client.Log("evt_extreme_interval", Timestamp, LogAttributes.Create("extreme interval", "info"));
        AssertTrue(
            WaitUntil(() => client.DeliveryHealth().Activity == DeliveryActivityState.Scheduled, TimeSpan.FromSeconds(2)),
            "extreme interval did not remain scheduled");
        AssertTrue(transport.Bodies.Length == 0, "extreme interval sent before shutdown");
        AssertTrue(client.Shutdown().StatusCode == 202, "extreme interval shutdown did not flush");
        AssertTrue(transport.Bodies.Length == 1, "extreme interval shutdown request count changed");
    }

    private static void ImmutableRetryRetainsLaterCapture()
    {
        var transport = new ControlledTransport(
            new TransportResponse(503, 1, TimeSpan.FromMilliseconds(100)),
            202,
            202);
        var client = AutomaticClient(transport, Options(threshold: 1, retryDelay: TimeSpan.FromMilliseconds(20)));

        client.Log("evt_retry_frozen", Timestamp, LogAttributes.Create("frozen", "info"));
        AssertTrue(transport.WaitForRequests(1, TimeSpan.FromSeconds(2)), "initial retry request missing");
        client.Log("evt_retry_later", Timestamp, LogAttributes.Create("later", "info"));
        var retryHealth = client.DeliveryHealth();
        AssertTrue(retryHealth.Activity == DeliveryActivityState.Retrying, "later capture bypassed retry ownership");
        AssertTrue(retryHealth.RetrySource == DeliveryRetrySource.Server, "later capture replaced server retry guidance");
        AssertTrue(transport.WaitForRequests(3, TimeSpan.FromSeconds(3)), "retry and later delivery did not complete");

        AssertTrue(transport.Bodies[0] == transport.Bodies[1], "retry body changed");
        AssertTrue(!transport.Bodies[0].Contains("evt_retry_later", StringComparison.Ordinal), "later capture entered frozen retry");
        AssertTrue(transport.Bodies[2].Contains("evt_retry_later", StringComparison.Ordinal), "later capture was not retained");
        AssertTrue(transport.RequestTimes[1] - transport.RequestTimes[0] >= TimeSpan.FromMilliseconds(80), "server delay was not honored");
        AssertTrue(client.Shutdown().StatusCode == 204, "retry client shutdown failed");
    }

    private static void TerminalPauseRequiresExplicitRecovery()
    {
        var transport = new ControlledTransport(401, 202, 202);
        var client = AutomaticClient(transport, Options(threshold: 1));
        client.Log("evt_terminal_1", Timestamp, LogAttributes.Create("terminal", "info"));
        AssertTrue(WaitUntil(() => client.DeliveryHealth().Lifecycle == DeliveryLifecycleState.Paused, TimeSpan.FromSeconds(2)), "auth response did not pause delivery");
        AssertTrue(client.DeliveryHealth().PauseReason == DeliveryPauseReason.Authentication, "auth pause reason missing");

        client.Log("evt_terminal_2", Timestamp, LogAttributes.Create("queued while paused", "info"));
        AssertTrue(!transport.WaitForRequests(2, TimeSpan.FromMilliseconds(180)), "paused client sent without recovery");
        client.RecoverAutomaticDelivery();
        AssertTrue(transport.WaitForRequests(3, TimeSpan.FromSeconds(2)), "recovered client did not drain both prefixes");
        AssertTrue(transport.Bodies[0] == transport.Bodies[1], "terminal failed prefix changed after recovery");
        AssertTrue(transport.Bodies[2].Contains("evt_terminal_2", StringComparison.Ordinal), "paused later event was not retained");
        AssertTrue(client.Shutdown().StatusCode == 204, "terminal client shutdown failed");
    }

    private static void CaptureDoesNotWaitForTransport()
    {
        using var release = new ManualResetEventSlim(false);
        var transport = new ControlledTransport(new BlockedResponse(release, 202), 202);
        var client = AutomaticClient(transport, Options(threshold: 1));
        client.Log("evt_inflight_1", Timestamp, LogAttributes.Create("inflight", "info"));
        AssertTrue(transport.WaitForRequests(1, TimeSpan.FromSeconds(2)), "blocking request did not start");

        var capture = Task.Run(() => client.Log("evt_inflight_2", Timestamp, LogAttributes.Create("captured during I/O", "info")));
        AssertTrue(capture.Wait(TimeSpan.FromSeconds(1)), "capture waited for transport I/O");
        release.Set();
        AssertTrue(transport.WaitForRequests(2, TimeSpan.FromSeconds(2)), "later inflight capture was not delivered");
        AssertTrue(!transport.Bodies[0].Contains("evt_inflight_2", StringComparison.Ordinal), "later capture entered inflight prefix");
        AssertTrue(transport.Bodies[1].Contains("evt_inflight_2", StringComparison.Ordinal), "later inflight capture was lost");
        AssertTrue(client.Shutdown().StatusCode == 204, "inflight client shutdown failed");
    }

    private static void ManualFlushRecomputesLiveWakeWithoutConsumingLaterCapture()
    {
        using var release = new ManualResetEventSlim(false);
        var transport = new ControlledTransport(new BlockedResponse(release, 202), 202);
        var client = AutomaticClient(
            transport,
            Options(threshold: 2, interval: TimeSpan.FromSeconds(10)));
        client.Log("evt_manual_snapshot_1", Timestamp, LogAttributes.Create("manual snapshot", "info"));

        var flush = Task.Run(client.Flush);
        AssertTrue(transport.WaitForRequests(1, TimeSpan.FromSeconds(2)), "manual snapshot request did not start");
        client.Log("evt_manual_snapshot_2", Timestamp, LogAttributes.Create("captured during manual flush", "info"));
        release.Set();
        AssertTrue(flush.Wait(TimeSpan.FromSeconds(2)), "manual snapshot flush did not finish");
        AssertTrue(transport.Bodies.Length == 1, "stale threshold wake sent a later sub-threshold capture");
        AssertTrue(client.PendingEvents() == 1, "manual snapshot consumed a later capture");

        client.Log("evt_manual_snapshot_3", Timestamp, LogAttributes.Create("threshold completion", "info"));
        AssertTrue(transport.WaitForRequests(2, TimeSpan.FromSeconds(2)), "live threshold did not send retained captures");
        AssertTrue(transport.Bodies[1].Contains("evt_manual_snapshot_2", StringComparison.Ordinal), "later capture order was not retained");
        AssertTrue(transport.Bodies[1].Contains("evt_manual_snapshot_3", StringComparison.Ordinal), "threshold completion was not retained");
        AssertTrue(client.Shutdown().StatusCode == 204, "manual snapshot client shutdown failed");
    }

    private static void ManualFlushUsesBoundedImmutablePrefixes()
    {
        var transport = new ControlledTransport(202, 202, 202);
        var client = LogBrewClient.Create(ApiKey, "manual-batches", "0.1.0");
        for (var index = 0; index < 250; index++)
        {
            client.Log(EventId("evt_batch", index), Timestamp, LogAttributes.Create("bounded request", "info"));
        }

        var response = client.Flush(transport);
        AssertTrue(response.StatusCode == 202 && response.Attempts == 3, "manual flush did not aggregate bounded batches");
        AssertTrue(transport.Bodies.Length == 3, "manual flush request count was not bounded");
        foreach (var body in transport.Bodies)
        {
            AssertTrue(CountOccurrences(body, "\"type\": \"log\"") <= 100, "request exceeded event bound");
            AssertTrue(Encoding.UTF8.GetByteCount(body) <= 256 * 1024, "request exceeded byte bound");
        }

        AssertTrue(client.PendingEvents() == 0, "manual bounded flush left accepted events");
    }

    private static void QueueBoundsAndDropCallbacksStaySafe()
    {
        using var callbackEntered = new ManualResetEventSlim(false);
        using var callbackRelease = new ManualResetEventSlim(false);
        var callbackCount = 0;
        LogBrewClient? client = null;
        client = LogBrewClient.Create(
            ApiKey,
            "manual-bounds",
            "0.1.0",
            maxQueueSize: 1000,
            onEventDropped: _ =>
            {
                if (Interlocked.Increment(ref callbackCount) == 1)
                {
                    callbackEntered.Set();
                    callbackRelease.Wait(TimeSpan.FromSeconds(5));
                }
            });
        for (var index = 0; index < 1000; index++)
        {
            client.Log(EventId("evt_bound", index), Timestamp, LogAttributes.Create("bounded queue", "info"));
        }

        var overflow = Task.Run(() => client.Log("evt_bound_overflow", Timestamp, LogAttributes.Create("dropped", "info")));
        AssertTrue(callbackEntered.Wait(TimeSpan.FromSeconds(2)), "drop callback did not block for ownership proof");
        var concurrentState = Task.Run(() =>
        {
            AssertTrue(client.PendingEvents() == 1000, "concurrent queue inspection failed");
            client.Flush(RecordingTransport.AlwaysAccept());
            client.Log("evt_bound_after_flush", Timestamp, LogAttributes.Create("captured while callback blocked", "info"));
        });
        AssertTrue(concurrentState.Wait(TimeSpan.FromSeconds(2)), "drop callback retained state ownership");
        callbackRelease.Set();
        AssertTrue(overflow.Wait(TimeSpan.FromSeconds(2)), "overflow capture did not return after callback release");

        AssertTrue(client.PendingEvents() == 1, "capture during blocked callback was not retained");
        AssertTrue(client.DroppedEvents() == 1, "queue drop count changed");

        var byteDrops = new List<DroppedEvent>();
        var byteBoundClient = LogBrewClient.Create(
            ApiKey,
            "manual-byte-bounds",
            "0.1.0",
            maxQueueSize: 1000,
            onEventDropped: byteDrops.Add,
            maxQueueBytes: 1024);
        byteBoundClient.Log("evt_byte_kept", Timestamp, LogAttributes.Create(new string('a', 700), "info"));
        byteBoundClient.Log("evt_byte_dropped", Timestamp, LogAttributes.Create(new string('b', 700), "info"));
        AssertTrue(byteBoundClient.PendingEvents() == 1, "queue byte bound did not preserve first event");
        AssertTrue(byteBoundClient.DeliveryHealth().QueuedBytes <= 1024, "queue exceeded configured UTF-8 byte bound");
        AssertTrue(byteDrops.Count == 1 && byteDrops[0].Reason == "queue_bytes_overflow", "queue byte overflow reason changed");

        var oversizedDrops = new List<DroppedEvent>();
        var oversizedClient = LogBrewClient.Create(
            ApiKey,
            "manual-event-bounds",
            "0.1.0",
            maxQueueSize: 1000,
            onEventDropped: oversizedDrops.Add,
            maxQueueBytes: 1024 * 1024);
        oversizedClient.Log("evt_oversized", Timestamp, LogAttributes.Create(new string('x', 256 * 1024), "info"));
        AssertTrue(oversizedClient.PendingEvents() == 0, "oversized event entered queue");
        AssertTrue(oversizedDrops.Count == 1 && oversizedDrops[0].Reason == "event_too_large", "oversized event reason changed");

        ExpectSdkError(
            "validation_error",
            () => AutomaticClient(
                RecordingTransport.AlwaysAccept(),
                new AutomaticDeliveryOptions { MaxRetries = 11 }));
    }

    private static void RetryExhaustionPausesWithoutLosingWork()
    {
        var transport = new ControlledTransport(503, 503, 202);
        var client = AutomaticClient(transport, Options(threshold: 1, maxRetries: 1));
        client.Log("evt_exhausted", Timestamp, LogAttributes.Create("retry exhausted", "info"));
        AssertTrue(WaitUntil(() => client.DeliveryHealth().PauseReason == DeliveryPauseReason.RetryExhausted, TimeSpan.FromSeconds(2)), "retry exhaustion did not pause");
        AssertTrue(client.PendingEvents() == 1, "retry exhaustion lost failed prefix");
        AssertTrue(transport.Bodies.Length == 2 && transport.Bodies[0] == transport.Bodies[1], "retry exhaustion changed body");
        client.RecoverAutomaticDelivery();
        AssertTrue(transport.WaitForRequests(3, TimeSpan.FromSeconds(2)), "recovery after exhaustion did not send");
        AssertTrue(client.Shutdown().StatusCode == 204, "retry exhaustion client shutdown failed");
    }

    private static void ShutdownSerializesWithInflightDelivery()
    {
        using var release = new ManualResetEventSlim(false);
        var transport = new ControlledTransport(new BlockedResponse(release, 202));
        var client = AutomaticClient(transport, Options(threshold: 1));
        client.Log("evt_shutdown_inflight", Timestamp, LogAttributes.Create("shutdown inflight", "info"));
        AssertTrue(transport.WaitForRequests(1, TimeSpan.FromSeconds(2)), "shutdown request did not start");

        var shutdown = Task.Run(client.Shutdown);
        AssertTrue(WaitUntil(() => client.DeliveryHealth().Lifecycle == DeliveryLifecycleState.Closing, TimeSpan.FromSeconds(1)), "shutdown did not enter closing state");
        ExpectSdkError("shutdown_error", () => client.Log("evt_shutdown_late", Timestamp, LogAttributes.Create("late", "info")));
        release.Set();
        AssertTrue(shutdown.Wait(TimeSpan.FromSeconds(2)), "shutdown did not join worker");
        AssertTrue(client.DeliveryHealth().Lifecycle == DeliveryLifecycleState.Closed, "shutdown did not close health");
        AssertTrue(client.DeliveryHealth().Activity == DeliveryActivityState.Idle, "shutdown left delivery active");
    }

    private static void HealthIsStableJsonAndContentFree()
    {
        var transport = new ControlledTransport(202);
        var client = AutomaticClient(transport, Options(threshold: 1));
        client.Log("evt_private_health", Timestamp, LogAttributes.Create("private health message", "info"));
        AssertTrue(transport.WaitForRequests(1, TimeSpan.FromSeconds(2)), "health delivery missing");
        var health = JsonSerializer.Serialize(client.DeliveryHealth());
        foreach (var forbidden in new[] { ApiKey, "evt_private_health", "private health message", "http", "authorization", "/v1/events", "Exception" })
        {
            AssertTrue(!health.Contains(forbidden, StringComparison.OrdinalIgnoreCase), "health leaked " + forbidden);
        }

        AssertTrue(health.Contains("Lifecycle", StringComparison.Ordinal), "health lifecycle missing");
        AssertTrue(health.Contains("QueuedEvents", StringComparison.Ordinal), "health queue count missing");
        AssertTrue(health.Contains("AcceptedEvents", StringComparison.Ordinal), "health accepted count missing");
        AssertTrue(client.Shutdown().StatusCode == 204, "health client shutdown failed");
    }

    private static void MalformedTransportFailureDoesNotEscapeCapture()
    {
        var transport = new ControlledTransport(new InvalidOperationException("private transport failure"));
        var client = AutomaticClient(transport, Options(threshold: 1));
        client.Log("evt_malformed_transport", Timestamp, LogAttributes.Create("must not throw", "info"));
        AssertTrue(WaitUntil(() => client.DeliveryHealth().Lifecycle == DeliveryLifecycleState.Paused, TimeSpan.FromSeconds(2)), "malformed transport did not pause");
        AssertTrue(client.DeliveryHealth().PauseReason == DeliveryPauseReason.NonRetryable, "malformed transport pause reason changed");
        AssertTrue(client.PendingEvents() == 1, "malformed transport lost event");
    }

    private static string EventId(string prefix, int index)
    {
        return prefix + "_" + index.ToString("D4", CultureInfo.InvariantCulture);
    }

    private static bool WaitUntil(Func<bool> predicate, TimeSpan timeout)
    {
        return SpinWait.SpinUntil(predicate, timeout);
    }

    private static void ExpectSdkError(string code, Action callback)
    {
        try
        {
            callback();
        }
        catch (SdkException error) when (error.Code == code)
        {
            return;
        }

        throw new InvalidOperationException("expected SdkException " + code);
    }

    private static int CountOccurrences(string text, string value)
    {
        var count = 0;
        var index = 0;
        while ((index = text.IndexOf(value, index, StringComparison.Ordinal)) >= 0)
        {
            count++;
            index += value.Length;
        }

        return count;
    }

    private static void AssertTrue(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException(message);
        }
    }

    private sealed class BlockedResponse
    {
        internal BlockedResponse(ManualResetEventSlim release, int statusCode)
        {
            Release = release;
            StatusCode = statusCode;
        }

        internal ManualResetEventSlim Release { get; }

        internal int StatusCode { get; }
    }

    private sealed class ControlledTransport : ITransport
    {
        private readonly object gate = new object();
        private readonly Queue<object> responses;
        private readonly List<string> bodies = new List<string>();
        private readonly List<TimeSpan> requestTimes = new List<TimeSpan>();
        private readonly Stopwatch stopwatch = Stopwatch.StartNew();

        internal ControlledTransport(params object[] responses)
        {
            this.responses = new Queue<object>(responses.Length == 0 ? new object[] { 202 } : responses);
        }

        internal string[] Bodies
        {
            get
            {
                lock (gate)
                {
                    return bodies.ToArray();
                }
            }
        }

        internal TimeSpan[] RequestTimes
        {
            get
            {
                lock (gate)
                {
                    return requestTimes.ToArray();
                }
            }
        }

        public TransportResponse Send(string apiKey, string body)
        {
            object response;
            lock (gate)
            {
                bodies.Add(body);
                requestTimes.Add(stopwatch.Elapsed);
                response = responses.Count == 0 ? 202 : responses.Dequeue();
                Monitor.PulseAll(gate);
            }

            if (response is BlockedResponse blocked)
            {
                if (!blocked.Release.Wait(TimeSpan.FromSeconds(5)))
                {
                    throw new InvalidOperationException("blocked transport timed out");
                }

                return new TransportResponse(blocked.StatusCode, 1);
            }

            if (response is Exception error)
            {
                throw error;
            }

            if (response is TransportResponse transportResponse)
            {
                return transportResponse;
            }

            return new TransportResponse((int)response, 1);
        }

        internal bool WaitForRequests(int count, TimeSpan timeout)
        {
            var started = stopwatch.Elapsed;
            lock (gate)
            {
                while (bodies.Count < count)
                {
                    var remaining = timeout - (stopwatch.Elapsed - started);
                    if (remaining <= TimeSpan.Zero || !Monitor.Wait(gate, remaining))
                    {
                        return bodies.Count >= count;
                    }
                }

                return true;
            }
        }
    }
}
