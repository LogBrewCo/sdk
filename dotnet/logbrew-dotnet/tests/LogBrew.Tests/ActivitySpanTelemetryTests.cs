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
