using System;
using System.Collections.Generic;
using System.Globalization;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using LogBrew;
using Microsoft.Extensions.Logging;

public static class Program
{
    private const string IncomingTraceparent =
        "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

    public static async Task Main()
    {
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "checkout-dotnet-service", "0.1.0");
        var rootTrace = LogBrewTraceContext.FromTraceparent(IncomingTraceparent, "b7ad6b7169203331");
        var outgoingTraceparent = string.Empty;
        LogBrewTraceContext? activeTraceDuringSend = null;
        using var loggerFactory = LoggerFactory.Create(builder =>
        {
            builder.SetMinimumLevel(LogLevel.Information);
            builder.AddLogBrew(client, new LogBrewLoggerOptions
            {
                EventIdPrefix = "dotnet_http_client",
                TimestampProvider = () => DateTimeOffset.Parse("2026-06-02T10:00:03Z", CultureInfo.InvariantCulture)
            });
        });
        var logger = loggerFactory.CreateLogger("CheckoutHttpClient");

        using var handler = new LogBrewHttpClientHandler(
            client,
            LogBrewHttpClientOptions.Create()
                .WithEventIdPrefix("dotnet_http_client")
                .WithRouteTemplate("/v1/payments/:id")
                .WithTimestampProvider(() => "2026-06-02T10:00:04Z")
                .WithMetadata(new Dictionary<string, object?>
                {
                    ["provider"] = "payments",
                    ["url"] = "https://payments.example/private?card=sample",
                    ["headers"] = "Authorization: Bearer sample",
                    ["body"] = "card=sample",
                    ["ignored"] = new object()
                }))
        {
            InnerHandler = new RecordingHandler(request =>
            {
                activeTraceDuringSend = LogBrewTrace.Current;
                outgoingTraceparent = request.Headers.TryGetValues("traceparent", out var values)
                    ? string.Join(",", values)
                    : string.Empty;
                logger.LogInformation("payment provider returned {StatusCode}", 202);
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Accepted));
            })
        };
        using var httpClient = new HttpClient(handler);
        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            "https://payments.example/v1/payments/cart_123?card=sample#review");
        request.Headers.TryAddWithoutValidation("traceparent", "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01");

        client.Release(
            "evt_release_checkout_http_client",
            "2026-06-02T10:00:00Z",
            ReleaseAttributes.Create("checkout-api@1.4.2").WithCommit("abc123def456"));
        client.Environment(
            "evt_environment_checkout_http_client",
            "2026-06-02T10:00:01Z",
            EnvironmentAttributes.Create("production").WithRegion("global"));

        using (LogBrewTrace.Activate(rootTrace))
        using (var response = await httpClient.SendAsync(request).ConfigureAwait(false))
        {
            if (response.StatusCode != HttpStatusCode.Accepted)
            {
                throw new InvalidOperationException("expected accepted response");
            }
        }

        if (activeTraceDuringSend == null || string.IsNullOrEmpty(outgoingTraceparent))
        {
            throw new InvalidOperationException("expected outbound trace context during HTTP send");
        }

        Console.WriteLine(client.PreviewJson());
        var flush = client.Shutdown(RecordingTransport.AlwaysAccept());
        Console.Error.WriteLine(
            "{\"ok\":true,\"events\":4,\"status\":"
            + flush.StatusCode
            + ",\"attempts\":"
            + flush.Attempts
            + ",\"logbrewSpanId\":\""
            + activeTraceDuringSend.SpanId
            + "\",\"outgoingTraceparent\":\""
            + outgoingTraceparent
            + "\"}");
    }

    private sealed class RecordingHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, Task<HttpResponseMessage>> send;

        internal RecordingHandler(Func<HttpRequestMessage, Task<HttpResponseMessage>> send)
        {
            this.send = send;
        }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            return send(request);
        }
    }
}
