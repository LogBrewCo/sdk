#nullable enable

using System;
using System.Collections;
using System.Collections.Generic;
using LogBrew.Unity;

public static class TraceCorrelation
{
    public static void Main()
    {
        var client = LogBrewUnity.CreateClient("LOGBREW_API_KEY", "logbrew-unity-trace");
        var trace = LogBrewTraceContext.ContinueOrCreate("00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01");
        string outgoingTraceparent;
        string requestTraceparent;
        UnityTraceCoroutine tracedCoroutine;

        using (LogBrewTrace.Activate(trace))
        {
            client.Issue(
                "evt_unity_trace_issue_001",
                "2026-06-02T10:00:20Z",
                IssueAttributes.Create("Checkout timeout", "error").WithMessage("request failed after retry budget").WithMetadata(new Dictionary<string, object?>
                {
                    ["routeTemplate"] = "/checkout/{cart_id}",
                    ["traceId"] = "spoofed_trace"
                }));
            client.Log(
                "evt_unity_trace_log_001",
                "2026-06-02T10:00:21Z",
                LogAttributes.Create("checkout handler failed", "error").WithLogger("CheckoutController").WithMetadata(new Dictionary<string, object?>
                {
                    ["sceneName"] = "Checkout"
                }));
            client.Action(
                "evt_unity_trace_action_001",
                "2026-06-02T10:00:22Z",
                ActionAttributes.Create("checkout.submit", "failure").WithMetadata(new Dictionary<string, object?>
                {
                    ["spanId"] = "spoofed_span"
                }));
            client.Span(
                "evt_unity_trace_span_001",
                "2026-06-02T10:00:23Z",
                LogBrewTrace.SpanAttributes(
                    "POST /checkout/{cart_id}",
                    "error",
                    37.5,
                    new Dictionary<string, object?> { ["routeTemplate"] = "/checkout/{cart_id}" }));
            LogBrewUnity.CaptureSceneLoaded(
                client,
                "evt_unity_trace_scene_001",
                "2026-06-02T10:00:24Z",
                "Checkout",
                7,
                UnityContext.Create().WithPlatform("ios").WithSessionId("session_123").WithMetadata("parentSpanId", "spoofed_parent"));
            LogBrewUnity.CaptureLogMessage(
                client,
                "evt_unity_trace_helper_log_001",
                "2026-06-02T10:00:25Z",
                "Unity warning during checkout",
                "Warning",
                UnityContext.Create().WithSceneName("Checkout"));
            LogBrewUnity.CaptureException(
                client,
                "evt_unity_trace_exception_001",
                "2026-06-02T10:00:26Z",
                "NullReferenceException",
                "stack trace",
                UnityContext.Create().WithGameObjectName("CheckoutButton"));
            var requestSpan = LogBrewUnity.StartRequestSpan(
                "get",
                "https://api.example.test/api/checkout/status?cache=1#poll");
            requestTraceparent = requestSpan.Headers["traceparent"];
            LogBrewUnity.CaptureRequestSpan(
                client,
                "evt_unity_trace_request_001",
                "2026-06-02T10:00:27Z",
                requestSpan,
                503,
                184.5,
                "UnityWebRequestError",
                UnityContext.Create().WithSceneName("Checkout").WithMetadata("traceparent", "spoofed_traceparent"));
            outgoingTraceparent = LogBrewTrace.OutgoingHeaders()["traceparent"];
            tracedCoroutine = LogBrewUnity.TraceCoroutine(CorrelatedCoroutine(client));
        }

        using (tracedCoroutine)
        {
            tracedCoroutine.MoveNext();
            tracedCoroutine.MoveNext();
        }

        Console.WriteLine(client.PreviewJson());
        Console.Error.WriteLine("{\"traceparent\":\"" + outgoingTraceparent + "\",\"requestTraceparent\":\"" + requestTraceparent + "\"}");
    }

    private static IEnumerator CorrelatedCoroutine(LogBrewClient client)
    {
        yield return "frame_1";
        client.Action(
            "evt_unity_trace_coroutine_001",
            "2026-06-02T10:00:28Z",
            ActionAttributes.Create("unity.coroutine.resume", "success").WithMetadata(new Dictionary<string, object?>
            {
                ["source"] = "unity.coroutine",
                ["phase"] = "resume",
                ["sceneName"] = "Checkout",
                ["traceparent"] = "spoofed_traceparent"
            }));
    }
}
