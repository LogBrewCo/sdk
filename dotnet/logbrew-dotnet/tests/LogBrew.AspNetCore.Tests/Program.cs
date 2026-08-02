using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Threading;
using System.Threading.Tasks;
using LogBrew;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.Routing.Patterns;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
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
await AspNetCoreMiddlewareUnmatchedRouteDoesNotCaptureRawPath().ConfigureAwait(false);
tests++;
AspNetCoreDependencyActivitySourceTelemetryCapturesAndDisposesWithHostLifetime();
tests++;
await AspNetCoreServicesHostedDependencyActivitySourceTelemetryStartsAndStops().ConfigureAwait(false);
tests++;
await AspNetCoreAutomaticIntegrationDisablesSafelyAndRegistersOnce().ConfigureAwait(false);
tests++;
await AspNetCoreAutomaticIntegrationDisablesWhenKeyIsMissing().ConfigureAwait(false);
tests++;
AspNetCoreAutomaticIntegrationRejectsAmbiguousLegacyKey();
tests++;
AspNetCoreAutomaticIntegrationRejectsNonLoopbackHttpEndpoint();
tests++;
AspNetCoreAutomaticIntegrationDisposesOwnedTransportOnConfigurationFailure();
tests++;
await AspNetCoreAutomaticIntegrationOwnsDeliveryLoggingRequestsHealthAndShutdown().ConfigureAwait(false);
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
    Require(preview.Contains("\"exception\"", StringComparison.Ordinal), "expected typed exception diagnostics");
    Require(preview.Contains("\"type\": \"System.InvalidOperationException\"", StringComparison.Ordinal), "expected typed exception identity");
    Require(preview.Contains("\"type\": \"aspnetcore.middleware\"", StringComparison.Ordinal), "expected ASP.NET Core exception mechanism");
    Require(preview.Contains("\"handled\": false", StringComparison.Ordinal), "expected escaped exception handled state");
    Require(preview.Contains("\"stackFrames\"", StringComparison.Ordinal), "expected bounded structured frames");
    Require(preview.Contains("\"statusCode\": 500", StringComparison.Ordinal), "expected failed request status");
    Require(preview.Contains("\"status\": \"error\"", StringComparison.Ordinal), "expected error span status");
    Require(!preview.Contains("exceptionStackTrace", StringComparison.Ordinal), "middleware must not capture stack traces by default");
    Require(!preview.Contains("payment provider failed", StringComparison.Ordinal), "middleware must not copy the raw exception message");
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

static async Task AspNetCoreMiddlewareUnmatchedRouteDoesNotCaptureRawPath()
{
    var client = LogBrewClient.Create("LOGBREW_API_KEY", "aspnetcore-unmatched-tests", "0.1.0");
    var app = CreateApplicationBuilder();
    app.UseLogBrewRequestTelemetry(
        client,
        options => options
            .WithEventIdPrefix("dotnet_aspnetcore_unmatched")
            .WithTimestampProvider(() => "2026-06-02T10:00:40Z"));
    app.Run(context =>
    {
        context.Response.StatusCode = StatusCodes.Status404NotFound;
        return Task.CompletedTask;
    });

    var context = new DefaultHttpContext();
    context.Request.Method = "GET";
    context.Request.Path = "/profiles/profile_123";
    context.Request.QueryString = new QueryString("?coupon=dropme");
    await app.Build().Invoke(context).ConfigureAwait(false);

    var preview = client.PreviewJson();
    Require(preview.Contains("\"name\": \"GET /unmatched\"", StringComparison.Ordinal), "expected stable unmatched route");
    foreach (var blocked in new[] { "profile_123", "coupon=dropme" })
    {
        Require(!preview.Contains(blocked, StringComparison.Ordinal), "unmatched request payload leaked: " + blocked);
    }
}

static ApplicationBuilder CreateApplicationBuilder()
{
    return new ApplicationBuilder(new ServiceCollection().BuildServiceProvider());
}

