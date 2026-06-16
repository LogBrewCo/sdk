#nullable enable

using LogBrew.Unity;

public static class LifecycleSpans
{
    public static void Main()
    {
        var client = LogBrewUnity.CreateClient("LOGBREW_API_KEY", "logbrew-unity-lifecycle");
        var trace = LogBrewTraceContext.ContinueOrCreate("00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01");
        using (LogBrewTrace.Activate(trace))
        {
            LogBrewUnity.CaptureLifecycleSpan(
                client,
                "evt_unity_lifecycle_active_paused_001",
                "2026-06-02T10:00:30Z",
                "active",
                "paused",
                1532.25,
                UnityContext.Create()
                    .WithPlatform("ios")
                    .WithSceneName("Checkout")
                    .WithSessionId("session_123")
                    .WithMetadata("traceId", "spoofed_trace"));
            LogBrewUnity.CaptureLifecycleSpan(
                client,
                "evt_unity_lifecycle_paused_active_001",
                "2026-06-02T10:00:31Z",
                "paused",
                "active",
                422.5,
                UnityContext.Create()
                    .WithPlatform("ios")
                    .WithSceneName("Checkout")
                    .WithSessionId("session_123")
                    .WithFrame(128));
        }

        System.Console.WriteLine(client.PreviewJson());
    }
}
