using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using LogBrew;

#pragma warning disable CA2025 // Tests synchronously wait for SendAsync before disposing request/response instances.

internal static class HttpClientTelemetryTests
{
    private const string IncomingTraceparent = "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01";

    internal static int Run()
    {
        var tests = 0;
        OutboundHttpClientHelperInjectsTraceparentAndCapturesSpan();
        tests++;
        OutboundHttpClientHandlerInjectsTraceparentAndCapturesSpan();
        tests++;
        OutboundHttpClientHelperPreservesOriginalException();
        tests++;
        CaptureFailureDoesNotReplaceHttpResponse();
        tests++;
        OutboundHttpClientHelperValidatesInputs();
        tests++;
        return tests;
    }

    private static void OutboundHttpClientHelperInjectsTraceparentAndCapturesSpan()
    {
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "http-client-tests", "0.1.0");
        var root = LogBrewTraceContext.FromTraceparent(IncomingTraceparent, "b7ad6b7169203331");
        LogBrewTraceContext? activeDuringSend = null;
        List<string>? traceparents = null;
        using var handler = new Handler(request =>
        {
            activeDuringSend = LogBrewTrace.Current;
            traceparents = request.Headers.TryGetValues("traceparent", out var values)
                ? values.ToList()
                : new List<string>();
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Created));
        });
        using var httpClient = new HttpClient(handler, disposeHandler: false);
        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            "https://payments.example/v1/payments/cart_123?card=sample#frag");
        request.Headers.TryAddWithoutValidation("traceparent", "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01");

        using (LogBrewTrace.Activate(root))
        {
            using var response = LogBrewHttpClientTelemetry.SendAsync(
                    client,
                    httpClient,
                    request,
                    LogBrewHttpClientOptions.Create()
                        .WithEventIdPrefix("dotnet_outbound")
                        .WithRouteTemplate("/v1/payments/:id")
                        .WithTimestampProvider(() => "2026-06-02T10:00:11Z")
                        .WithMetadata(new Dictionary<string, object?>
                        {
                            ["safe"] = true,
                            ["url"] = "https://payments.example/private?card=sample",
                            ["headers"] = "Author" + "ization: Bear" + "er sample",
                            ["body"] = "card=sample",
                            ["ignored"] = new object()
                        }))
                .GetAwaiter()
                .GetResult();
            Require(response.StatusCode == HttpStatusCode.Created, "expected response status");
        }

        var child = activeDuringSend ?? throw new InvalidOperationException("expected active child trace during send");
        Require(child.TraceId == root.TraceId, "expected outbound trace id to follow active root");
        Require(child.ParentSpanId == root.SpanId, "expected outbound parent span");
        Require(child.SpanId != root.SpanId, "expected outbound child span");
        Require(traceparents != null && traceparents.Count == 1, "expected exactly one outgoing traceparent");
        Require(traceparents![0] == child.Traceparent, "expected normalized outgoing traceparent from child span");

        var payload = client.PreviewJson();
        foreach (var expected in new[]
        {
            "\"id\": \"dotnet_outbound_span_" + child.SpanId + "\"",
            "\"name\": \"HTTP POST /v1/payments/:id\"",
            "\"status\": \"ok\"",
            "\"traceId\": \"4bf92f3577b34da6a3ce929d0e0e4736\"",
            "\"spanId\": \"" + child.SpanId + "\"",
            "\"parentSpanId\": \"b7ad6b7169203331\"",
            "\"source\": \"http.client\"",
            "\"method\": \"POST\"",
            "\"routeTemplate\": \"/v1/payments/:id\"",
            "\"statusCode\": 201",
            "\"safe\": true",
            "\"sampled\": true"
        })
        {
            Require(payload.Contains(expected, StringComparison.Ordinal), "missing outbound HTTP payload: " + expected);
        }

        foreach (var blocked in new[] { "payments.example", "card=sample", "Author" + "ization", "Bear" + "er", "headers", "body", "\"url\"", "ignored" })
        {
            Require(!payload.Contains(blocked, StringComparison.Ordinal), "expected unsafe outbound metadata to be omitted: " + blocked);
        }
    }

    private static void OutboundHttpClientHandlerInjectsTraceparentAndCapturesSpan()
    {
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "http-client-tests", "0.1.0");
        var root = LogBrewTraceContext.FromTraceparent(IncomingTraceparent, "b7ad6b7169203331");
        LogBrewTraceContext? activeDuringSend = null;
        List<string>? traceparents = null;
        using var logbrewHandler = new LogBrewHttpClientHandler(
            client,
            LogBrewHttpClientOptions.Create()
                .WithEventIdPrefix("dotnet_handler")
                .WithRouteTemplate("/v1/refunds/:id")
                .WithTimestampProvider(() => "2026-06-02T10:00:12Z")
                .WithMetadata(new Dictionary<string, object?>
                {
                    ["safe"] = "handler",
                    ["url"] = "https://payments.example/private?card=sample",
                    ["headers"] = "Author" + "ization: Bear" + "er sample"
                }))
        {
            InnerHandler = new Handler(request =>
            {
                activeDuringSend = LogBrewTrace.Current;
                traceparents = request.Headers.TryGetValues("traceparent", out var values)
                    ? values.ToList()
                    : new List<string>();
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK));
            })
        };
        using var httpClient = new HttpClient(logbrewHandler);
        using var request = new HttpRequestMessage(
            HttpMethod.Get,
            "https://payments.example/v1/refunds/ref_123?card=sample#frag");

        using (LogBrewTrace.Activate(root))
        {
            using var response = httpClient.SendAsync(request).GetAwaiter().GetResult();
            Require(response.StatusCode == HttpStatusCode.OK, "expected handler response status");
        }

        var child = activeDuringSend ?? throw new InvalidOperationException("expected handler child trace during send");
        Require(child.TraceId == root.TraceId, "expected handler trace id to follow active root");
        Require(child.ParentSpanId == root.SpanId, "expected handler parent span");
        Require(traceparents != null && traceparents.Count == 1, "expected exactly one handler traceparent");
        Require(traceparents![0] == child.Traceparent, "expected handler traceparent from child span");

        var payload = client.PreviewJson();
        foreach (var expected in new[]
        {
            "\"id\": \"dotnet_handler_span_" + child.SpanId + "\"",
            "\"name\": \"HTTP GET /v1/refunds/:id\"",
            "\"status\": \"ok\"",
            "\"source\": \"http.client\"",
            "\"method\": \"GET\"",
            "\"routeTemplate\": \"/v1/refunds/:id\"",
            "\"statusCode\": 200",
            "\"safe\": \"handler\""
        })
        {
            Require(payload.Contains(expected, StringComparison.Ordinal), "missing handler HTTP payload: " + expected);
        }

        foreach (var blocked in new[] { "payments.example", "card=sample", "Author" + "ization", "Bear" + "er", "headers", "\"url\"" })
        {
            Require(!payload.Contains(blocked, StringComparison.Ordinal), "expected unsafe handler metadata to be omitted: " + blocked);
        }
    }

    private static void OutboundHttpClientHelperPreservesOriginalException()
    {
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "http-client-tests", "0.1.0");
        var original = new HttpRequestException("upstream private detail leaked in exception message");
        using var handler = new Handler(_ => throw original);
        using var httpClient = new HttpClient(handler, disposeHandler: false);
        using var request = new HttpRequestMessage(HttpMethod.Get, "https://api.example/private?debug=sample");

        try
        {
            LogBrewHttpClientTelemetry.SendAsync(
                    client,
                    httpClient,
                    request,
                    LogBrewHttpClientOptions.Create().WithRouteTemplate("/private"))
                .GetAwaiter()
                .GetResult();
            throw new InvalidOperationException("expected original HTTP exception");
        }
        catch (HttpRequestException error)
        {
            Require(object.ReferenceEquals(error, original), "expected original exception object");
        }

        var payload = client.PreviewJson();
        Require(payload.Contains("\"status\": \"error\"", StringComparison.Ordinal), "expected error span");
        Require(payload.Contains("\"errorType\": \"System.Net.Http.HttpRequestException\"", StringComparison.Ordinal), "expected exception type only");
        Require(!payload.Contains("upstream private detail", StringComparison.Ordinal), "expected exception message to be omitted");
        Require(!payload.Contains("api.example", StringComparison.Ordinal), "expected host to be omitted");
        Require(!payload.Contains("debug=sample", StringComparison.Ordinal), "expected query to be omitted");
    }

    private static void CaptureFailureDoesNotReplaceHttpResponse()
    {
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "http-client-tests", "0.1.0");
        client.Shutdown(RecordingTransport.AlwaysAccept());
        var captureErrors = 0;
        using var handler = new Handler(_ => Task.FromResult(new HttpResponseMessage(HttpStatusCode.Accepted)));
        using var httpClient = new HttpClient(handler, disposeHandler: false);
        using var request = new HttpRequestMessage(HttpMethod.Delete, "https://api.example/cache/42");

        using var response = LogBrewHttpClientTelemetry.SendAsync(
                client,
                httpClient,
                request,
                LogBrewHttpClientOptions.Create()
                    .WithRouteTemplate("/cache/:id")
                    .OnError(error =>
                    {
                        Require(error.Code == "shutdown_error", "expected shutdown capture error");
                        captureErrors++;
                        throw new InvalidOperationException("diagnostics callback failed");
                    }))
            .GetAwaiter()
            .GetResult();

        Require(response.StatusCode == HttpStatusCode.Accepted, "expected HTTP response to win over capture failure");
        Require(captureErrors == 1, "expected one capture failure callback");
    }

    private static void OutboundHttpClientHelperValidatesInputs()
    {
        using var handler = new Handler(_ => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)));
        using var httpClient = new HttpClient(handler, disposeHandler: false);
        using var request = new HttpRequestMessage(HttpMethod.Get, "https://api.example/health");

        ExpectSdkError("validation_error", "HTTP client routeTemplate must be non-empty", () =>
            LogBrewHttpClientTelemetry.SendAsync(
                    LogBrewClient.Create("LOGBREW_API_KEY", "http-client-tests", "0.1.0"),
                    httpClient,
                    request,
                    LogBrewHttpClientOptions.Create().WithRouteTemplate("   "))
                .GetAwaiter()
                .GetResult());
        ExpectSdkError("validation_error", "HTTP client eventIdPrefix must be non-empty", () =>
            LogBrewHttpClientTelemetry.SendAsync(
                    LogBrewClient.Create("LOGBREW_API_KEY", "http-client-tests", "0.1.0"),
                    httpClient,
                    request,
                    LogBrewHttpClientOptions.Create().WithEventIdPrefix("   "))
                .GetAwaiter()
                .GetResult());
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

    private sealed class Handler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, Task<HttpResponseMessage>> send;

        internal Handler(Func<HttpRequestMessage, Task<HttpResponseMessage>> send)
        {
            this.send = send;
        }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            return send(request);
        }
    }
}
