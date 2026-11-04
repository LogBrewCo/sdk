using System.Net;
using System.Net.Sockets;
using LogBrew;
using LogBrew.HttpClient;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

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
    await context.Response.OutputStream.WriteAsync("{\"items\":[]}"u8.ToArray());
    context.Response.Close();
});

var services = new ServiceCollection();
services.AddLogging(builder => builder.AddLogBrew(client));
services.AddHttpClient("catalog").AddLogBrewCorrelation(client);
using var provider = services.BuildServiceProvider();
var logger = provider.GetRequiredService<ILoggerFactory>().CreateLogger("Checkout");
var factory = provider.GetRequiredService<IHttpClientFactory>();

var requestContext = TelemetryContext.Create().WithSubject("user_123", "user").Build();
using (LogBrewTelemetry.ActivateContext(requestContext))
using (LogBrewTrace.Activate(LogBrewTraceContext.FromTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")))
{
    using var http = factory.CreateClient("catalog");
    var body = await http.GetStringAsync(new Uri($"http://127.0.0.1:{catalogPort}/items"));
    logger.LogInformation("catalog returned {Length} bytes", body.Length);
    try
    {
        await http.GetStringAsync(new Uri($"http://127.0.0.1:{FreePort()}/payments"));
    }
    catch (HttpRequestException error)
    {
        logger.LogError(error, "payment service unreachable");
    }
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
