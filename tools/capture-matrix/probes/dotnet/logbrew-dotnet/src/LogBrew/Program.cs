using System.Globalization;
using LogBrew;
using Microsoft.Extensions.Logging;

const string IncomingTraceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
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

using (var factory = LoggerFactory.Create(builder => builder.AddLogBrew(client)))
{
    var logger = factory.CreateLogger("Checkout");
    HandleRequest("/checkout/:cart_id", () => logger.LogInformation("checkout started for {CartId}", "cart-1"));
    HandleRequest("/fail/:cart_id", () =>
    {
        logger.LogWarning("payment step failing for {CartId}", "cart-2");
        throw new InvalidOperationException("payment declined");
    });
}

var response = client.Shutdown();
Console.WriteLine($"shutdown status {response.StatusCode}");

void HandleRequest(string routeTemplate, Action handler)
{
    var request = LogBrewHttpRequestTelemetry.Start(client, "POST", routeTemplate, IncomingTraceparent);
    var requestContext = TelemetryContext.Create()
        .WithTrace(request.Trace)
        .WithSession("sess_123")
        .WithSubject("user_123", "user")
        .Build();
    var statusCode = 200;
    using (LogBrewTelemetry.ActivateContext(requestContext))
    {
        using (request.Activate())
        {
            try
            {
                handler();
            }
            catch (InvalidOperationException error)
            {
                statusCode = 500;
                client.Issue(
                    "evt_issue_" + request.Trace.SpanId,
                    Now(),
                    IssueAttributes.FromException(error, "Checkout failed", "dotnet.request_handler", true));
            }
        }

        request.FinishSpanAndMetric("evt_span_" + request.Trace.SpanId, "evt_metric_" + request.Trace.SpanId, Now(), statusCode);
    }
}

static string Now() => DateTimeOffset.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