static void AspNetCoreDependencyActivitySourceTelemetryCapturesAndDisposesWithHostLifetime()
{
    using var lifetime = new LogBrew.AspNetCore.Tests.TestHostApplicationLifetime();
    var services = new ServiceCollection();
    services.AddSingleton<IHostApplicationLifetime>(lifetime);
    using var serviceProvider = services.BuildServiceProvider();
    var app = new ApplicationBuilder(serviceProvider);
    var client = LogBrewClient.Create("LOGBREW_API_KEY", "aspnetcore-activity-sources", "0.1.0");

    app.UseLogBrewDependencyActivitySourceTelemetry(
        client,
        options => options
            .WithEventIdPrefix("dotnet_aspnetcore_activity")
            .WithTimestampProvider(() => "2026-06-02T10:00:42Z")
            .WithMetadataProvider(activity => new Dictionary<string, object?>
            {
                ["framework"] = "aspnetcore",
                ["activitySource"] = activity.Source.Name,
                ["fullUrl"] = "https://shop.example/checkout?card=dropme",
                ["ignoredObject"] = new object()
            }));

    using var source = new ActivitySource("System.Net.Http", "10.0.0");
    using (var activity = source.StartActivity(
        "https://shop.example/checkout?card=dropme",
        ActivityKind.Client))
    {
        Require(activity != null, "expected ASP.NET Core extension to enable dependency ActivitySource listener");
        activity!.SetTag("http.request.method", "POST");
        activity.SetTag("http.route", "https://shop.example/checkout/:cart_id?card=dropme#review");
        activity.SetTag("http.response.status_code", 202);
        activity.SetTag("request.body", "card=dropme");
    }

    var preview = client.PreviewJson();
    foreach (var expected in new[]
    {
        "\"id\": \"dotnet_aspnetcore_activity_span_",
        "\"source\": \"dotnet.activity\"",
        "\"activitySourceName\": \"System.Net.Http\"",
        "\"activitySourceVersion\": \"10.0.0\"",
        "\"httpMethod\": \"POST\"",
        "\"httpRoute\": \"/checkout/:cart_id\"",
        "\"httpStatusCode\": 202",
        "\"framework\": \"aspnetcore\"",
        "\"activitySource\": \"System.Net.Http\""
    })
    {
        Require(preview.Contains(expected, StringComparison.Ordinal), "missing ASP.NET Core ActivitySource payload: " + expected);
    }

    foreach (var blocked in new[] { "card=dropme", "shop.example", "fullUrl", "ignoredObject", "request.body" })
    {
        Require(!preview.Contains(blocked, StringComparison.Ordinal), "expected ActivitySource payload to omit unsafe value: " + blocked);
    }

    var capturedEvents = client.PendingEvents();
    lifetime.StopApplication();
    using (var afterStop = source.StartActivity("after.stop", ActivityKind.Client))
    {
        afterStop?.SetTag("http.request.method", "GET");
    }

    Require(client.PendingEvents() == capturedEvents, "expected host lifetime stop to dispose ActivitySource listener");
}

static async Task AspNetCoreServicesHostedDependencyActivitySourceTelemetryStartsAndStops()
{
    var services = new ServiceCollection();
    var client = LogBrewClient.Create("LOGBREW_API_KEY", "aspnetcore-hosted-activity-sources", "0.1.0");
    services.AddLogBrewDependencyActivitySourceTelemetry(
        client,
        options => options
            .WithEventIdPrefix("dotnet_aspnetcore_hosted_activity")
            .WithTimestampProvider(() => "2026-06-02T10:00:43Z")
            .WithMetadataProvider(activity => new Dictionary<string, object?>
            {
                ["framework"] = "aspnetcore",
                ["activitySource"] = activity.Source.Name,
                ["fullUrl"] = "https://shop.example/checkout?card=dropme",
                ["ignoredObject"] = new object()
            }));

    using var serviceProvider = services.BuildServiceProvider();
    IHostedService? hostedService = null;
    foreach (var service in serviceProvider.GetServices<IHostedService>())
    {
        Require(hostedService == null, "expected a single LogBrew hosted ActivitySource service");
        hostedService = service;
    }

    Require(hostedService != null, "expected hosted ActivitySource service registration");
    await hostedService!.StartAsync(CancellationToken.None).ConfigureAwait(false);
    using var source = new ActivitySource("System.Net.Http", "10.0.0");
    using (var activity = source.StartActivity(
        "https://shop.example/checkout?card=dropme",
        ActivityKind.Client))
    {
        Require(activity != null, "expected hosted service to enable dependency ActivitySource listener");
        activity!.SetTag("http.request.method", "POST");
        activity.SetTag("http.route", "https://shop.example/checkout/:cart_id?card=dropme#review");
        activity.SetTag("http.response.status_code", 202);
        activity.SetTag("request.body", "card=dropme");
    }

    var preview = client.PreviewJson();
    foreach (var expected in new[]
    {
        "\"id\": \"dotnet_aspnetcore_hosted_activity_span_",
        "\"source\": \"dotnet.activity\"",
        "\"activitySourceName\": \"System.Net.Http\"",
        "\"activitySourceVersion\": \"10.0.0\"",
        "\"httpMethod\": \"POST\"",
        "\"httpRoute\": \"/checkout/:cart_id\"",
        "\"httpStatusCode\": 202",
        "\"framework\": \"aspnetcore\"",
        "\"activitySource\": \"System.Net.Http\""
    })
    {
        Require(preview.Contains(expected, StringComparison.Ordinal), "missing hosted ASP.NET Core ActivitySource payload: " + expected);
    }

    foreach (var blocked in new[] { "card=dropme", "shop.example", "fullUrl", "ignoredObject", "request.body" })
    {
        Require(!preview.Contains(blocked, StringComparison.Ordinal), "expected hosted ActivitySource payload to omit unsafe value: " + blocked);
    }

    var capturedEvents = client.PendingEvents();
    await hostedService.StopAsync(CancellationToken.None).ConfigureAwait(false);
    using (var afterStop = source.StartActivity("after.stop", ActivityKind.Client))
    {
        afterStop?.SetTag("http.request.method", "GET");
    }

    Require(client.PendingEvents() == capturedEvents, "expected hosted service stop to dispose ActivitySource listener");
}

