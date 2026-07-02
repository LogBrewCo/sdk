using LogBrew;
using LogBrew.OpenTelemetry;
using OpenTelemetry;
using OpenTelemetry.Trace;
using System.Diagnostics;

var client = LogBrewClient.Create(
    Environment.GetEnvironmentVariable("LOGBREW_API_KEY") ?? "LOGBREW_API_KEY",
    "checkout-api",
    "1.0.0");

using var source = new ActivitySource("Checkout.Api", "1.0.0");
using (Sdk.CreateTracerProviderBuilder()
    .AddSource("Checkout.Api")
    .AddLogBrew(client, options => options
        .WithEventIdPrefix("checkout_otel")
        .WithServiceName("checkout-api")
        .WithServiceVersion("1.0.0")
        .WithDeploymentEnvironment("production")
        .WithMetadata(new Dictionary<string, object?> { ["component"] = "checkout" }))
    .Build())
{
    using var activity = source.StartActivity("GET /checkout/{id}", ActivityKind.Server);
    activity?.SetTag("http.request.method", "GET");
    activity?.SetTag("http.route", "/checkout/{id}");
    activity?.SetTag("http.response.status_code", 200);
    activity?.SetTag("url.full", "https://example.test/checkout/omitted?coupon=omitted");
    activity?.AddEvent(new ActivityEvent(
        "cache.lookup",
        tags: new ActivityTagsCollection
        {
            ["messaging.system"] = "memory",
            ["exception.message"] = "not captured"
        }));
}

Console.WriteLine(client.PreviewJson());
