using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using LogBrew;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.Routing.Patterns;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

const string IncomingTraceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

var tests = 0;
await AspNetCoreMiddlewareCapturesRequestSpanMetricAndActiveTrace().ConfigureAwait(false);
tests++;
await AspNetCoreMiddlewarePreservesOriginalExceptionAndCapturesIssue().ConfigureAwait(false);
tests++;
await AspNetCoreMiddlewareRouteSelectorStripsAbsoluteUrls().ConfigureAwait(false);
tests++;
await AspNetCoreMiddlewareFilterSkipsTelemetryAndTraceHeaderInjection().ConfigureAwait(false);
tests++;
Console.WriteLine("dotnet aspnetcore package tests ok (" + tests.ToString(System.Globalization.CultureInfo.InvariantCulture) + " tests)");

static async Task AspNetCoreMiddlewareCapturesRequestSpanMetricAndActiveTrace()
{
    var client = LogBrewClient.Create("LOGBREW_API_KEY", "aspnetcore-middleware-tests", "0.1.0");
    var app = CreateApplicationBuilder();
    app.UseLogBrewRequestTelemetry(
        client,
        options => options
            .WithEventIdPrefix("dotnet_aspnetcore")
            .WithTimestampProvider(() => "2026-06-02T10:00:36Z")
            .WithMetadataProvider(context => new Dictionary<string, object?>
            {
                ["framework"] = "aspnetcore",
                ["endpointName"] = context.GetEndpoint()?.DisplayName,
                ["query"] = "coupon=dropme",
                ["headers"] = "traceparent=" + IncomingTraceparent,
                ["ignoredObject"] = new object()
            }));
    app.Run(context =>
    {
        Require(LogBrewTrace.Current != null, "expected middleware to activate request trace");
        Require(LogBrewTrace.Current!.TraceId == "4bf92f3577b34da6a3ce929d0e0e4736", "expected incoming W3C trace to continue");
        context.Response.StatusCode = StatusCodes.Status202Accepted;

        using ILoggerFactory loggerFactory = LoggerFactory.Create(builder =>
        {
            builder.AddLogBrew(client, new LogBrewLoggerOptions
            {
                EventIdPrefix = "dotnet_aspnetcore_log",
                TimestampProvider = () => DateTimeOffset.Parse("2026-06-02T10:00:37Z", System.Globalization.CultureInfo.InvariantCulture)
            });
        });
        loggerFactory.CreateLogger("Checkout.AspNetCore").Log(
            LogLevel.Warning,
            new EventId(9, "CheckoutAccepted"),
            new Dictionary<string, object?> { ["cartTier"] = "gold" },
            null,
            static (_, _) => "checkout accepted");
        return Task.CompletedTask;
    });

    var context = CreateHttpContext();
    await app.Build().Invoke(context).ConfigureAwait(false);

    var preview = client.PreviewJson();
    foreach (var expected in new[]
    {
        "\"id\": \"dotnet_aspnetcore_span_",
        "\"id\": \"dotnet_aspnetcore_metric_",
        "\"id\": \"dotnet_aspnetcore_log_",
        "\"name\": \"POST /checkout/{cartId}\"",
        "\"routeTemplate\": \"/checkout/{cartId}\"",
        "\"statusCode\": 202",
        "\"traceId\": \"4bf92f3577b34da6a3ce929d0e0e4736\"",
        "\"parentSpanId\": \"00f067aa0ba902b7\"",
        "\"name\": \"http.server.duration\"",
        "\"source\": \"aspnetcore.request\"",
        "\"framework\": \"aspnetcore\"",
        "\"endpointName\": \"checkout_route\""
    })
    {
        Require(preview.Contains(expected, StringComparison.Ordinal), "missing ASP.NET Core payload: " + expected);
    }

    foreach (var blocked in new[] { "coupon=dropme", IncomingTraceparent, "\"headers\"", "\"query\"", "ignoredObject" })
    {
        Require(!preview.Contains(blocked, StringComparison.Ordinal), "expected middleware payload to omit unsafe value: " + blocked);
    }
}

