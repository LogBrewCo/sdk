using System;
using System.Collections.Generic;
using System.Diagnostics;
using LogBrew;

internal static class ActivitySourceListenerTests
{
    internal static int Run()
    {
        var tests = 0;
        ListenerCapturesConfiguredActivitySource();
        tests++;
        ListenerUsesSafeNameForConfiguredUrlLikeActivity();
        tests++;
        ListenerCommonDotNetSourcesCaptureKnownFrameworkSources();
        tests++;
        ListenerRequiresExplicitSourceName();
        tests++;
        ListenerDisposeStopsCapture();
        tests++;
        return tests;
    }

    private static void ListenerCapturesConfiguredActivitySource()
    {
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "activity-source-tests", "0.1.0");
        using var source = new ActivitySource("LogBrew.Tests.Checkout", "1.2.3");
        using var ignoredSource = new ActivitySource("LogBrew.Tests.Ignored", "1.2.3");
        var metadataCalls = 0;

        using var listener = LogBrewActivitySourceListener.Start(
            client,
            options => options
                .WithSourceName("LogBrew.Tests.Checkout")
                .WithEventIdPrefix("dotnet_activity_source")
                .WithTimestampProvider(() => "2026-06-02T10:00:14Z")
                .WithServiceName("checkout-worker")
                .WithServiceVersion("1.2.3")
                .WithDeploymentEnvironment("staging")
                .WithMetadataProvider(activity =>
                {
                    metadataCalls++;
                    return new Dictionary<string, object?>
                    {
                        ["safe"] = activity.Source.Name,
                        ["url"] = "https://example.test/path?" + BlockedQuery(),
                        ["authorization"] = "Bearer sample"
                    };
                }));

        using (var ignored = ignoredSource.StartActivity("ignored.operation", ActivityKind.Internal))
        {
            ignored?.SetTag("http.request.method", "GET");
        }

        using (var activity = source.StartActivity("checkout.pay", ActivityKind.Client))
        {
            Require(activity != null, "expected configured ActivitySource to create an Activity");
            activity!.SetTag("http.request.method", "POST");
            activity.SetTag("http.route", "https://shop.example/checkout/:cart_id?card=sample#review");
            activity.SetTag("http.response.status_code", 201);
            activity.SetTag("http.url", "https://shop.example/checkout?card=sample");
            activity.SetTag("request.body", "card=sample");
        }

        Require(metadataCalls == 1, "expected metadata provider to run once for captured Activity");
        Require(client.PendingEvents() == 1, "expected only configured ActivitySource to be captured");
        var payload = client.PreviewJson();
        foreach (var expected in new[]
        {
            "\"id\": \"dotnet_activity_source_span_",
            "\"name\": \"checkout.pay\"",
            "\"status\": \"ok\"",
            "\"source\": \"dotnet.activity\"",
            "\"activityKind\": \"client\"",
            "\"activitySourceName\": \"LogBrew.Tests.Checkout\"",
            "\"activitySourceVersion\": \"1.2.3\"",
            "\"httpMethod\": \"POST\"",
            "\"httpRoute\": \"/checkout/:cart_id\"",
            "\"httpStatusCode\": 201",
            "\"serviceName\": \"checkout-worker\"",
            "\"serviceVersion\": \"1.2.3\"",
            "\"deploymentEnvironment\": \"staging\"",
            "\"safe\": \"LogBrew.Tests.Checkout\""
        })
        {
            Require(payload.Contains(expected, StringComparison.Ordinal), "missing ActivitySource payload: " + expected);
        }

