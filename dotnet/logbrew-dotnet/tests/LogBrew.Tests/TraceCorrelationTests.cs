using System;
using System.Collections.Generic;
using System.Globalization;
using System.Threading.Tasks;
using LogBrew;
using Microsoft.Extensions.Logging;

internal static class TraceCorrelationTests
{
    private const string IncomingTraceparent = "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01";

    internal static int Run()
    {
        var tests = 0;
        TraceContextCreatesW3CHeaders();
        tests++;
        ActiveTraceFlowsThroughAsyncWork();
        tests++;
        RequestHelperLinksLogsErrorsSpansAndMetrics();
        tests++;
        RequestHelperAcceptsExplicitTraceContext();
        tests++;
        RequestHelperFallsBackOnMalformedPropagation();
        tests++;
        RequestHelperValidatesInputs();
        tests++;
        return tests;
    }

    private static void TraceContextCreatesW3CHeaders()
    {
        var context = LogBrewTraceContext.FromTraceparent(IncomingTraceparent, "B7AD6B7169203331");
        Require(context.TraceId == "4bf92f3577b34da6a3ce929d0e0e4736", "expected normalized trace id");
        Require(context.SpanId == "b7ad6b7169203331", "expected normalized span id");
        Require(context.ParentSpanId == "00f067aa0ba902b7", "expected normalized parent span id");
        Require(context.TraceFlags == "01", "expected trace flags");
        Require(context.Sampled, "expected sampled trace context");
        Require(
            context.Headers["traceparent"] == "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01",
            "expected outgoing traceparent header");
        Require(!context.ToMetadata().ContainsKey("traceparent"), "expected raw traceparent to stay out of metadata");
    }

    private static void ActiveTraceFlowsThroughAsyncWork()
    {
        Require(LogBrewTrace.Current == null, "expected no active trace before scope");
        var root = LogBrewTraceContext.CreateRoot();
        using (LogBrewTrace.Activate(root))
        {
            Require(object.ReferenceEquals(LogBrewTrace.Current, root), "expected active root trace");
            Task.Run(() =>
            {
                Require(object.ReferenceEquals(LogBrewTrace.Current, root), "expected active trace to flow through Task.Run");
            }).GetAwaiter().GetResult();

            var child = LogBrewTraceContext.CreateChild(root);
            using (LogBrewTrace.Activate(child))
            {
                Require(object.ReferenceEquals(LogBrewTrace.Current, child), "expected child trace to become active");
            }

            Require(object.ReferenceEquals(LogBrewTrace.Current, root), "expected outer trace to be active again");
        }

        Require(LogBrewTrace.Current == null, "expected active trace to clear after scope");
    }

    private static void RequestHelperLinksLogsErrorsSpansAndMetrics()
    {
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "trace-tests", "0.1.0");
        var request = LogBrewHttpRequestTelemetry.Start(
            client,
            "post",
            "https://shop.example/checkout/:cart_id?debug=sample#review",
            IncomingTraceparent);
        var providerErrors = 0;
        using (var factory = LoggerFactory.Create(builder =>
        {
            builder.SetMinimumLevel(LogLevel.Debug);
            builder.AddLogBrew(client, new LogBrewLoggerOptions
            {
                MinimumLevel = LogLevel.Debug,
                EventIdPrefix = "dotnet_trace",
                TimestampProvider = () => DateTimeOffset.Parse("2026-06-02T10:00:07Z", CultureInfo.InvariantCulture),
                OnError = _ => providerErrors++
            });
        }))
        using (request.Activate())
        {
            var logger = factory.CreateLogger("CheckoutTrace");
            Task.Run(() =>
            {
                logger.Log(
                    LogLevel.Warning,
                    new EventId(51, "TraceWarning"),
                    new Dictionary<string, object?>
                    {
                        ["CartId"] = "cart_123",
                        ["{OriginalFormat}"] = "checkout slow for {CartId}"
                    },
                    null,
                    static (_, _) => "checkout slow for cart_123");
            }).GetAwaiter().GetResult();

            client.Issue(
                "evt_trace_issue",
                "2026-06-02T10:00:08Z",
                IssueAttributes.Create("Checkout handler failed", "error")
                    .WithMessage("payment provider failed")
                    .WithMetadata(LogBrewTrace.MetadataWithCurrentTrace(new Dictionary<string, object?>
                    {
                        ["routeTemplate"] = request.RouteTemplate,
                        ["exceptionType"] = "System.InvalidOperationException",
                        ["exceptionMessage"] = "payment provider failed",
                        ["safe"] = true,
                        ["ignored"] = new object()
                    })));
        }

        request.FinishSpanAndMetric(
            "evt_trace_request_span",
            "evt_trace_request_metric",
            "2026-06-02T10:00:09Z",
            503,
            new Dictionary<string, object?> { ["cartTier"] = "gold", ["ignored"] = new object() });