static async Task AspNetCoreMiddlewarePreservesOriginalExceptionAndCapturesIssue()
{
    var client = LogBrewClient.Create("LOGBREW_API_KEY", "aspnetcore-error-tests", "0.1.0");
    var original = new InvalidOperationException("payment provider failed");
    var app = CreateApplicationBuilder();
    app.UseLogBrewRequestTelemetry(
        client,
        options => options
            .WithEventIdPrefix("dotnet_aspnetcore_error")
            .WithTimestampProvider(() => "2026-06-02T10:00:38Z"));
    app.Run(_ => throw original);

    try
    {
        await app.Build().Invoke(CreateHttpContext()).ConfigureAwait(false);
        throw new InvalidOperationException("expected original exception");
    }
    catch (InvalidOperationException error) when (ReferenceEquals(error, original))
    {
    }

    var preview = client.PreviewJson();
    Require(preview.Contains("\"id\": \"dotnet_aspnetcore_error_issue_", StringComparison.Ordinal), "expected failed request issue");
    Require(preview.Contains("\"id\": \"dotnet_aspnetcore_error_span_", StringComparison.Ordinal), "expected failed request span");
    Require(preview.Contains("\"title\": \"ASP.NET Core request failed\"", StringComparison.Ordinal), "expected issue title");
    Require(preview.Contains("\"exceptionType\": \"System.InvalidOperationException\"", StringComparison.Ordinal), "expected exception type");
    Require(preview.Contains("\"statusCode\": 500", StringComparison.Ordinal), "expected failed request status");
    Require(preview.Contains("\"status\": \"error\"", StringComparison.Ordinal), "expected error span status");
    Require(!preview.Contains("exceptionStackTrace", StringComparison.Ordinal), "middleware must not capture stack traces by default");
}

static async Task AspNetCoreMiddlewareRouteSelectorStripsAbsoluteUrls()
{
    var client = LogBrewClient.Create("LOGBREW_API_KEY", "aspnetcore-selector-tests", "0.1.0");
    var app = CreateApplicationBuilder();
    app.UseLogBrewRequestTelemetry(
        client,
        options => options
            .WithEventIdPrefix("dotnet_aspnetcore_selector")
            .WithTimestampProvider(() => "2026-06-02T10:00:39Z")
            .WithRouteTemplateSelector(_ => "https://api.example.test/custom/{cartId}?coupon=dropme#frag"));
    app.Run(context =>
    {
        context.Response.StatusCode = StatusCodes.Status204NoContent;
        return Task.CompletedTask;
    });

    await app.Build().Invoke(CreateHttpContext()).ConfigureAwait(false);

    var preview = client.PreviewJson();
    Require(preview.Contains("\"name\": \"POST /custom/{cartId}\"", StringComparison.Ordinal), "expected absolute selector to become route path");
    Require(preview.Contains("\"routeTemplate\": \"/custom/{cartId}\"", StringComparison.Ordinal), "expected route template to omit origin/query/fragment");
    foreach (var blocked in new[] { "api.example.test", "coupon=dropme", "#frag" })
    {
        Require(!preview.Contains(blocked, StringComparison.Ordinal), "expected selector payload to omit unsafe value: " + blocked);
    }
}

static async Task AspNetCoreMiddlewareFilterSkipsTelemetryAndTraceHeaderInjection()
{
    var client = LogBrewClient.Create("LOGBREW_API_KEY", "aspnetcore-filter-tests", "0.1.0");
    var app = CreateApplicationBuilder();
    app.UseLogBrewRequestTelemetry(
        client,
        options => options
            .WithEventIdPrefix("dotnet_aspnetcore_filtered")
            .WithRequestFilter(context => context.Request.Path != "/health"));
    app.Run(context =>
    {
        Require(LogBrewTrace.Current == null, "filtered request should not activate LogBrew trace");
        context.Response.StatusCode = StatusCodes.Status204NoContent;
        return Task.CompletedTask;
    });

    var context = CreateHttpContext();
    context.Request.Path = "/health";
    await app.Build().Invoke(context).ConfigureAwait(false);

    Require(client.PendingEvents() == 0, "filtered request should not capture telemetry");
    Require(!context.Request.Headers.ContainsKey("traceparent-out"), "middleware must not inject unrelated headers");
}

static ApplicationBuilder CreateApplicationBuilder()
{
    return new ApplicationBuilder(new ServiceCollection().BuildServiceProvider());
}

static DefaultHttpContext CreateHttpContext()
{
    var context = new DefaultHttpContext();
    context.Request.Method = "POST";
    context.Request.Path = "/checkout/cart_123";
    context.Request.QueryString = new QueryString("?coupon=dropme");
    context.Request.Headers.TraceParent = IncomingTraceparent;
    context.SetEndpoint(new RouteEndpoint(
        _ => Task.CompletedTask,
        RoutePatternFactory.Parse("/checkout/{cartId}"),
        0,
        EndpointMetadataCollection.Empty,
        "checkout_route"));
    return context;
}

static void Require(bool condition, string message)
{
    if (!condition)
    {
        throw new InvalidOperationException(message);
    }
}