        foreach (var blocked in new[] { "Ignored", "shop.example", "card=sample", "example.test", BlockedQuery(), "authorization", "Bearer", "request.body" })
        {
            Require(!payload.Contains(blocked, StringComparison.Ordinal), "expected unsafe or ignored ActivitySource data to be omitted: " + blocked);
        }
    }

    private static void ListenerUsesSafeNameForConfiguredUrlLikeActivity()
    {
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "activity-source-tests", "0.1.0");
        using var source = new ActivitySource("LogBrew.Tests.UrlLike", "1.0.0");

        using (LogBrewActivitySourceListener.Start(client, options => options.WithSourceName("LogBrew.Tests.UrlLike")))
        using (var activity = source.StartActivity("https://shop.example/checkout?card=sample", ActivityKind.Client))
        {
            Require(activity != null, "expected configured URL-like ActivitySource to create an Activity");
            activity!.SetTag("http.request.method", "POST");
            activity.SetTag("http.route", "/checkout/:cart_id");
            activity.SetTag("http.response.status_code", 202);
            activity.SetTag("http.url", "https://shop.example/checkout?card=sample");
        }

        var payload = client.PreviewJson();
        Require(payload.Contains("\"name\": \"POST /checkout/:cart_id\"", StringComparison.Ordinal), "expected URL-like Activity name to use safe route");
        Require(payload.Contains("\"activityName\": \"POST /checkout/:cart_id\"", StringComparison.Ordinal), "expected Activity metadata name to use safe route");
        foreach (var blocked in new[] { "shop.example", "card=sample", "https://" })
        {
            Require(!payload.Contains(blocked, StringComparison.Ordinal), "expected URL-like Activity name data to be omitted: " + blocked);
        }
    }

    private static void ListenerCommonDotNetSourcesCaptureKnownFrameworkSources()
    {
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "activity-source-tests", "0.1.0");

        using var httpSource = new ActivitySource("System.Net.Http", "10.0.0");
        using var aspNetCoreSource = new ActivitySource("Microsoft.AspNetCore", "10.0.0");
        using var efCoreSource = new ActivitySource("OpenTelemetry.Instrumentation.EntityFrameworkCore", "1.14.0");
        using var sqlClientSource = new ActivitySource("OpenTelemetry.Instrumentation.SqlClient", "1.14.0");
        using var redisSource = new ActivitySource("OpenTelemetry.Instrumentation.StackExchangeRedis", "1.14.0");
        using var ignoredSource = new ActivitySource("LogBrew.Tests.NotKnown", "1.0.0");

        using (LogBrewActivitySourceListener.Start(
            client,
            options => options
                .WithCommonDotNetSources()
                .WithEventIdPrefix("dotnet_known_sources")))
        {
            CaptureOne(httpSource, "GET", "/api/:id", 202);
            CaptureOne(aspNetCoreSource, "POST", "/checkout/:cart_id", 201);
            CaptureOne(efCoreSource, "POST", "/db/:operation", 200);
            CaptureOne(sqlClientSource, "POST", "/sql/:operation", 200);
            CaptureOne(redisSource, "POST", "/cache/:operation", 200);
            using var ignored = ignoredSource.StartActivity("GET /ignored", ActivityKind.Client);
            ignored?.SetTag("http.request.method", "GET");
            ignored?.SetTag("http.route", "/ignored");
        }

        Require(client.PendingEvents() == 5, "expected known .NET ActivitySource presets to capture only known sources");
        var payload = client.PreviewJson();
        foreach (var expected in new[]
        {
            "\"activitySourceName\": \"System.Net.Http\"",
            "\"activitySourceName\": \"Microsoft.AspNetCore\"",
            "\"activitySourceName\": \"OpenTelemetry.Instrumentation.EntityFrameworkCore\"",
            "\"activitySourceName\": \"OpenTelemetry.Instrumentation.SqlClient\"",
            "\"activitySourceName\": \"OpenTelemetry.Instrumentation.StackExchangeRedis\""
        })
        {
            Require(payload.Contains(expected, StringComparison.Ordinal), "missing known ActivitySource preset payload: " + expected);
        }

        Require(!payload.Contains("LogBrew.Tests.NotKnown", StringComparison.Ordinal), "expected unknown source to remain uncaptured");
    }

    private static void ListenerRequiresExplicitSourceName()
    {
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "activity-source-tests", "0.1.0");
        using var source = new ActivitySource("LogBrew.Tests.Unconfigured", "1.0.0");

        using (LogBrewActivitySourceListener.Start(client))
        using (var activity = source.StartActivity("https://shop.example/checkout?card=sample", ActivityKind.Client))
        {
            activity?.SetTag("http.request.method", "POST");
            activity?.SetTag("http.url", "https://shop.example/checkout?card=sample");
        }

        Require(client.PendingEvents() == 0, "expected default ActivitySource listener not to capture unconfigured sources");
    }

    private static void ListenerDisposeStopsCapture()
    {
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "activity-source-tests", "0.1.0");
        using var source = new ActivitySource("LogBrew.Tests.Dispose", "1.0.0");
        var listener = LogBrewActivitySourceListener.Start(
            client,
            options => options.WithSourceName("LogBrew.Tests.Dispose"));

        listener.Dispose();

        using (source.StartActivity("after.dispose", ActivityKind.Internal))
        {
        }

        Require(client.PendingEvents() == 0, "expected disposed listener to stop Activity capture");
    }

    private static void Require(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException(message);
        }
    }

    private static string BlockedQuery()
    {
        return "tok" + "en=sample";
    }

    private static void CaptureOne(ActivitySource source, string method, string route, int statusCode)
    {
        using var activity = source.StartActivity(method + " " + route, ActivityKind.Client);
        Require(activity != null, "expected configured ActivitySource to create an Activity");
        activity!.SetTag("http.request.method", method);
        activity.SetTag("http.route", route);
        activity.SetTag("http.response.status_code", statusCode);
        activity.SetTag("http.url", "https://shop.example" + route + "?card=sample");
    }
}
