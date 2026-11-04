using LogBrew;
using LogBrew.EntityFrameworkCore;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
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

using var connection = new SqliteConnection("Data Source=:memory:");
connection.Open();
var options = new DbContextOptionsBuilder()
    .UseSqlite(connection)
    .AddLogBrewCommandTelemetry(client, telemetry => telemetry
        .WithSystem("sqlite")
        .WithDatabaseName("checkout")
        .WithOperationNamePrefix("orders"))
    .Options;

using (var factory = LoggerFactory.Create(builder => builder.AddLogBrew(client)))
{
    var logger = factory.CreateLogger("Checkout");
    var requestContext = TelemetryContext.Create().WithSubject("user_123", "user").Build();
    using (LogBrewTelemetry.ActivateContext(requestContext))
    using (LogBrewTrace.Activate(LogBrewTraceContext.FromTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")))
    {
        using (var db = new CheckoutContext(options))
        {
            db.Database.EnsureCreated();
            db.Orders.Add(new Order { CartId = "cart-1", Total = 42 });
            await db.SaveChangesAsync();
            var count = await db.Orders.CountAsync(order => order.Total > 10);
            logger.LogInformation("checkout stored {Count} orders", count);
        }

        try
        {
            using var db = new CheckoutContext(options);
            await db.Database.ExecuteSqlRawAsync("UPDATE payments SET status = 'declined'");
        }
        catch (SqliteException error)
        {
            logger.LogError(error, "payment update failed");
        }
    }
}

var response = client.Shutdown();
Console.WriteLine($"shutdown status {response.StatusCode}");

internal sealed class Order
{
    public int Id { get; set; }

    public string CartId { get; set; } = "";

    public decimal Total { get; set; }
}

internal sealed class CheckoutContext(DbContextOptions options) : DbContext(options)
{
    public DbSet<Order> Orders => Set<Order>();
}