        Require(providerErrors == 0, "expected no logger provider errors");
        Require(client.PendingEvents() == 4, "expected log, issue, span, and metric events");
        var payload = client.PreviewJson();
        foreach (var expected in new[]
        {
            "\"id\": \"dotnet_trace_1\"",
            "\"logger\": \"CheckoutTrace\"",
            "\"traceId\": \"4bf92f3577b34da6a3ce929d0e0e4736\"",
            "\"spanId\": \"" + request.Trace.SpanId + "\"",
            "\"parentSpanId\": \"00f067aa0ba902b7\"",
            "\"traceFlags\": \"01\"",
            "\"traceSampled\": true",
            "\"routeTemplate\": \"/checkout/:cart_id\"",
            "\"statusCode\": 503",
            "\"status\": \"error\"",
            "\"name\": \"POST /checkout/:cart_id\"",
            "\"name\": \"http.server.duration\"",
            "\"exceptionMessage\": \"payment provider failed\""
        })
        {
            Require(payload.Contains(expected, StringComparison.Ordinal), "missing trace correlation payload: " + expected);
        }

        Require(!payload.Contains("debug=sample", StringComparison.Ordinal), "expected query string to be omitted");
        Require(!payload.Contains("traceparent", StringComparison.OrdinalIgnoreCase), "expected raw traceparent to be omitted");
        Require(!payload.Contains("ignored", StringComparison.Ordinal), "expected non-primitive metadata to be skipped");
    }

    private static void RequestHelperAcceptsExplicitTraceContext()
    {
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "trace-tests", "0.1.0");
        var trace = LogBrewTraceContext.FromTraceparent(IncomingTraceparent, "b7ad6b7169203331");
        var request = LogBrewHttpRequestTelemetry.StartWithTraceContext(client, "GET", "/catalog/:id", trace);
        Require(object.ReferenceEquals(request.Trace, trace), "expected request helper to use explicit trace context");
        request.FinishSpan("evt_explicit_trace", "2026-06-02T10:00:09Z", 200);
        var payload = client.PreviewJson();
        Require(payload.Contains("\"traceId\": \"4bf92f3577b34da6a3ce929d0e0e4736\"", StringComparison.Ordinal), "expected explicit trace id");
        Require(payload.Contains("\"spanId\": \"b7ad6b7169203331\"", StringComparison.Ordinal), "expected explicit span id");
    }

    private static void RequestHelperFallsBackOnMalformedPropagation()
    {
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "trace-tests", "0.1.0");
        var request = LogBrewHttpRequestTelemetry.Start(client, "GET", "/health", "not-a-traceparent");
        Require(request.Trace.ParentSpanId == null, "expected malformed propagation to become local root");
        Require(request.Trace.TraceId.Length == 32, "expected generated root trace id");
        Require(request.Trace.SpanId.Length == 16, "expected generated root span id");
        request.FinishSpan("evt_fallback_span", "2026-06-02T10:00:10Z", 200);
        var payload = client.PreviewJson();
        Require(payload.Contains("\"status\": \"ok\"", StringComparison.Ordinal), "expected fallback span to be ok");
        Require(!payload.Contains("not-a-traceparent", StringComparison.Ordinal), "expected malformed input to be omitted");
    }

    private static void RequestHelperValidatesInputs()
    {
        ExpectSdkError("validation_error", "HTTP request method must be a valid HTTP method", () =>
            LogBrewHttpRequestTelemetry.Start(LogBrewClient.Create("LOGBREW_API_KEY", "trace-tests", "0.1.0"), "GET /bad", "/health"));
        ExpectSdkError("validation_error", "HTTP request routeTemplate must be non-empty", () =>
            LogBrewHttpRequestTelemetry.Start(LogBrewClient.Create("LOGBREW_API_KEY", "trace-tests", "0.1.0"), "GET", "   "));
        ExpectSdkError("validation_error", "HTTP request statusCode must be between 100 and 599", () =>
            LogBrewHttpRequestTelemetry.Start(LogBrewClient.Create("LOGBREW_API_KEY", "trace-tests", "0.1.0"), "GET", "/health")
                .FinishSpan("evt_bad_status", "2026-06-02T10:00:10Z", 99));

        var request = LogBrewHttpRequestTelemetry.Start(LogBrewClient.Create("LOGBREW_API_KEY", "trace-tests", "0.1.0"), "GET", "/health");
        request.FinishSpan("evt_once", "2026-06-02T10:00:10Z", 200);
        ExpectSdkError("validation_error", "HTTP request telemetry is already finished", () =>
            request.FinishSpan("evt_twice", "2026-06-02T10:00:11Z", 200));
    }

    private static void Require(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException(message);
        }
    }

    private static void ExpectSdkError(string code, string messageFragment, Action callback)
    {
        try
        {
            callback();
        }
        catch (SdkException error)
        {
            Require(error.Code == code, "expected " + code + " but got " + error.Code);
            Require(error.Message.Contains(messageFragment, StringComparison.Ordinal), "expected error containing " + messageFragment);
            return;
        }

        throw new InvalidOperationException("expected SdkException with code " + code);
    }
}