static async Task AspNetCoreAutomaticIntegrationDisablesSafelyAndRegistersOnce()
{
    var builder = WebApplication.CreateBuilder(new WebApplicationOptions
    {
        ApplicationName = typeof(Program).Assembly.GetName().Name,
        EnvironmentName = "Testing"
    });
    builder.Logging.ClearProviders();
    builder.AddLogBrew(options => options
        .WithEnabled(false)
        .WithServiceName(string.Empty)
        .WithEndpoint(new Uri("/ignored-while-disabled", UriKind.Relative)));
    builder.AddLogBrew(options => options.WithEnabled(false));

    Require(
        builder.Services.Count(descriptor => descriptor.ServiceType == typeof(LogBrewAspNetCoreRuntime)) == 1,
        "repeated ASP.NET Core registration must keep one runtime");
    Require(
        builder.Services.Count(descriptor => descriptor.ServiceType == typeof(IHostedService)) == 1,
        "repeated ASP.NET Core registration must keep one hosted lifecycle");

    var app = builder.Build();
    try
    {
        var runtime = app.Services.GetRequiredService<LogBrewAspNetCoreRuntime>();
        Require(!runtime.Enabled, "explicitly disabled integration must stay disabled");
        Require(runtime.Client == null, "disabled integration must not create a client");
        var health = runtime.Health();
        Require(health.State == "disabled", "disabled integration must report disabled state");
        Require(health.DisabledReason == "explicitly_disabled", "disabled integration must explain why it is disabled");
        app.UseLogBrew();
    }
    finally
    {
        await app.DisposeAsync().ConfigureAwait(false);
    }
}

static async Task AspNetCoreAutomaticIntegrationDisablesWhenKeyIsMissing()
{
    var names = new[]
    {
        "LOGBREW_ENABLED",
        "LOGBREW_SERVER_API_KEY",
        "LOGBREW_API_KEY",
        "LOGBREW_INGEST_KEY"
    };
    var previous = names.ToDictionary(name => name, Environment.GetEnvironmentVariable, StringComparer.Ordinal);
    WebApplication? app = null;
    try
    {
        foreach (var name in names)
        {
            Environment.SetEnvironmentVariable(name, null);
        }

        var builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            ApplicationName = typeof(Program).Assembly.GetName().Name,
            EnvironmentName = "Testing"
        });
        builder.Logging.ClearProviders();
        builder.AddLogBrew();
        app = builder.Build();

        var runtime = app.Services.GetRequiredService<LogBrewAspNetCoreRuntime>();
        Require(!runtime.Enabled, "missing key must disable the integration safely");
        Require(runtime.Client == null, "missing key must not create a delivery client");
        Require(
            runtime.Health().DisabledReason == "missing_server_api_key",
            "missing-key health must explain the disabled state");
        app.UseLogBrew();
    }
    finally
    {
        if (app != null)
        {
            await app.DisposeAsync().ConfigureAwait(false);
        }

        foreach (var item in previous)
        {
            Environment.SetEnvironmentVariable(item.Key, item.Value);
        }
    }
}

