#nullable enable

using System.Collections;
using System.Collections.Generic;
using LogBrew.Unity;

public static class CoroutineTracker
{
    public static void Main()
    {
        var client = LogBrewUnity.CreateClient("LOGBREW_API_KEY", "logbrew-unity-coroutine-tracker");
        var trace = LogBrewTraceContext.ContinueOrCreate("00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01");
        var clockMs = 1000.0;
        var eventIds = new Queue<string>();
        eventIds.Enqueue("evt_unity_coroutine_tracker_001");
        var timestamps = new Queue<string>();
        timestamps.Enqueue("2026-06-02T10:00:50Z");
        var activeTraceparent = string.Empty;
        var tracker = new UnityCoroutineTracker(
            client,
            idFactory: () => eventIds.Dequeue(),
            timestampFactory: () => timestamps.Dequeue(),
            realtimeMilliseconds: () => clockMs,
            context: UnityContext.Create()
                .WithPlatform("ios")
                .WithSceneName("Checkout")
                .WithSessionId("session_123"));

        UnityTrackedCoroutine coroutine;
        using (LogBrewTrace.Activate(trace))
        {
            activeTraceparent = LogBrewTrace.OutgoingHeaders()["traceparent"];
            coroutine = tracker.Trace(
                "checkout.upload",
                UploadCoroutine(client),
                context: UnityContext.Create()
                    .WithFrame(128)
                    .WithMetadata("traceparent", "spoofed_traceparent"));
        }

        using (coroutine)
        {
            coroutine.MoveNext();
            clockMs = 1345.25;
            coroutine.MoveNext();
        }

        System.Console.WriteLine(client.PreviewJson());
        System.Console.Error.WriteLine("{\"activeTraceparent\":\"" + activeTraceparent + "\"}");
    }

    private static IEnumerator UploadCoroutine(LogBrewClient client)
    {
        client.Log(
            "evt_unity_coroutine_log_001",
            "2026-06-02T10:00:48Z",
            LogAttributes.Create("upload coroutine started", "info").WithLogger("unity-coroutine"));
        yield return "frame_1";
        client.Action(
            "evt_unity_coroutine_action_001",
            "2026-06-02T10:00:49Z",
            ActionAttributes.Create("unity.coroutine.resume", "success").WithMetadata(new Dictionary<string, object?>
            {
                ["source"] = "unity.coroutine",
                ["phase"] = "resume",
                ["sceneName"] = "Checkout",
                ["traceparent"] = "spoofed_traceparent"
            }));
    }
}
