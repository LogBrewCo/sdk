#nullable enable

using System.Collections.Generic;
using LogBrew.Unity;

public static class RequestTracker
{
    public static void Main()
    {
        var client = LogBrewUnity.CreateClient("LOGBREW_API_KEY", "logbrew-unity-request-tracker");
        var trace = LogBrewTraceContext.ContinueOrCreate("00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01");
        var clockMs = 1000.0;
        var eventIds = new Queue<string>();
        eventIds.Enqueue("evt_unity_request_tracker_001");
        var timestamps = new Queue<string>();
        timestamps.Enqueue("2026-06-02T10:00:40Z");
        var requestHeaders = new Dictionary<string, string>();
        var activeTraceparent = string.Empty;
        var tracker = new UnityRequestTracker(
            client,
            idFactory: () => eventIds.Dequeue(),
            timestampFactory: () => timestamps.Dequeue(),
            realtimeMilliseconds: () => clockMs,
            context: UnityContext.Create()
                .WithPlatform("ios")
                .WithSceneName("Checkout")
                .WithSessionId("session_123"));

        using (LogBrewTrace.Activate(trace))
        {
            activeTraceparent = LogBrewTrace.OutgoingHeaders()["traceparent"];
            var request = tracker.Start(
                method: "POST",
                routeTemplate: "https://api.example.test/api/checkout?cache=1#poll",
                setRequestHeader: (name, value) => requestHeaders[name] = value);
            clockMs = 1184.5;
            tracker.Capture(
                request,
                statusCode: 503,
                errorType: "UnityWebRequestError",
                context: UnityContext.Create()
                    .WithFrame(128)
                    .WithMetadata("traceId", "spoofed_trace")
                    .WithMetadata("traceparent", "spoofed_traceparent"));
        }

        System.Console.WriteLine(client.PreviewJson());
        System.Console.Error.WriteLine("{\"activeTraceparent\":\"" + activeTraceparent + "\",\"requestTraceparent\":\"" + requestHeaders["traceparent"] + "\"}");
    }
}
