using System;
using System.Collections.Generic;
using System.Globalization;
using LogBrew;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
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
app.Use(async (context, next) =>
{
    if (IsLocalVerificationRoute(context))
    {
        await next(context).ConfigureAwait(false);
        return;
    }

    await LogBrewServerRequestTelemetry.CaptureAsync(
        client,
        context.Request.Method,
        RouteTemplate(context),
        context.Request.Headers.TryGetValue("traceparent", out var traceparent) ? traceparent.ToString() : null,
        async request =>
        {
            await next(context).ConfigureAwait(false);
            return context.Response.StatusCode;
        },
        LogBrewServerRequestOptions.Create()
            .WithEventIdPrefix("aspnetcore_request")
            .WithTimestampProvider(() => "2026-06-02T10:00:41Z")
            .WithMetadata(new Dictionary<string, object?>
            {
                ["framework"] = "aspnetcore",
                ["component"] = "checkout-api"
            })).ConfigureAwait(false);
});

app.MapGet("/ready", () => Results.Ok(new { ok = true }));
app.MapGet("/checkout/{cartId}", (ILogger<Program> logger, string cartId) =>
{
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

static string RouteTemplate(HttpContext context)
{
    if (context.GetEndpoint() is RouteEndpoint endpoint && !string.IsNullOrWhiteSpace(endpoint.RoutePattern.RawText))
    {
        return "/" + endpoint.RoutePattern.RawText.TrimStart('/');
    }

    return string.IsNullOrWhiteSpace(context.Request.Path.Value) ? "/" : context.Request.Path.Value!;
}
