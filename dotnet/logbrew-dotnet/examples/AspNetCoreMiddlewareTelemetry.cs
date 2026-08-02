using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.CompilerServices;
using LogBrew;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

var previewTransport = RecordingTransport.AlwaysAccept();
var builder = WebApplication.CreateBuilder(args);
builder.Logging.ClearProviders();
builder.AddLogBrew(options => options
    .WithServerApiKey("local-preview-only")
    .WithServiceName("checkout-api")
    .WithEnvironment("development")
    .WithRelease("1.2.3")
    .WithTransport(previewTransport)
    .WithTimestampProvider(() => DateTimeOffset.Parse(
        "2026-06-02T10:00:39Z",
        CultureInfo.InvariantCulture))
    .ConfigureDelivery(delivery =>
    {
        delivery.FlushAtQueueSize = 100;
        delivery.FlushInterval = TimeSpan.FromMinutes(5);
    })
    .ConfigureLogging(logging =>
    {
        logging.MinimumLevel = LogLevel.Warning;
        logging.EventIdPrefix = "aspnetcore_log";
        logging.TimestampProvider = () => DateTimeOffset.Parse(
            "2026-06-02T10:00:40Z",
            CultureInfo.InvariantCulture);
    })
    .ConfigureRequestTelemetry(request => request
        .WithEventIdPrefix("aspnetcore_request")
        .WithTimestampProvider(() => "2026-06-02T10:00:41Z")
        .WithRequestFilter(context => !IsLocalVerificationRoute(context))
        .WithMetadata(new Dictionary<string, object?>
        {
            ["component"] = "checkout-api"
        }))
    .ConfigureDependencyTelemetry(dependency => dependency
        .WithEventIdPrefix("aspnetcore_dependency")
        .WithTimestampProvider(() => "2026-06-02T10:00:42Z")
        .WithMetadata(new Dictionary<string, object?>
        {
            ["service"] = "checkout-api",
            ["environment"] = "development",
            ["release"] = "1.2.3",
            ["framework"] = "aspnetcore",
            ["component"] = "checkout-api"
        })));

var app = builder.Build();
app.UseRouting();
app.UseLogBrew();

app.MapGet("/ready", () => Results.Ok(new { ok = true }));
using var outboundSource = new ActivitySource("System.Net.Http", "10.0.0");
app.MapGet("/checkout/{cartId}", (ILogger<Program> logger, string cartId) =>
{
    using var dependency = outboundSource.StartActivity("GET /payments/{cartId}", ActivityKind.Client);
    dependency?.SetTag("http.request.method", "GET");
    dependency?.SetTag("http.route", "/payments/{cartId}");
    dependency?.SetTag("http.response.status_code", 202);
    dependency?.SetTag("http.url", "https://payments.example.test/payments/" + cartId + "?card=dropme");
    dependency?.SetTag("request.body", "card=dropme");
    logger.LogWarning("checkout route accepted");
    return Results.Ok(new { ok = true, cartId });
});
app.MapGet("/checkout/failure", ThrowCheckoutFailure);

var runtime = app.Services.GetRequiredService<LogBrewAspNetCoreRuntime>();
app.MapGet(
    "/logbrew-preview",
    () => Results.Text(runtime.Client?.PreviewJson() ?? "{\"events\":[]}", "application/json"));

await app.RunAsync().ConfigureAwait(false);

static bool IsLocalVerificationRoute(HttpContext context)
{
    var path = context.Request.Path.Value ?? string.Empty;
    return string.Equals(path, "/ready", StringComparison.Ordinal)
        || string.Equals(path, "/logbrew-preview", StringComparison.Ordinal);
}

[MethodImpl(MethodImplOptions.NoInlining)]
static IResult ThrowCheckoutFailure()
{
    throw new InvalidOperationException("private runtime detail");
}
