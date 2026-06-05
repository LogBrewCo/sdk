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

        Console.Error.WriteLine("{\"ok\":true,\"status\":" + response.StatusCode + ",\"retryAttempts\":" + response.Attempts + ",\"unityHelperEvents\":3,\"httpAttempts\":" + httpResponse.Attempts + "}");
    }
}
