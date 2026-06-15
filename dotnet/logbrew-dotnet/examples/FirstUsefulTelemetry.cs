using System;
using System.Collections.Generic;
using LogBrew;

public static class Program
{
    private const string IncomingTraceparent =
        "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01";
    private const string ChildSpanId = "b7ad6b7169203331";
    private const string SessionId = "sess_checkout_123";
    private const string RouteTemplate = "/checkout/:cart_id";

    public static void Main()
    {
        var context = Traceparent.Parse(IncomingTraceparent);
        var outgoingHeaders = Traceparent.CreateHeaders(
            context.TraceId,
            ChildSpanId,
            context.TraceFlags);
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "checkout-dotnet-service", "0.1.0");

        EnqueueFirstUsefulTelemetry(client, context);

        Console.WriteLine(client.PreviewJson());
        var response = client.Shutdown(RecordingTransport.AlwaysAccept());
        Console.Error.WriteLine(
            "{\"ok\":true,\"status\":"
            + response.StatusCode
            + ",\"attempts\":"
            + response.Attempts
            + ",\"events\":7,\"outgoingTraceparent\":\""
            + outgoingHeaders["traceparent"]
            + "\"}");
    }

    private static void EnqueueFirstUsefulTelemetry(LogBrewClient client, TraceparentContext context)
    {
        client.Release(
            "evt_release_checkout_api",
            "2026-06-02T10:00:00Z",
            ReleaseAttributes.Create("checkout-api@1.4.2")
                .WithCommit("abc123def456")
                .WithMetadata(new Dictionary<string, object?> { ["deploySource"] = "dotnet-service" }));
        client.Environment(
            "evt_environment_checkout_api",
            "2026-06-02T10:00:01Z",
            EnvironmentAttributes.Create("production")
                .WithRegion("us-east-1")
                .WithMetadata(new Dictionary<string, object?> { ["service"] = "checkout-api" }));
        client.Log(
            "evt_log_checkout_started",
            "2026-06-02T10:00:02Z",
            LogAttributes.Create("checkout request started", "info")
                .WithLogger("checkout.http")
                .WithMetadata(new Dictionary<string, object?>
                {
                    ["routeTemplate"] = RouteTemplate,
                    ["sessionId"] = SessionId,
                    ["traceId"] = context.TraceId
                }));
        client.Action(
            "evt_action_checkout_submit",
            "2026-06-02T10:00:03Z",
            ProductTimeline.ProductAction("checkout.submit")
                .WithRouteTemplate("https://shop.example/checkout/:cart_id?coupon=sample#review")
                .WithSessionId(SessionId)
                .WithTraceId(context.TraceId)
                .WithScreen("Checkout")
                .WithFunnel("checkout")
                .WithStep("submit")
                .WithMetadata(new Dictionary<string, object?> { ["cartTier"] = "gold" })
                .ToActionAttributes());
        client.Action(
            "evt_action_payment_api",
            "2026-06-02T10:00:04Z",
            ProductTimeline.NetworkMilestone("https://payments.example/payments/:payment_id?card=sample")
                .WithMethod("post")
                .WithStatusCode(202)
                .WithDurationMs(183.4)
                .WithSessionId(SessionId)
                .WithTraceId(context.TraceId)
                .WithMetadata(new Dictionary<string, object?> { ["dependency"] = "payments" })
                .ToActionAttributes());
        client.Metric(
            "evt_metric_http_server_duration",
            "2026-06-02T10:00:05Z",
            MetricAttributes.Create("http.server.duration", "histogram", 183.4, "ms", "delta")
                .WithMetadata(new Dictionary<string, object?>
                {
                    ["method"] = "POST",
                    ["routeTemplate"] = RouteTemplate,
                    ["statusCode"] = 202,
                    ["traceId"] = context.TraceId
                }));
        client.Span(
            "evt_span_checkout_request",
            "2026-06-02T10:00:06Z",
            Traceparent.SpanAttributesFromTraceparent(
                IncomingTraceparent,
                TraceparentSpanInput.Create("POST " + RouteTemplate, ChildSpanId, "ok")
                    .WithDurationMs(183.4)
                    .WithMetadata(new Dictionary<string, object?>
                    {
                        ["routeTemplate"] = RouteTemplate,
                        ["sampled"] = context.Sampled,
                        ["sessionId"] = SessionId
                    })));
    }
}
