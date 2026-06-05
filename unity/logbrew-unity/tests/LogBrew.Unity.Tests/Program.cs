#nullable enable

using System;
using System.Collections.Generic;
using LogBrew.Unity;

namespace LogBrew.Unity.Tests
{
    internal static class Program
    {
        public static void Main()
        {
            Run("preview_json_contains_all_supported_event_types", PreviewJsonContainsAllSupportedEventTypes);
            Run("flush_success_clears_queue", FlushSuccessClearsQueue);
            Run("empty_flush_is_noop", EmptyFlushIsNoop);
            Run("invalid_timestamp_fails_validation", InvalidTimestampFailsValidation);
            Run("invalid_issue_level_fails_validation", InvalidIssueLevelFailsValidation);
            Run("negative_span_duration_fails_validation", NegativeSpanDurationFailsValidation);
            Run("null_public_arguments_fail_fast", NullPublicArgumentsFailFast);
            Run("unauthenticated_response_surfaces_clean_error", UnauthenticatedResponseSurfacesCleanError);
            Run("network_failure_retries_before_succeeding", NetworkFailureRetriesBeforeSucceeding);
            Run("http_transport_sends_post_json_with_authorization_and_custom_headers", HttpTransportSendsPostJsonWithAuthorizationAndCustomHeaders);
            Run("http_transport_validates_endpoint_headers_and_timeout", HttpTransportValidatesEndpointHeadersAndTimeout);
            Run("network_failure_returns_error_after_retry_budget", NetworkFailureReturnsErrorAfterRetryBudget);
            Run("non_retryable_status_preserves_queue", NonRetryableStatusPreservesQueue);
            Run("shutdown_flushes_and_prevents_future_events", ShutdownFlushesAndPreventsFutureEvents);
            Run("unity_helpers_add_context_metadata", UnityHelpersAddContextMetadata);
            Console.WriteLine("unity package tests ok (15 tests)");
        }

        private static void Run(string name, Action test)
        {
            try
            {
                test();
            }
            catch (Exception error)
            {
                throw new InvalidOperationException(name + " failed", error);
            }
        }

        private static LogBrewClient NewClient(int maxRetries = 2)
        {
            return LogBrewUnity.CreateClient("LOGBREW_API_KEY", "logbrew-unity-tests", maxRetries);
        }

        private static void EnqueueAll(LogBrewClient client)
        {
            client.Release("evt_release_001", "2026-06-02T10:00:00Z", ReleaseAttributes.Create("1.2.3").WithCommit("abc123def456").WithNotes("Public release marker"));
            client.Environment("evt_environment_001", "2026-06-02T10:00:01Z", EnvironmentAttributes.Create("production").WithRegion("global"));
            client.Issue("evt_issue_001", "2026-06-02T10:00:02Z", IssueAttributes.Create("Checkout timeout", "error").WithMessage("Request timed out after retry budget"));
            client.Log("evt_log_001", "2026-06-02T10:00:03Z", LogAttributes.Create("worker started", "info").WithLogger("job-runner"));
            client.Span("evt_span_001", "2026-06-02T10:00:04Z", SpanAttributes.Create("GET /health", "trace_001", "span_001", "ok").WithDurationMs(12.5));
            client.Action("evt_action_001", "2026-06-02T10:00:05Z", ActionAttributes.Create("deploy", "success"));
        }

        private static void Expect(string code, Action callback)
        {
            try
            {
                callback();
            }
            catch (SdkException error) when (error.Code == code)
            {
                return;
            }

            throw new InvalidOperationException("expected " + code);
        }

        private static void ExpectArgumentNull(string parameterName, Action callback)
        {
            try
            {
                callback();
            }
            catch (ArgumentNullException error) when (error.ParamName == parameterName)
            {
                return;
            }

            throw new InvalidOperationException("expected ArgumentNullException for " + parameterName);
        }

        private static void PreviewJsonContainsAllSupportedEventTypes()
        {
            var client = NewClient();
            EnqueueAll(client);
            var body = client.PreviewJson();
            AssertContains(body, "\"language\": \"unity\"");
            AssertContains(body, "\"type\": \"release\"");
            AssertContains(body, "\"type\": \"environment\"");
            AssertContains(body, "\"type\": \"issue\"");
            AssertContains(body, "\"type\": \"log\"");
            AssertContains(body, "\"type\": \"span\"");
            AssertContains(body, "\"type\": \"action\"");
        }

