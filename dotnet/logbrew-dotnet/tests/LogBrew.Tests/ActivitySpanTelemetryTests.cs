using System;
using System.Collections.Generic;
using System.Diagnostics;
using LogBrew;

internal static class ActivitySpanTelemetryTests
{
    private const string IncomingTraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    private const string IncomingParentSpanId = "00f067aa0ba902b7";

    internal static int Run()
    {
        var tests = 0;
        CaptureCopiesActivityAsSanitizedSpan();
        tests++;
        CaptureCopiesActivityEventsAndLinksSafely();
        tests++;
        CaptureCopiesExplicitResourceContextSafely();
        tests++;
        CaptureCopiesSafeResourceConventionTags();
        tests++;
        CaptureIgnoresInvalidActivity();
        tests++;
        CaptureFailureReportsErrorWithoutThrowing();
        tests++;
        CaptureValidatesInputs();
        tests++;
        return tests;
    }

    private static void CaptureCopiesActivityAsSanitizedSpan()
    {
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "activity-tests", "0.1.0");
        using var activity = new Activity("checkout.activity");
        activity.SetIdFormat(ActivityIdFormat.W3C);
        activity.SetParentId(
            ActivityTraceId.CreateFromString(IncomingTraceId.AsSpan()),
            ActivitySpanId.CreateFromString(IncomingParentSpanId.AsSpan()),
            ActivityTraceFlags.Recorded);
        activity.ActivityTraceFlags = ActivityTraceFlags.Recorded;
        activity.SetTag("http.request.method", "POST");
        activity.SetTag("http.route", "/checkout/:cart_id");
        activity.SetTag("http.response.status_code", 503);
        activity.SetTag("otel.status_code", "ERROR");
        activity.SetTag("db.system", "postgresql");
        activity.SetTag("messaging.system", "kafka");
        activity.SetTag("http.url", "https://shop.example/checkout?card=sample");
        activity.SetTag("http.request.header.authorization", "Bearer sample");
        activity.SetTag("request.body", "card=sample");
        var authLikeTag = "custom_auth";
        activity.SetTag(authLikeTag, "sample-auth");
        activity.SetTag("ignoredObject", new object());
        activity.Start();
        activity.Stop();

        var captured = LogBrewActivitySpanTelemetry.Capture(
            client,
            activity,
            LogBrewActivitySpanOptions.Create()
                .WithEventIdPrefix("dotnet_activity")
                .WithTimestampProvider(() => "2026-06-02T10:00:13Z")
                .WithMetadata(new Dictionary<string, object?>
                {
                    ["safe"] = true,
                    ["url"] = "https://shop.example/private?card=sample",
                    ["headers"] = "Author" + "ization: Bear" + "er sample",
                    ["body"] = "card=sample",
                    ["ignored"] = new object()
                }));

        Require(captured, "expected valid Activity to be captured");
        Require(client.PendingEvents() == 1, "expected one Activity span event");
        var payload = client.PreviewJson();
        foreach (var expected in new[]
        {
            "\"id\": \"dotnet_activity_span_" + activity.SpanId.ToHexString() + "\"",
            "\"name\": \"checkout.activity\"",
            "\"traceId\": \"" + IncomingTraceId + "\"",
            "\"spanId\": \"" + activity.SpanId.ToHexString() + "\"",
            "\"parentSpanId\": \"" + IncomingParentSpanId + "\"",
            "\"status\": \"error\"",
            "\"source\": \"dotnet.activity\"",
            "\"activityName\": \"checkout.activity\"",
            "\"activityKind\": \"internal\"",
            "\"traceFlags\": \"01\"",
            "\"traceSampled\": true",
            "\"httpMethod\": \"POST\"",
            "\"httpRoute\": \"/checkout/:cart_id\"",
            "\"httpStatusCode\": 503",
            "\"dbSystem\": \"postgresql\"",
            "\"messagingSystem\": \"kafka\"",
            "\"safe\": true"
        })
        {
            Require(payload.Contains(expected, StringComparison.Ordinal), "missing Activity span payload: " + expected);
        }

