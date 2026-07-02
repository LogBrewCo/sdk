using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using LogBrew;
using Microsoft.Extensions.Logging;

public static class Program
{
    private const string IncomingTraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    private const string IncomingParentSpanId = "00f067aa0ba902b7";

    public static void Main()
    {
        using var activity = new Activity("checkout.activity");
        activity.SetIdFormat(ActivityIdFormat.W3C);
        activity.SetParentId(
            ActivityTraceId.CreateFromString(IncomingTraceId.AsSpan()),
            ActivitySpanId.CreateFromString(IncomingParentSpanId.AsSpan()),
            ActivityTraceFlags.Recorded);
        activity.ActivityTraceFlags = ActivityTraceFlags.Recorded;
        activity.SetTag("http.request.method", "POST");
        activity.SetTag("http.route", "/checkout/:cart_id");
        activity.SetTag("http.response.status_code", 202);
        activity.SetTag("http.url", "https://shop.example/checkout?card=sample");
        activity.SetTag("http.request.header.authorization", "Bearer sample");
        activity.Start();

        if (!LogBrewTraceContext.TryCreateChildFromCurrentActivity(out var trace) || trace == null)
        {
            throw new InvalidOperationException("expected current Activity to provide W3C trace context");
        }
        if (!LogBrewTraceContext.TryCreateChildFromActivityContext(activity.Context, out var activityContextTrace) || activityContextTrace == null)
        {
            throw new InvalidOperationException("expected ActivityContext to provide W3C trace context");
        }
        if (activityContextTrace.TraceId != trace.TraceId || activityContextTrace.ParentSpanId != activity.SpanId.ToHexString())
        {
            throw new InvalidOperationException("expected ActivityContext and current Activity bridges to share the same trace");
        }

        var client = LogBrewClient.Create("LOGBREW_API_KEY", "checkout-dotnet-service", "0.1.0");
        var request = LogBrewHttpRequestTelemetry.StartWithTraceContext(client, "POST", "/checkout/:cart_id", trace);
        using var loggerFactory = LoggerFactory.Create(builder =>
        {
            builder.SetMinimumLevel(LogLevel.Information);
            builder.AddLogBrew(client, new LogBrewLoggerOptions
            {
                EventIdPrefix = "dotnet_activity_trace",
                TimestampProvider = () => DateTimeOffset.Parse("2026-06-02T10:00:03Z", CultureInfo.InvariantCulture)
            });
        });

        client.Release(
            "evt_release_checkout_activity_trace",
            "2026-06-02T10:00:00Z",
            ReleaseAttributes.Create("checkout-api@1.4.2").WithCommit("abc123def456"));
        client.Environment(
            "evt_environment_checkout_activity_trace",
            "2026-06-02T10:00:01Z",
            EnvironmentAttributes.Create("production").WithRegion("global"));

        using (request.Activate())
        {
            var logger = loggerFactory.CreateLogger("CheckoutActivityTrace");
            logger.LogInformation(
                new EventId(61, "CheckoutActivity"),
                "checkout Activity correlation for {CartId}",
                "cart_123");

            client.Action(
                "evt_action_checkout_activity_trace",
                "2026-06-02T10:00:04Z",
                ProductTimeline.ProductAction("checkout.submit")
                    .WithRouteTemplate("/checkout/:cart_id")
                    .WithSessionId("sess_checkout_123")
                    .WithTraceId(trace.TraceId)
                    .WithScreen("Checkout")
                    .WithFunnel("checkout")
                    .WithStep("submit")
                    .WithMetadata(new Dictionary<string, object?> { ["cartTier"] = "gold" })
                    .ToActionAttributes());
        }

        request.FinishSpanAndMetric(
            "evt_span_checkout_activity_trace",
            "evt_metric_checkout_activity_trace",
            "2026-06-02T10:00:05Z",
            202,
            new Dictionary<string, object?> { ["framework"] = "aspnetcore", ["ignored"] = new object() });

        activity.AddEvent(new ActivityEvent(
            "exception",
            new DateTimeOffset(2026, 06, 02, 10, 00, 06, TimeSpan.Zero),
            new ActivityTagsCollection
            {
                { "exception.type", "System.InvalidOperationException" },
                { "exception.message", "card=sample" },
                { "exception.stacktrace", "at private path" },
                { "http.response.status_code", 503 }
            }));
        activity.AddLink(new ActivityLink(
            new ActivityContext(
                ActivityTraceId.CreateFromString("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".AsSpan()),
                ActivitySpanId.CreateFromString("bbbbbbbbbbbbbbbb".AsSpan()),
                ActivityTraceFlags.Recorded,
                traceState: "vendor=sample",
                isRemote: true),
            new ActivityTagsCollection
            {
                { "messaging.system", "kafka" },
                { "messaging.operation.name", "process" },
                { "messaging.message.id", "msg-" + "sample" }
            }));
        activity.Stop();
        var capturedActivitySpan = LogBrewActivitySpanTelemetry.Capture(
            client,
            activity,
            LogBrewActivitySpanOptions.Create()
                .WithEventIdPrefix("dotnet_activity_source")
                .WithTimestampProvider(() => "2026-06-02T10:00:06Z")
                .WithMetadata(new Dictionary<string, object?>
                {
                    ["safe"] = true,
                    ["url"] = "https://shop.example/private?card=sample",
                    ["headers"] = "Author" + "ization: Bear" + "er sample",
                    ["ignored"] = new object()
                }));
        if (!capturedActivitySpan)
        {
            throw new InvalidOperationException("expected Activity span capture");
        }

        Console.WriteLine(client.PreviewJson());
        var response = client.Shutdown(RecordingTransport.AlwaysAccept());
        Console.Error.WriteLine(
            "{\"ok\":true,\"events\":7,\"status\":"
            + response.StatusCode
            + ",\"attempts\":"
            + response.Attempts
            + ",\"activitySpanId\":\""
            + activity.SpanId.ToHexString()
            + "\",\"logbrewSpanId\":\""
            + trace.SpanId
            + "\",\"activityContextSpanId\":\""
            + activityContextTrace.SpanId
            + "\",\"outgoingTraceparent\":\""
            + request.OutgoingHeaders["traceparent"]
            + "\",\"capturedActivitySpan\":"
            + (capturedActivitySpan ? "true" : "false")
            + "}");
    }
}