        private static void FlushSuccessClearsQueue()
        {
            var client = NewClient();
            EnqueueAll(client);
            var transport = RecordingTransport.AlwaysAccept();
            var response = client.Flush(transport);
            AssertEqual(202, response.StatusCode);
            AssertEqual(1, response.Attempts);
            AssertEqual(0, client.PendingEvents());
            AssertEqual(1, transport.SentBodies.Count);
        }

        private static void EmptyFlushIsNoop()
        {
            var response = NewClient().Flush(RecordingTransport.AlwaysAccept());
            AssertEqual(204, response.StatusCode);
            AssertEqual(0, response.Attempts);
        }

        private static void InvalidTimestampFailsValidation()
        {
            Expect("validation_error", () => NewClient().Log("evt_bad", "2026-06-02T10:00:03", LogAttributes.Create("worker started", "info")));
        }

        private static void InvalidIssueLevelFailsValidation()
        {
            Expect("validation_error", () => NewClient().Issue("evt_bad", "2026-06-02T10:00:03Z", IssueAttributes.Create("bad", "fatal")));
        }

        private static void NegativeSpanDurationFailsValidation()
        {
            Expect("validation_error", () => NewClient().Span("evt_bad", "2026-06-02T10:00:03Z", SpanAttributes.Create("bad", "trace", "span", "ok").WithDurationMs(-1)));
        }

        private static void NullPublicArgumentsFailFast()
        {
            var client = NewClient();
            ExpectArgumentNull("attributes", () => client.Release("evt_bad", "2026-06-02T10:00:03Z", null!));
            ExpectArgumentNull("transport", () => client.Flush(null!));
            ExpectArgumentNull("transport", () => client.Shutdown(null!));
            ExpectArgumentNull("client", () => LogBrewUnity.CaptureSceneLoaded(null!, "evt_bad", "2026-06-02T10:00:03Z", "MainMenu"));
        }

        private static void UnauthenticatedResponseSurfacesCleanError()
        {
            var client = NewClient();
            EnqueueAll(client);
            Expect("unauthenticated", () => client.Flush(new RecordingTransport(new object[] { 401 })));
            AssertEqual(6, client.PendingEvents());
        }

        private static void NetworkFailureRetriesBeforeSucceeding()
        {
            var client = NewClient();
            EnqueueAll(client);
            var response = client.Flush(new RecordingTransport(new object[] { TransportException.Network("temporary outage"), 202 }));
            AssertEqual(202, response.StatusCode);
            AssertEqual(2, response.Attempts);
            AssertEqual(0, client.PendingEvents());
        }

        private static void HttpTransportSendsPostJsonWithAuthorizationAndCustomHeaders()
        {
            var client = NewClient(maxRetries: 1);
            client.Log(
                "evt_http_transport_001",
                "2026-06-02T10:00:03Z",
                LogAttributes.Create("http transport sent", "info").WithLogger("unity-test"));
            var capturedRequests = new List<HttpTransportRequest>();
            using var transport = new HttpTransport(
                new Uri("https://example.logbrew.test/v1/events"),
                new Dictionary<string, string> { ["x-logbrew-source"] = "unity-test" },
                TimeSpan.FromSeconds(3),
                requester: request =>
                {
                    capturedRequests.Add(request);
                    return capturedRequests.Count == 1 ? 503 : 202;
                });

            var response = client.Flush(transport);
            var firstRequest = capturedRequests[0];

            AssertEqual(202, response.StatusCode);
            AssertEqual(2, response.Attempts);
            AssertEqual(0, client.PendingEvents());
            AssertEqual(2, capturedRequests.Count);
            AssertEqual("https://example.logbrew.test/v1/events", firstRequest.Endpoint.ToString());
            AssertEqual(3, (int)firstRequest.Timeout.TotalSeconds);
            AssertEqual("application/json", firstRequest.Headers["content-type"]);
            AssertEqual("Bearer LOGBREW_API_KEY", firstRequest.Headers["authorization"]);
            AssertEqual("unity-test", firstRequest.Headers["x-logbrew-source"]);
            AssertContains(firstRequest.Body, "\"id\": \"evt_http_transport_001\"");
        }

