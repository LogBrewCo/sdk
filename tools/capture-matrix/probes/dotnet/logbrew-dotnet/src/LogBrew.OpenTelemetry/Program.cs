using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using LogBrew;
using LogBrew.OpenTelemetry;
using Microsoft.Extensions.Logging;
using OpenTelemetry;
using OpenTelemetry.Trace;

var endpoint = new Uri(Environment.GetEnvironmentVariable("LOGBREW_CAPTURE_ENDPOINT")!);
var serviceContext = TelemetryContext.Create()
    .WithResource(TelemetryResource.Create()
        .WithService("checkout-api", "1.2.3")
        .WithDeployment("production", "checkout@1.2.3")
        .Build())
    .Build();
using var transport = new HttpTransport(new HttpTransportOptions { Endpoint = endpoint });
var client = LogBrewClient.CreateAutomatic(
    "LOGBREW_API_KEY",
    "checkout-api",
    "1.2.3",
    new LogBrewClientOptions { Context = serviceContext },
    transport);

var catalogPort = FreePort();
using var catalog = new HttpListener();
catalog.Prefixes.Add($"http://127.0.0.1:{catalogPort}/");
catalog.Start();
var serving = Task.Run(async () =>
{
    var context = await catalog.GetContextAsync();
    context.Response.StatusCode = 200;
    context.Response.Close();
});

using var source = new ActivitySource("Checkout.Api", "1.2.3");
using (var tracerProvider = Sdk.CreateTracerProviderBuilder()
    .AddSource("Checkout.Api", "System.Net.Http")
    .AddLogBrew(client, options => options
        .WithServiceName("checkout-api")
        .WithServiceVersion("1.2.3")
        .WithDeploymentEnvironment("production"))
    .Build())
using (var factory = LoggerFactory.Create(builder => builder.AddLogBrew(client)))
using (var http = new HttpClient())
{
    var logger = factory.CreateLogger("Checkout");
    var parent = ActivityContext.Parse("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", null);
    using var user = LogBrewTelemetry.ActivateContext(TelemetryContext.Create().WithSubject("user_123", "user").Build());
    using (var activity = source.StartActivity("GET /checkout/{cartId}", ActivityKind.Server, parent))
    {
        activity?.SetTag("http.request.method", "GET");
        activity?.SetTag("http.route", "/checkout/{cartId}");
        logger.LogInformation("checkout started for {CartId}", "cart-1");
        await http.GetAsync(new Uri($"http://127.0.0.1:{catalogPort}/items"));
        activity?.SetTag("http.response.status_code", 200);
    }

    using (var activity = source.StartActivity("GET /fail/{cartId}", ActivityKind.Server, parent))
    {
        activity?.SetTag("http.request.method", "GET");
        activity?.SetTag("http.route", "/fail/{cartId}");
        try
        {
            await http.GetAsync(new Uri($"http://127.0.0.1:{FreePort()}/payments"));
        }
        catch (HttpRequestException error)
        {
            logger.LogError(error, "payment service unreachable");
            activity?.AddException(error);
            activity?.SetStatus(ActivityStatusCode.Error);
            activity?.SetTag("http.response.status_code", 500);
        }
    }

    tracerProvider.ForceFlush();
}

await serving;
catalog.Stop();
var response = client.Shutdown();
Console.WriteLine($"shutdown status {response.StatusCode}");

static int FreePort()
{
    using var listener = new TcpListener(IPAddress.Loopback, 0);
    listener.Start();
    return ((IPEndPoint)listener.LocalEndpoint).Port;
}
