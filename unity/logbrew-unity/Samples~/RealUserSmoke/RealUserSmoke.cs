#nullable enable

using System;
using System.Collections.Generic;
using LogBrew.Unity;

public static class RealUserSmoke
{
    public static void Main()
    {
        var client = LogBrewUnity.CreateClient("LOGBREW_API_KEY", "logbrew-unity");
        ReadmeExample.EnqueueCanonicalEvents(client);
        Console.WriteLine(client.PreviewJson());
        var response = client.Flush(new RecordingTransport(new object[] { TransportException.Network("temporary outage"), 202 }));

        var helperClient = LogBrewUnity.CreateClient("LOGBREW_API_KEY", "logbrew-unity-helper");
        var context = UnityContext.Create()
            .WithPlatform("ios")
            .WithSceneName("MainMenu")
            .WithGameObjectName("Player")
            .WithSessionId("session_001")
            .WithFrame(42);
        LogBrewUnity.CaptureSceneLoaded(helperClient, "evt_scene_loaded_001", "2026-06-02T10:00:06Z", "MainMenu", 1, context);
        LogBrewUnity.CaptureLogMessage(helperClient, "evt_unity_log_001", "2026-06-02T10:00:07Z", "button clicked", "Log", context);
        LogBrewUnity.CaptureException(helperClient, "evt_unity_exception_001", "2026-06-02T10:00:08Z", "NullReferenceException", "stack trace", context);
        var helperPreview = helperClient.PreviewJson();
        if (!helperPreview.Contains("\"sceneName\": \"MainMenu\"") || !helperPreview.Contains("\"unityLogType\": \"Log\""))
        {
            throw new InvalidOperationException("unity helper metadata missing");
        }

        var richContext = TelemetryContext.Create()
            .WithResource(TelemetryResource.Create()
                .WithDeployment("production", "2.3.0")
                .WithFramework("unity", "6000.1")
                .WithApplication("Checkout Game", "2.3.0", "204")
                .Build())
            .WithSession("session_001")
            .WithSubject("opaque_player_001", "user")
            .WithTag("journey", "checkout")
            .Build();
        var richClient = LogBrewUnity.CreateClient(
            "LOGBREW_API_KEY",
            "checkout-game",
            context: richContext,
            includeAutomaticContext: false);
        richClient.AddBreadcrumb(
            IssueBreadcrumb.Create("2026-06-02T10:00:07Z", "checkout.request")
                .WithType("http")
                .WithLevel("warning")
                .WithMessage("retry started")
                .WithData(new Dictionary<string, object?> { ["attempt"] = 2 }));
        LogBrewUnity.CaptureException(
            richClient,
            "evt_rich_issue_001",
            "2026-06-02T10:00:08Z",
            "NullReferenceException",
            "Checkout.Submit () (at /workspace/game/Assets/Scripts/Checkout.cs:42)",
            context);
        richClient.Metric(
            "evt_metric_001",
            "2026-06-02T10:00:09Z",
            MetricAttributes.Create("frame.duration", "histogram", 16.6, "ms", "delta")
                .WithMetadata(new Dictionary<string, object?> { ["scene"] = "Checkout" }));
        richClient.Span(
            "evt_span_evidence_001",
            "2026-06-02T10:00:10Z",
            SpanAttributes.Create(
                    "checkout.submit",
                    "4bf92f3577b34da6a3ce929d0e0e4736",
                    "00f067aa0ba902b7",
                    "error")
                .WithEvent(SpanEventSummary.Create("retry").WithMetadata(new Dictionary<string, object?> { ["attempt"] = 2 }))
                .WithLink(SpanLinkSummary.Create("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb").WithSampled(false)));
        var richPreview = richClient.PreviewJson();
        foreach (var expected in new[]
        {
            "\"schemaVersion\": 1",
            "\"subject\"",
            "\"breadcrumbs\"",
            "\"filename\": \"Checkout.cs\"",
            "\"type\": \"metric\"",
            "\"events\"",
            "\"links\""
        })
        {
            if (!richPreview.Contains(expected, StringComparison.Ordinal))
            {
                throw new InvalidOperationException("rich Unity telemetry missing " + expected);
            }
        }

        if (richPreview.Contains("/workspace/game", StringComparison.Ordinal))
        {
            throw new InvalidOperationException("rich Unity telemetry leaked an absolute source path");
        }

        var httpClient = LogBrewUnity.CreateClient("LOGBREW_API_KEY", "logbrew-unity-http", maxRetries: 1);
        httpClient.Log(
            "evt_unity_http_transport",
            "2026-06-02T10:00:09Z",
            LogAttributes.Create("unity http transport sent", "info").WithLogger("unity-http"));
        var capturedAuthorization = string.Empty;
        var httpResponse = httpClient.Flush(new HttpTransport(
            new Uri("https://example.logbrew.test/v1/events"),
            new Dictionary<string, string> { ["x-logbrew-source"] = "unity-smoke" },
            TimeSpan.FromSeconds(10),
            requester: request =>
            {
                capturedAuthorization = request.Headers["authorization"];
                if (request.Headers["content-type"] != "application/json"
                    || request.Headers["x-logbrew-source"] != "unity-smoke"
                    || !request.Body.Contains("evt_unity_http_transport", StringComparison.Ordinal))
                {
                    throw new InvalidOperationException("unexpected HTTP transport request");
                }

                return string.IsNullOrEmpty(capturedAuthorization) ? 500 : 202;
            }));
        if (capturedAuthorization != "Bearer LOGBREW_API_KEY")
        {
            throw new InvalidOperationException("unexpected HTTP transport authorization");
        }

        Console.Error.WriteLine("{\"ok\":true,\"status\":" + response.StatusCode + ",\"retryAttempts\":" + response.Attempts + ",\"unityHelperEvents\":3,\"richContextEvents\":3,\"metricEvents\":1,\"httpAttempts\":" + httpResponse.Attempts + "}");
    }
}
