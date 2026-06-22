using System;
using System.Collections.Generic;
using System.Diagnostics;
using LogBrew;

public static class Program
{
    private const string IncomingTraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    private const string IncomingParentSpanId = "00f067aa0ba902b7";

    public static void Main()
    {
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "checkout-dotnet-service", "0.1.0");
        using var source = new ActivitySource("Checkout.Service", "1.0.0");
        using var ignoredSource = new ActivitySource("Checkout.Ignored", "1.0.0");
        var parent = new ActivityContext(
            ActivityTraceId.CreateFromString(IncomingTraceId.AsSpan()),
            ActivitySpanId.CreateFromString(IncomingParentSpanId.AsSpan()),
            ActivityTraceFlags.Recorded);
        string capturedSpanId;

        using (LogBrewActivitySourceListener.Start(
            client,
            options => options
                .WithSourceName("Checkout.Service")
                .WithEventIdPrefix("dotnet_activity_source_listener")
                .WithTimestampProvider(() => "2026-06-02T10:00:16Z")
                .WithMetadata(new Dictionary<string, object?> { ["component"] = "checkout" })
                .WithMetadataProvider(activity => new Dictionary<string, object?>
                {
                    ["feature"] = "payments",
                    ["activitySource"] = activity.Source.Name,
                    ["fullUrl"] = "https://shop.example/checkout?card=sample",
                    ["ignoredObject"] = new object()
                })))
        {
            using (ignoredSource.StartActivity("ignored.operation", ActivityKind.Internal))
            {
            }

            using var activity = source.StartActivity(
                "https://shop.example/checkout?card=sample",
                ActivityKind.Client,
                parent);
            if (activity == null)
            {
                throw new InvalidOperationException("expected configured ActivitySource to create an Activity");
            }

            activity.SetTag("http.request.method", "POST");
            activity.SetTag("http.route", "https://shop.example/checkout/:cart_id?card=sample#review");
            activity.SetTag("http.response.status_code", 202);
            activity.SetTag("http.url", "https://shop.example/checkout?card=sample");
            activity.SetTag("request.body", "card=sample");
            capturedSpanId = activity.SpanId.ToHexString();
        }

        var events = client.PendingEvents();
        Console.WriteLine(client.PreviewJson());
        var response = client.Shutdown(RecordingTransport.AlwaysAccept());
        Console.Error.WriteLine(
            "{\"ok\":true,\"events\":"
            + events
            + ",\"status\":"
            + response.StatusCode
            + ",\"attempts\":"
            + response.Attempts
            + ",\"activitySpanId\":\""
            + capturedSpanId
            + "\"}");
    }
}