        private static void HttpTransportValidatesEndpointHeadersAndTimeout()
        {
            Expect("configuration_error", () => CreateInvalidHttpTransport(new Uri("file:///tmp/events")));
            Expect("configuration_error", () => CreateInvalidHttpTransport(
                new Uri("https://example.logbrew.test/v1/events"),
                new Dictionary<string, string> { [""] = "value" }));
            Expect("configuration_error", () => CreateInvalidHttpTransport(
                new Uri("https://example.logbrew.test/v1/events"),
                null,
                TimeSpan.Zero));
        }

        private static void CreateInvalidHttpTransport(
            Uri endpoint,
            IDictionary<string, string>? headers = null,
            TimeSpan? timeout = null)
        {
            using var transport = timeout == null
                ? new HttpTransport(endpoint, headers)
                : new HttpTransport(endpoint, headers, timeout.Value);
        }

        private static void NetworkFailureReturnsErrorAfterRetryBudget()
        {
            var client = NewClient(maxRetries: 1);
            EnqueueAll(client);
            Expect("network_failure", () => client.Flush(new RecordingTransport(new object[]
            {
                TransportException.Network("temporary outage"),
                TransportException.Network("still down")
            })));
            AssertEqual(6, client.PendingEvents());
        }

        private static void NonRetryableStatusPreservesQueue()
        {
            var client = NewClient();
            EnqueueAll(client);
            Expect("transport_error", () => client.Flush(new RecordingTransport(new object[] { 400 })));
            AssertEqual(6, client.PendingEvents());
        }

        private static void ShutdownFlushesAndPreventsFutureEvents()
        {
            var client = NewClient();
            EnqueueAll(client);
            var response = client.Shutdown(RecordingTransport.AlwaysAccept());
            AssertEqual(202, response.StatusCode);
            AssertEqual(0, client.PendingEvents());
            Expect("shutdown_error", () => client.Action("evt_after_shutdown", "2026-06-02T10:00:06Z", ActionAttributes.Create("deploy", "success")));
        }

        private static void UnityHelpersAddContextMetadata()
        {
            var client = NewClient();
            var context = UnityContext.Create()
                .WithPlatform("ios")
                .WithSceneName("MainMenu")
                .WithGameObjectName("Player")
                .WithSessionId("session_001")
                .WithFrame(42);

            LogBrewUnity.CaptureSceneLoaded(client, "evt_scene_loaded_001", "2026-06-02T10:00:06Z", "MainMenu", 1, context);
            LogBrewUnity.CaptureLogMessage(client, "evt_unity_log_001", "2026-06-02T10:00:07Z", "button clicked", "Warning", context);
            LogBrewUnity.CaptureException(client, "evt_unity_exception_001", "2026-06-02T10:00:08Z", "NullReferenceException", "stack trace", context);
            LogBrewUnity.CaptureFrameSpan(client, "evt_frame_001", "2026-06-02T10:00:09Z", "frame", "trace_001", "span_002", 16.6, context);

            var body = client.PreviewJson();
            AssertContains(body, "\"name\": \"scene_loaded\"");
            AssertContains(body, "\"level\": \"warning\"");
            AssertContains(body, "\"sceneName\": \"MainMenu\"");
            AssertContains(body, "\"gameObjectName\": \"Player\"");
            AssertContains(body, "\"frame\": 42");
            AssertContains(body, "\"source\": \"unity\"");
        }

        private static void AssertContains(string haystack, string needle)
        {
            if (!haystack.Contains(needle, StringComparison.Ordinal))
            {
                throw new InvalidOperationException("missing " + needle);
            }
        }

        private static void AssertEqual(int expected, int actual)
        {
            if (expected != actual)
            {
                throw new InvalidOperationException("expected " + expected + " but got " + actual);
            }
        }

        private static void AssertEqual(string expected, string actual)
        {
            if (!string.Equals(expected, actual, StringComparison.Ordinal))
            {
                throw new InvalidOperationException("expected " + expected + " but got " + actual);
            }
        }
    }
}
