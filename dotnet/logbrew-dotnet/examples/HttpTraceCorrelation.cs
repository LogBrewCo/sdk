using System;
using System.Collections.Generic;
using System.Globalization;
using System.Threading.Tasks;
using LogBrew;
using Microsoft.Extensions.Logging;

public static class Program
{
    private const string IncomingTraceparent =
        "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

    public static void Main()
    {
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "checkout-dotnet-service", "0.1.0");
        var request = LogBrewHttpRequestTelemetry.Start(
            client,
            "POST",
            "https://shop.example/checkout/:cart_id?coupon=sample#review",
            IncomingTraceparent);
        using var loggerFactory = LoggerFactory.Create(builder =>
        {
            builder.SetMinimumLevel(LogLevel.Information);
            builder.AddLogBrew(client, new LogBrewLoggerOptions
            {
                EventIdPrefix = "dotnet_http_trace",
                TimestampProvider = () => DateTimeOffset.Parse("2026-06-02T10:00:03Z", CultureInfo.InvariantCulture)
            });
        });

        client.Release(
            "evt_release_checkout_http_trace",
            "2026-06-02T10:00:00Z",
            ReleaseAttributes.Create("checkout-api@1.4.2").WithCommit("abc123def456"));
        client.Environment(
            "evt_environment_checkout_http_trace",
            "2026-06-02T10:00:01Z",
            EnvironmentAttributes.Create("production").WithRegion("global"));

        using (request.Activate())
        {
            var logger = loggerFactory.CreateLogger("CheckoutTrace");
            Task.Run(() =>
            {
                logger.Log(
                    LogLevel.Warning,
                    new EventId(51, "CheckoutSlow"),
                    new Dictionary<string, object?>
                    {
                        ["CartId"] = "cart_123",
                        ["{OriginalFormat}"] = "checkout slow for {CartId}"
                    },
                    null,
                    static (_, _) => "checkout slow for cart_123");
            }).GetAwaiter().GetResult();

            client.Issue(
                "evt_issue_checkout_trace",
                "2026-06-02T10:00:04Z",
                IssueAttributes.Create("Checkout handler failed", "error")
                    .WithMessage("payment provider failed")
                    .WithMetadata(LogBrewTrace.MetadataWithCurrentTrace(new Dictionary<string, object?>
                    {
                        ["routeTemplate"] = request.RouteTemplate,
                        ["exceptionType"] = "System.InvalidOperationException",
                        ["exceptionMessage"] = "payment provider failed",
                        ["ignored"] = new object()
                    })));

            client.Action(
                "evt_action_checkout_trace",
                "2026-06-02T10:00:05Z",
                ProductTimeline.ProductAction("checkout.submit")
                    .WithRouteTemplate("https://shop.example/checkout/:cart_id?coupon=sample#review")
                    .WithSessionId("sess_checkout_123")
                    .WithTraceId(request.Trace.TraceId)
                    .WithScreen("Checkout")
                    .WithFunnel("checkout")
                    .WithStep("submit")
                    .WithMetadata(new Dictionary<string, object?> { ["cartTier"] = "gold" })
                    .ToActionAttributes());
        }

        request.FinishSpanAndMetric(
            "evt_span_checkout_trace",
            "evt_metric_checkout_trace",
            "2026-06-02T10:00:06Z",
            503,
            new Dictionary<string, object?> { ["cartTier"] = "gold" });

        Console.WriteLine(client.PreviewJson());
        var response = client.Shutdown(RecordingTransport.AlwaysAccept());
        Console.Error.WriteLine(
            "{\"ok\":true,\"events\":7,\"status\":"
            + response.StatusCode
            + ",\"attempts\":"
            + response.Attempts
            + ",\"outgoingTraceparent\":\""
            + request.OutgoingHeaders["traceparent"]
            + "\"}");
    }
}