        foreach (var blocked in new[] { "shop" + ".example", "card=sample", "Author" + "ization", "Bear" + "er", "headers", "body", "\"url\"", authLikeTag, "ignoredObject", "\"ignored\"" })
        {
            Require(!payload.Contains(blocked, StringComparison.Ordinal), "expected unsafe Activity metadata to be omitted: " + blocked);
        }
    }

    private static void CaptureCopiesActivityEventsAndLinksSafely()
    {
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "activity-tests", "0.1.0");
        using var activity = new Activity("checkout.activity.rich");
        activity.SetIdFormat(ActivityIdFormat.W3C);
        activity.SetParentId(
            ActivityTraceId.CreateFromString(IncomingTraceId.AsSpan()),
            ActivitySpanId.CreateFromString(IncomingParentSpanId.AsSpan()),
            ActivityTraceFlags.Recorded);
        activity.ActivityTraceFlags = ActivityTraceFlags.Recorded;
        activity.Start();
        activity.AddEvent(new ActivityEvent(
            "exception",
            new DateTimeOffset(2026, 06, 02, 10, 00, 15, TimeSpan.Zero),
            new ActivityTagsCollection
            {
                { "exception.type", "System.InvalidOperationException" },
                { "exception.message", "card=sample" },
                { "exception.stacktrace", "at private path" },
                { "http.response.status_code", 503 },
                { "request.body", "card=sample" }
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
                { "messaging.message.id", "msg-" + "sample" },
                { "http.url", "https://shop.example/checkout?card=sample" }
            }));
        activity.Stop();

        var captured = LogBrewActivitySpanTelemetry.Capture(
            client,
            activity,
            LogBrewActivitySpanOptions.Create()
                .WithEventIdPrefix("dotnet_activity")
                .WithTimestampProvider(() => "2026-06-02T10:00:15Z"));

        Require(captured, "expected rich Activity to be captured");
        var payload = client.PreviewJson();
        foreach (var expected in new[]
        {
            "\"events\": [",
            "\"name\": \"exception\"",
            "\"timestamp\": \"2026-06-02T10:00:15.0000000+00:00\"",
            "\"exceptionType\": \"System.InvalidOperationException\"",
            "\"httpStatusCode\": 503",
            "\"links\": [",
            "\"traceId\": \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"",
            "\"spanId\": \"bbbbbbbbbbbbbbbb\"",
            "\"sampled\": true",
            "\"messagingSystem\": \"kafka\"",
            "\"messagingOperation\": \"process\""
        })
        {
            Require(payload.Contains(expected, StringComparison.Ordinal), "missing rich Activity payload: " + expected);
        }

        foreach (var blocked in new[] { "card=sample", "private path", "msg-" + "sample", "shop.example", "vendor=sample", "exception.message", "exception.stacktrace", "request.body", "http.url" })
        {
            Require(!payload.Contains(blocked, StringComparison.Ordinal), "expected unsafe rich Activity data to be omitted: " + blocked);
        }
    }

    private static void CaptureCopiesExplicitResourceContextSafely()
    {
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "activity-tests", "0.1.0");
        using var activity = new Activity("checkout.resource");
        activity.SetIdFormat(ActivityIdFormat.W3C);
        activity.SetParentId(
            ActivityTraceId.CreateFromString(IncomingTraceId.AsSpan()),
            ActivitySpanId.CreateFromString(IncomingParentSpanId.AsSpan()),
            ActivityTraceFlags.Recorded);
        activity.Start();
        activity.Stop();

        var captured = LogBrewActivitySpanTelemetry.Capture(
            client,
            activity,
            LogBrewActivitySpanOptions.Create()
                .WithEventIdPrefix("dotnet_activity_resource")
                .WithTimestampProvider(() => "2026-06-02T10:00:16Z")
                .WithServiceName("checkout-api")
                .WithServiceVersion("1.2.3")
                .WithDeploymentEnvironment("production"));

        Require(captured, "expected Activity with resource context to be captured");
        var payload = client.PreviewJson();
        foreach (var expected in new[]
        {
            "\"id\": \"dotnet_activity_resource_span_" + activity.SpanId.ToHexString() + "\"",
            "\"serviceName\": \"checkout-api\"",
            "\"serviceVersion\": \"1.2.3\"",
            "\"deploymentEnvironment\": \"production\""
        })
        {
            Require(payload.Contains(expected, StringComparison.Ordinal), "missing Activity resource context: " + expected);
        }

        RequireThrows<SdkException>(
            () => LogBrewActivitySpanOptions.Create().WithServiceName("https://shop.example/checkout?cred=sample"),
            "expected unsafe service name validation");
        RequireThrows<SdkException>(
            () => LogBrewActivitySpanOptions.Create().WithDeploymentEnvironment("prod\nwest"),
            "expected unsafe deployment environment validation");
    }

    private static void CaptureCopiesSafeResourceConventionTags()
    {
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "activity-tests", "0.1.0");
        using var activity = new Activity("checkout.resource.tags");
        activity.SetIdFormat(ActivityIdFormat.W3C);
        activity.SetParentId(
            ActivityTraceId.CreateFromString(IncomingTraceId.AsSpan()),
            ActivitySpanId.CreateFromString(IncomingParentSpanId.AsSpan()),
            ActivityTraceFlags.Recorded);
        activity.SetTag("service.name", "checkout-api");
        activity.SetTag("service.version", "1.2.3");
        activity.SetTag("deployment.environment.name", "production");
        activity.SetTag("deployment.environment", "legacy-prod");
        activity.SetTag("telemetry.sdk.name", "opentelemetry");
        activity.SetTag("service.instance.id", "instance-opaque-marker");
        activity.SetTag("process.command_line", "dotnet checkout --opaque-marker=value");
        activity.Start();
        activity.Stop();

        var captured = LogBrewActivitySpanTelemetry.Capture(
            client,
            activity,
            LogBrewActivitySpanOptions.Create()
                .WithEventIdPrefix("dotnet_activity_resource_tags")
                .WithTimestampProvider(() => "2026-06-02T10:00:17Z"));

        Require(captured, "expected Activity with safe resource tags to be captured");
        var payload = client.PreviewJson();
        foreach (var expected in new[]
        {
            "\"id\": \"dotnet_activity_resource_tags_span_" + activity.SpanId.ToHexString() + "\"",
            "\"serviceName\": \"checkout-api\"",
            "\"serviceVersion\": \"1.2.3\"",
            "\"deploymentEnvironment\": \"production\"",
            "\"telemetrySdkName\": \"opentelemetry\""
        })
        {
            Require(payload.Contains(expected, StringComparison.Ordinal), "missing safe resource tag: " + expected);
        }

        foreach (var blocked in new[] { "legacy-prod", "instance-opaque-marker", "process.command_line", "--opaque-marker=value" })
        {
            Require(!payload.Contains(blocked, StringComparison.Ordinal), "expected unsafe resource tag to be omitted: " + blocked);
        }
    }

    private static void CaptureIgnoresInvalidActivity()
    {
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "activity-tests", "0.1.0");
        Require(!LogBrewActivitySpanTelemetry.Capture(client, null), "expected null Activity to be ignored");

        using var unstarted = new Activity("checkout.unstarted");
        unstarted.SetIdFormat(ActivityIdFormat.W3C);
        Require(!LogBrewActivitySpanTelemetry.Capture(client, unstarted), "expected unstarted Activity to be ignored");

        using var hierarchical = new Activity("checkout.hierarchical");
        hierarchical.SetIdFormat(ActivityIdFormat.Hierarchical);
        hierarchical.Start();
        hierarchical.Stop();
        Require(!LogBrewActivitySpanTelemetry.Capture(client, hierarchical), "expected non-W3C Activity to be ignored");
        Require(client.PendingEvents() == 0, "expected invalid Activities to skip telemetry");
    }

    private static void CaptureFailureReportsErrorWithoutThrowing()
    {
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "activity-tests", "0.1.0");
        using var activity = new Activity("checkout.activity");
        activity.SetIdFormat(ActivityIdFormat.W3C);
        activity.SetParentId(
            ActivityTraceId.CreateFromString(IncomingTraceId.AsSpan()),
            ActivitySpanId.CreateFromString(IncomingParentSpanId.AsSpan()),
            ActivityTraceFlags.Recorded);
        activity.Start();
        activity.Stop();
        var errors = 0;

        var captured = LogBrewActivitySpanTelemetry.Capture(
            client,
            activity,
            LogBrewActivitySpanOptions.Create()
                .WithTimestampProvider(() => "not-a-timestamp")
                .OnError(_ => errors++));

        Require(!captured, "expected invalid event id capture to return false");
        Require(errors == 1, "expected capture failure to be reported once");
        Require(client.PendingEvents() == 0, "expected failed capture to leave queue empty");
    }

    private static void CaptureValidatesInputs()
    {
        RequireThrows<ArgumentNullException>(() => LogBrewActivitySpanTelemetry.Capture(null!, null), "expected null client validation");
        RequireThrows<SdkException>(() => LogBrewActivitySpanOptions.Create().WithEventIdPrefix(" "), "expected event id prefix validation");
        RequireThrows<ArgumentNullException>(() => LogBrewActivitySpanOptions.Create().WithTimestampProvider(null!), "expected timestamp provider validation");
        RequireThrows<ArgumentNullException>(() => LogBrewActivitySpanOptions.Create().OnError(null!), "expected error handler validation");
    }

    private static void Require(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException(message);
        }
    }

    private static void RequireThrows<TException>(Action action, string message)
        where TException : Exception
    {
        try
        {
            action();
        }
        catch (TException)
        {
            return;
        }

        throw new InvalidOperationException(message);
    }
}
