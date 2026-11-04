using LogBrew;

Environment.SetEnvironmentVariable("LOGBREW_SERVER_API_KEY", "LOGBREW_SERVER_API_KEY");
Environment.SetEnvironmentVariable("LOGBREW_ENDPOINT", Environment.GetEnvironmentVariable("LOGBREW_CAPTURE_ENDPOINT"));
Environment.SetEnvironmentVariable("LOGBREW_RELEASE", "checkout@1.2.3");
Environment.SetEnvironmentVariable("LOGBREW_ENVIRONMENT", "production");
Environment.SetEnvironmentVariable("LOGBREW_SERVICE_NAME", "checkout-api");

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls("http://127.0.0.1:0");
builder.Services.AddHttpClient();
builder.AddLogBrew(options => options
    .WithDependencyTelemetry(true)
    .ConfigureLogging(logging => logging.MinimumLevel = LogLevel.Information)
    .ConfigureRequestTelemetry(request => request
        .WithContextProvider(context =>
            context.Items.TryGetValue("UserId", out var value) && value is string userId
                ? TelemetryContext.Create().WithSubject(userId, "user").Build()
                : null)));

var app = builder.Build();
app.UseRouting();
app.Use(async (context, next) =>
{
    context.Items["UserId"] = "user_123";
    await next(context);
});
app.UseLogBrew();

app.MapGet("/health", () => Results.Ok());
app.MapGet("/checkout/{cartId}", async (string cartId, ILogger<Program> logger, IHttpClientFactory httpClients, HttpContext context) =>
{
    logger.LogInformation("checkout started for {CartId}", cartId);
    using var http = httpClients.CreateClient();
    await http.GetStringAsync(new Uri($"{context.Request.Scheme}://{context.Request.Host}/health"));
    return Results.Ok(new { ok = true });
});
app.MapGet("/fail/{cartId}", (string cartId, ILogger<Program> logger) =>
{
    logger.LogWarning("payment step failing for {CartId}", cartId);
    throw new InvalidOperationException("payment declined");
});

await app.StartAsync();
var baseAddress = app.Urls.First();
using (var http = new HttpClient())
{
    foreach (var path in new[] { "/checkout/cart-1", "/fail/cart-2" })
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, baseAddress + path);
        request.Headers.Add("traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
        using var response = await http.SendAsync(request);
        Console.WriteLine($"{path} {(int)response.StatusCode}");
    }
}

await app.StopAsync();
await app.DisposeAsync();

public partial class Program;