static void AspNetCoreAutomaticIntegrationRejectsAmbiguousLegacyKey()
{
    var names = new[]
    {
        "LOGBREW_ENABLED",
        "LOGBREW_SERVER_API_KEY",
        "LOGBREW_API_KEY",
        "LOGBREW_INGEST_KEY"
    };
    var previous = names.ToDictionary(name => name, Environment.GetEnvironmentVariable, StringComparer.Ordinal);
    try
    {
        Environment.SetEnvironmentVariable("LOGBREW_ENABLED", null);
        Environment.SetEnvironmentVariable("LOGBREW_SERVER_API_KEY", null);
        Environment.SetEnvironmentVariable("LOGBREW_API_KEY", "legacy-test-value");
        Environment.SetEnvironmentVariable("LOGBREW_INGEST_KEY", null);
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            ApplicationName = typeof(Program).Assembly.GetName().Name,
            EnvironmentName = "Testing"
        });

        try
        {
            builder.AddLogBrew();
            throw new InvalidOperationException("expected legacy key configuration to fail");
        }
        catch (SdkException error) when (error.Code == "configuration_error")
        {
            Require(
                error.DetailMessage.Contains("LOGBREW_SERVER_API_KEY", StringComparison.Ordinal),
                "legacy key recovery must name the canonical server key");
            Require(
                !error.DetailMessage.Contains("legacy-test-value", StringComparison.Ordinal),
                "legacy key recovery must not echo the key value");
        }
    }
    finally
    {
        foreach (var item in previous)
        {
            Environment.SetEnvironmentVariable(item.Key, item.Value);
        }
    }
}

static void AspNetCoreAutomaticIntegrationRejectsNonLoopbackHttpEndpoint()
{
    foreach (var endpoint in new[]
    {
        new Uri("http://telemetry.example.test/v1/events", UriKind.Absolute),
        new Uri("/v1/events", UriKind.Relative),
        new Uri("https://api.example.test/v1/events?coupon=dropme", UriKind.Absolute)
    })
    {
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            ApplicationName = typeof(Program).Assembly.GetName().Name,
            EnvironmentName = "Testing"
        });

        try
        {
            builder.AddLogBrew(options => options
                .WithServerApiKey("local-test-project-key")
                .WithEndpoint(endpoint));
            throw new InvalidOperationException("expected unsafe endpoint to fail");
        }
        catch (SdkException error) when (error.Code == "configuration_error")
        {
            Require(
                error.DetailMessage.Contains("https", StringComparison.Ordinal),
                "unsafe endpoint recovery must require HTTPS or loopback HTTP");
            Require(
                !error.DetailMessage.Contains("local-test-project-key", StringComparison.Ordinal),
                "endpoint recovery must not echo the key value");
            Require(
                !error.DetailMessage.Contains("dropme", StringComparison.Ordinal),
                "endpoint recovery must not echo query material");
        }
    }
}

static void AspNetCoreAutomaticIntegrationDisposesOwnedTransportOnConfigurationFailure()
{
    using var transport = new LogBrew.AspNetCore.Tests.DisposableRecordingTransport();
    var builder = WebApplication.CreateBuilder(new WebApplicationOptions
    {
        ApplicationName = typeof(Program).Assembly.GetName().Name,
        EnvironmentName = "Testing"
    });

    try
    {
        builder.AddLogBrew(options => options
            .WithServerApiKey("local-test-project-key")
            .WithTransport(transport, disposeOnShutdown: true)
            .ConfigureDelivery(delivery => delivery.FlushInterval = TimeSpan.Zero));
        throw new InvalidOperationException("expected invalid delivery configuration to fail");
    }
    catch (SdkException error) when (error.Code == "validation_error")
    {
        Require(transport.Disposed, "failed runtime creation must dispose its owned transport");
    }
}

