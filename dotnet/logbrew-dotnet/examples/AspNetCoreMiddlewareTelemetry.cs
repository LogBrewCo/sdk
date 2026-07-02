using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using LogBrew;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

var builder = WebApplication.CreateBuilder(args);
var client = LogBrewClient.Create("LOGBREW_API_KEY", "checkout-aspnetcore", "0.1.0");

builder.Logging.ClearProviders();
builder.Logging.AddFilter("Microsoft", LogLevel.None);
builder.Logging.AddFilter("System", LogLevel.None);
builder.Logging.AddLogBrew(client, new LogBrewLoggerOptions
{
    EventIdPrefix = "aspnetcore_log",
    TimestampProvider = () => DateTimeOffset.Parse("2026-06-02T10:00:40Z", CultureInfo.InvariantCulture)
});

var app = builder.Build();
app.UseRouting();
app.UseLogBrewRequestTelemetry(
    client,
    options => options
        .WithEventIdPrefix("aspnetcore_request")
        .WithTimestampProvider(() => "2026-06-02T10:00:41Z")
        .WithRequestFilter(context => !IsLocalVerificationRoute(context))
        .WithMetadata(new Dictionary<string, object?>
        {
            ["framework"] = "aspnetcore",
            ["component"] = "checkout-api"
        }));
app.UseLogBrewDependencyActivitySourceTelemetry(
    client,
    options => options
        .WithEventIdPrefix("aspnetcore_dependency")
        .WithTimestampProvider(() => "2026-06-02T10:00:42Z")
        .WithMetadata(new Dictionary<string, object?>
        {
            ["framework"] = "aspnetcore",
            ["component"] = "checkout-api"
        }));

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
    logger.LogInformation("checkout route accepted for {CartId}", cartId);
    return Results.Ok(new { ok = true, cartId });
});
app.MapGet("/logbrew-preview", () => Results.Text(client.PreviewJson(), "application/json"));

await app.RunAsync().ConfigureAwait(false);

static bool IsLocalVerificationRoute(HttpContext context)
{
    var path = context.Request.Path.Value ?? string.Empty;
    return string.Equals(path, "/ready", StringComparison.Ordinal)
        || string.Equals(path, "/logbrew-preview", StringComparison.Ordinal);
}
