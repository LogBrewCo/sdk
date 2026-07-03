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

using var exporterSource = new ActivitySource("Checkout.Exporter", "1.0.0");
using var exporter = new LogBrewOpenTelemetrySpanExporter(client, options => options
    .WithEventIdPrefix("checkout_otel_exporter")
    .WithServiceName("checkout-worker")
    .WithServiceVersion("1.0.0")
    .WithDeploymentEnvironment("staging"));
using var exportProcessor = new SimpleActivityExportProcessor(exporter);
using (Sdk.CreateTracerProviderBuilder()
    .AddSource("Checkout.Exporter")
    .AddProcessor(exportProcessor)
    .Build())
{
    using var activity = exporterSource.StartActivity("POST /jobs/{id}", ActivityKind.Producer);
    activity?.SetTag("messaging.system", "memory");
    activity?.SetTag("messaging.operation", "publish");
    activity?.SetTag("messaging.message.id", "message-id-omitted");
    activity?.SetTag("url.full", "https://example.test/jobs/123?debug=omitted");
    activity?.AddLink(new ActivityLink(
        new ActivityContext(
            ActivityTraceId.CreateFromString("4bf92f3577b34da6a3ce929d0e0e4736".AsSpan()),
            ActivitySpanId.CreateFromString("00f067aa0ba902b7".AsSpan()),
            ActivityTraceFlags.Recorded),
        new ActivityTagsCollection
        {
            ["messaging.system"] = "memory",
            ["messaging.message.id"] = "linked-message-id-omitted"
        }));
}

Console.WriteLine(client.PreviewJson());