static async Task AspNetCoreAutomaticIntegrationOwnsDeliveryLoggingRequestsHealthAndShutdown()
{
    var transport = RecordingTransport.AlwaysAccept();
    var builder = WebApplication.CreateBuilder(new WebApplicationOptions
    {
        ApplicationName = typeof(Program).Assembly.GetName().Name,
        EnvironmentName = "Testing"
    });
    builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, 0));
    builder.Logging.ClearProviders();
    builder.AddLogBrew(options => options
        .WithServerApiKey("local-test-project-key")
        .WithServiceName("checkout-aspnetcore")
        .WithRelease("1.2.3")
        .WithEnvironment("integration")
        .WithTransport(transport)
        .WithTimestampProvider(() => DateTimeOffset.Parse(
            "2026-06-02T10:00:44Z",
            System.Globalization.CultureInfo.InvariantCulture))
        .ConfigureDelivery(delivery =>
        {
            delivery.FlushAtQueueSize = 100;
            delivery.FlushInterval = TimeSpan.FromMinutes(5);
        })
        .ConfigureLogging(logging =>
        {
            logging.EventIdPrefix = "aspnetcore_application_log";
            logging.TimestampProvider = () => DateTimeOffset.Parse(
                "2026-06-02T10:00:45Z",
                System.Globalization.CultureInfo.InvariantCulture);
        })
        .ConfigureRequestTelemetry(request => request
            .WithEventIdPrefix("aspnetcore_automatic_request")
            .WithTimestampProvider(() => "2026-06-02T10:00:46Z")));

    var app = builder.Build();
    try
    {
        app.UseRouting();
        app.UseLogBrew();
        app.MapGet("/orders/{orderId}", (ILogger<Program> logger, string orderId) =>
        {
            _ = orderId;
            logger.Log(
                LogLevel.Information,
                new EventId(0, "NoisyInformation"),
                "noisy information",
                null,
                static (state, _) => state);
            logger.Log(
                LogLevel.Warning,
                new EventId(0, "OrderAccepted"),
                "order accepted",
                null,
                static (state, _) => state);
            return Results.Accepted();
        });

        await app.StartAsync().ConfigureAwait(false);
        var runtime = app.Services.GetRequiredService<LogBrewAspNetCoreRuntime>();
        Require(runtime.Enabled, "configured integration must be enabled");
        Require(runtime.Client != null, "enabled integration must expose its client for app-owned telemetry");
        Require(runtime.Health().State == "running", "started integration must report running state");

        var server = app.Services.GetRequiredService<IServer>();
        var addresses = server.Features.Get<IServerAddressesFeature>();
        var address = addresses?.Addresses.SingleOrDefault();
        Require(!string.IsNullOrWhiteSpace(address), "Kestrel test server must expose one address");
        using var httpClient = new HttpClient();
        using var request = new HttpRequestMessage(
            HttpMethod.Get,
            address + "/orders/order_123?coupon=dropme");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", "dropme");
        request.Headers.TryAddWithoutValidation("Cookie", "session=dropme");
        using var response = await httpClient.SendAsync(request).ConfigureAwait(false);
        Require(response.StatusCode == HttpStatusCode.Accepted, "instrumented app must preserve the response");

        await app.StopAsync().ConfigureAwait(false);
        var body = string.Join("\n", transport.SentBodies);
        foreach (var expected in new[]
        {
            "\"type\": \"environment\"",
            "\"type\": \"release\"",
            "\"type\": \"log\"",
            "\"type\": \"span\"",
            "\"type\": \"metric\"",
            "\"name\": \"GET /orders/{orderId}\"",
            "\"name\": \"http.server.duration\"",
            "\"logger\": \"Program\"",
            "order accepted",
            "\"statusCode\": 202"
        })
        {
            Require(body.Contains(expected, StringComparison.Ordinal), "missing automatic ASP.NET Core payload: " + expected);
        }

        foreach (var blocked in new[]
        {
            "order_123",
            "coupon=dropme",
            "Bearer",
            "session=dropme",
            "local-test-project-key",
            "noisy information"
        })
        {
            Require(!body.Contains(blocked, StringComparison.Ordinal), "automatic ASP.NET Core payload leaked: " + blocked);
        }

        var stoppedHealth = runtime.Health();
        Require(stoppedHealth.State == "stopped", "host stop must report stopped state");
        Require(stoppedHealth.LastShutdownStatusCode == 202, "host stop must expose the accepted shutdown status");
        Require(
            stoppedHealth.Delivery?.Lifecycle == DeliveryLifecycleState.Closed,
            "host stop must close automatic delivery");
    }
    finally
    {
        await app.DisposeAsync().ConfigureAwait(false);
    }
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

namespace LogBrew.AspNetCore.Tests
{
    internal sealed class DisposableRecordingTransport : ITransport, IDisposable
    {
        internal bool Disposed { get; private set; }

        public TransportResponse Send(string apiKey, string body)
        {
            throw new InvalidOperationException("transport must not send during configuration");
        }

        public void Dispose()
        {
            Disposed = true;
            GC.SuppressFinalize(this);
        }
    }

    internal sealed class TestHostApplicationLifetime : IHostApplicationLifetime, IDisposable
    {
        private readonly CancellationTokenSource started = new CancellationTokenSource();
        private readonly CancellationTokenSource stopping = new CancellationTokenSource();
        private readonly CancellationTokenSource stopped = new CancellationTokenSource();

        public CancellationToken ApplicationStarted => started.Token;

        public CancellationToken ApplicationStopping => stopping.Token;

        public CancellationToken ApplicationStopped => stopped.Token;

        public void StopApplication()
        {
            stopping.Cancel();
            stopped.Cancel();
        }

        public void Dispose()
        {
            started.Dispose();
            stopping.Dispose();
            stopped.Dispose();
            GC.SuppressFinalize(this);
        }
    }
}
