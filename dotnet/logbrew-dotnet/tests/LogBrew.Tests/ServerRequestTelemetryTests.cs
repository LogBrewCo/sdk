using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using LogBrew;

internal static class ServerRequestTelemetryTests
{
    private const string IncomingTraceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

    internal static int Run()
    {
        var tests = 0;
        ServerRequestHelperCorrelatesSpanMetricAndActiveTrace();
        tests++;
        ServerRequestHelperCapturesExceptionIssueAndPreservesOriginalError();
        tests++;
        CaptureFailuresDoNotBreakSuccessfulRequest();
        tests++;
        return tests;
    }

    private static void ServerRequestHelperCorrelatesSpanMetricAndActiveTrace()
    {
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "server-request-tests", "0.1.0");

        LogBrewServerRequestTelemetry.CaptureAsync(
            client,
            "post",
            "https://shop.example/checkout/{cartId}?coupon=dropme#review",
            IncomingTraceparent,
            request =>
            {
                Require(LogBrewTrace.Current != null, "expected active server request trace");
                Require(LogBrewTrace.Current!.TraceId == request.Trace.TraceId, "expected helper trace to be active");
                client.Log(
                    "evt_dotnet_server_request_log",
                    "2026-06-02T10:00:32Z",
                    LogAttributes.Create("checkout request accepted", "info")
                        .WithMetadata(LogBrewTrace.MetadataWithCurrentTrace(new Dictionary<string, object?>
                        {
                            ["routeTemplate"] = request.RouteTemplate
                        })));
                return Task.FromResult(202);
            },
            LogBrewServerRequestOptions.Create()
                .WithEventIdPrefix("dotnet_server_request")
                .WithTimestampProvider(() => "2026-06-02T10:00:33Z")
                .WithMetadata(new Dictionary<string, object?>
                {
                    ["framework"] = "aspnetcore",
                    ["user.id"] = "user_123",
                    ["query"] = "coupon=dropme",
                    ["ignored"] = new object()
                })).GetAwaiter().GetResult();

        var preview = client.PreviewJson();
        Require(preview.Contains("\"id\": \"dotnet_server_request_span_", StringComparison.Ordinal), "expected prefixed span event id");
        Require(preview.Contains("\"id\": \"dotnet_server_request_metric_", StringComparison.Ordinal), "expected prefixed metric event id");
        Require(preview.Contains("\"id\": \"evt_dotnet_server_request_log\"", StringComparison.Ordinal), "expected request log event");
        Require(preview.Contains("\"name\": \"POST /checkout/{cartId}\"", StringComparison.Ordinal), "expected query-free route template");
        Require(preview.Contains("\"routeTemplate\": \"/checkout/{cartId}\"", StringComparison.Ordinal), "expected sanitized metadata route");
        Require(preview.Contains("\"statusCode\": 202", StringComparison.Ordinal), "expected response status metadata");
        Require(preview.Contains("\"traceId\": \"4bf92f3577b34da6a3ce929d0e0e4736\"", StringComparison.Ordinal), "expected trace correlation");
        Require(preview.Contains("\"parentSpanId\": \"00f067aa0ba902b7\"", StringComparison.Ordinal), "expected incoming parent span");
        Require(preview.Contains("\"name\": \"http.server.duration\"", StringComparison.Ordinal), "expected request duration metric");
        Require(preview.Contains("\"framework\": \"aspnetcore\"", StringComparison.Ordinal), "expected framework metadata");
        Require(preview.Contains("\"user.id\": \"user_123\"", StringComparison.Ordinal), "expected primitive user-safe metadata");
        Require(!preview.Contains("coupon=dropme", StringComparison.Ordinal), "query text must not be captured");
        Require(!preview.Contains("ignored", StringComparison.Ordinal), "non-primitive metadata must be dropped");
    }

    private static void ServerRequestHelperCapturesExceptionIssueAndPreservesOriginalError()
    {
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "server-request-error-tests", "0.1.0");
        var original = new InvalidOperationException("payment provider failed");
        try
        {
            LogBrewServerRequestTelemetry.CaptureAsync(
                client,
                "GET",
                "/checkout/{cartId}",
                IncomingTraceparent,
                _ => throw original,
                LogBrewServerRequestOptions.Create()
                    .WithEventIdPrefix("dotnet_server_error")
                    .WithTimestampProvider(() => "2026-06-02T10:00:34Z")).GetAwaiter().GetResult();
            throw new InvalidOperationException("expected original exception");
        }
        catch (InvalidOperationException error) when (ReferenceEquals(error, original))
        {
        }

        var preview = client.PreviewJson();
        Require(preview.Contains("\"id\": \"dotnet_server_error_issue_", StringComparison.Ordinal), "expected exception issue");
        Require(preview.Contains("\"id\": \"dotnet_server_error_span_", StringComparison.Ordinal), "expected failed request span");
        Require(preview.Contains("\"title\": \"ASP.NET Core request failed\"", StringComparison.Ordinal), "expected issue title");
        Require(preview.Contains("\"message\": \"payment provider failed\"", StringComparison.Ordinal), "expected exception message");
        Require(preview.Contains("\"exceptionType\": \"System.InvalidOperationException\"", StringComparison.Ordinal), "expected exception type");
        Require(preview.Contains("\"statusCode\": 500", StringComparison.Ordinal), "expected error status metadata");
        Require(preview.Contains("\"status\": \"error\"", StringComparison.Ordinal), "expected error span status");
        Require(!preview.Contains("exceptionStackTrace", StringComparison.Ordinal), "stack trace should stay opt-in");
    }

    private static void CaptureFailuresDoNotBreakSuccessfulRequest()
    {
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "server-request-capture-failure-tests", "0.1.0");
        client.Shutdown(RecordingTransport.AlwaysAccept());
        var captureFailures = 0;

        LogBrewServerRequestTelemetry.CaptureAsync(
            client,
            "GET",
            "/ready",
            IncomingTraceparent,
            _ => Task.FromResult(204),
            LogBrewServerRequestOptions.Create()
                .WithEventIdPrefix("dotnet_server_closed_client")
                .WithTimestampProvider(() => "2026-06-02T10:00:35Z")
                .WithCaptureFailureHandler(_ => captureFailures++)).GetAwaiter().GetResult();

        Require(captureFailures == 1, "expected capture failure to be reported once");
    }

    private static void Require(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException(message);
        }
    }
}
