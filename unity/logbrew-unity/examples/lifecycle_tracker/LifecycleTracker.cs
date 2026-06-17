#nullable enable

using System.Collections.Generic;
using LogBrew.Unity;

public static class LifecycleTracker
{
    public static void Main()
    {
        var client = LogBrewUnity.CreateClient("LOGBREW_API_KEY", "logbrew-unity-lifecycle-tracker");
        var trace = LogBrewTraceContext.ContinueOrCreate("00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01");
        var clockMs = 1000.0;
        var eventIds = new Queue<string>();
        eventIds.Enqueue("evt_unity_lifecycle_active_paused_001");
        eventIds.Enqueue("evt_unity_lifecycle_paused_active_001");
        var timestamps = new Queue<string>();
        timestamps.Enqueue("2026-06-02T10:00:30Z");
        timestamps.Enqueue("2026-06-02T10:00:31Z");
        var tracker = new UnityLifecycleTracker(
            client,
            idFactory: () => eventIds.Dequeue(),
            timestampFactory: () => timestamps.Dequeue(),
            realtimeMilliseconds: () => clockMs,
            initialState: "active",
            context: UnityContext.Create()
                .WithPlatform("ios")
                .WithSceneName("Checkout")
                .WithSessionId("session_123"));

        using (LogBrewTrace.Activate(trace))
        {
            clockMs = 2532.25;
            tracker.CapturePause(true, UnityContext.Create().WithMetadata("traceId", "spoofed_trace"));
            tracker.CaptureFocus(false);
            clockMs = 2954.75;
            tracker.CapturePause(false, UnityContext.Create().WithFrame(128));
        }

        System.Console.WriteLine(client.PreviewJson());
    }
}
