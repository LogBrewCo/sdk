using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using LogBrew;
using LogBrew.StackExchangeRedis;
using Microsoft.Extensions.Logging;
using StackExchange.Redis;

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

var port = FreePort();
using var redisServer = Process.Start(new ProcessStartInfo("redis-server", $"--port {port} --bind 127.0.0.1 --save \"\" --appendonly no")
{
    RedirectStandardOutput = true,
    UseShellExecute = false,
})!;
try
{
    var multiplexer = await ConnectAsync(port);
    var redis = multiplexer.GetDatabase();
    var options = LogBrewStackExchangeRedisCommandOptions.Create().WithCacheName("checkout-cache");
    using (var factory = LoggerFactory.Create(builder => builder.AddLogBrew(client)))
    {
        var logger = factory.CreateLogger("Checkout");
        var requestContext = TelemetryContext.Create().WithSubject("user_123", "user").Build();
        using (LogBrewTelemetry.ActivateContext(requestContext))
        using (LogBrewTrace.Activate(LogBrewTraceContext.FromTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")))
        {
            redis.TraceLogBrewCommand(client, "SET", db => db.StringSet("cart:1", "open"), options);
            var cart = await redis.TraceLogBrewCommandAsync(client, "GET", db => db.StringGetAsync("cart:1"), options);
            logger.LogInformation("cart state {State}", cart.ToString());
            try
            {
                redis.TraceLogBrewCommand(client, "INCR", db => db.StringIncrement("cart:1"), options);
            }
            catch (RedisServerException error)
            {
                logger.LogError(error, "cart counter update failed");
            }
        }
    }

    await multiplexer.CloseAsync();
    multiplexer.Dispose();
}
finally
{
    redisServer.Kill();
    redisServer.WaitForExit();
}

var response = client.Shutdown();
Console.WriteLine($"shutdown status {response.StatusCode}");

static async Task<ConnectionMultiplexer> ConnectAsync(int port)
{
    for (var attempt = 0; ; attempt++)
    {
        try
        {
            return await ConnectionMultiplexer.ConnectAsync($"127.0.0.1:{port},abortConnect=true,connectTimeout=500");
        }
        catch (RedisConnectionException) when (attempt < 40)
        {
            await Task.Delay(100);
        }
    }
}

static int FreePort()
{
    using var listener = new TcpListener(IPAddress.Loopback, 0);
    listener.Start();
    return ((IPEndPoint)listener.LocalEndpoint).Port;
}
