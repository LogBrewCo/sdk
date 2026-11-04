using Hangfire;
using Hangfire.InMemory;
using Hangfire.States;
using Hangfire.Storage;
using LogBrew;
using LogBrew.Hangfire;
using Microsoft.Extensions.Logging;

var endpoint = new Uri(Environment.GetEnvironmentVariable("LOGBREW_CAPTURE_ENDPOINT")!);
var serviceContext = TelemetryContext.Create()
    .WithResource(TelemetryResource.Create()
        .WithService("checkout-worker", "1.2.3")
        .WithDeployment("production", "checkout@1.2.3")
        .Build())
    .Build();
using var transport = new HttpTransport(new HttpTransportOptions { Endpoint = endpoint });
var client = LogBrewClient.CreateAutomatic(
    "LOGBREW_API_KEY",
    "checkout-worker",
    "1.2.3",
    new LogBrewClientOptions { Context = serviceContext },
    transport);

using (var factory = LoggerFactory.Create(builder => builder.AddLogBrew(client)))
{
    Jobs.Logger = factory.CreateLogger("Checkout.Jobs");
    GlobalConfiguration.Configuration.UseInMemoryStorage().UseLogBrewHangfire(client);
    using (new BackgroundJobServer(new BackgroundJobServerOptions { WorkerCount = 1 }))
    {
        var jobs = new[]
        {
            BackgroundJob.Enqueue(() => Jobs.ChargeCard("cart-1")),
            BackgroundJob.Enqueue(() => Jobs.ChargeDeclined("cart-2")),
        };
        foreach (var job in jobs)
        {
            await WaitForFinalState(job);
        }
    }
}

var response = client.Shutdown();
Console.WriteLine($"shutdown status {response.StatusCode}");

static async Task WaitForFinalState(string jobId)
{
    using var connection = JobStorage.Current.GetConnection();
    for (var attempt = 0; attempt < 300; attempt++)
    {
        var state = connection.GetStateData(jobId)?.Name;
        if (state == SucceededState.StateName || state == FailedState.StateName)
        {
            Console.WriteLine($"{jobId} {state}");
            return;
        }

        await Task.Delay(100);
    }

    throw new TimeoutException($"job {jobId} did not finish");
}

public static class Jobs
{
    public static ILogger Logger { get; set; } = null!;

    public static void ChargeCard(string cartId)
    {
        using (LogBrewTelemetry.ActivateContext(TelemetryContext.Create().WithSubject("user_123", "user").Build()))
        {
            Logger.LogInformation("charging {CartId}", cartId);
        }
    }

    [AutomaticRetry(Attempts = 0)]
    public static void ChargeDeclined(string cartId)
    {
        using (LogBrewTelemetry.ActivateContext(TelemetryContext.Create().WithSubject("user_123", "user").Build()))
        {
            Logger.LogWarning("charge failing for {CartId}", cartId);
            throw new InvalidOperationException("payment declined");
        }
    }
}
