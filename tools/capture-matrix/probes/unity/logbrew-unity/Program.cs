using System.Collections;
using Stopwatch = System.Diagnostics.Stopwatch;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using LogBrew.Unity;
using UnityEngine;

var endpoint = new Uri(Environment.GetEnvironmentVariable("LOGBREW_CAPTURE_ENDPOINT")!);
var clock = Stopwatch.StartNew();
string NextId() => "evt_" + Guid.NewGuid().ToString("N");
string Now() => DateTimeOffset.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
double Realtime() => clock.Elapsed.TotalMilliseconds;

var defaults = TelemetryContext.Create()
    .WithResource(TelemetryResource.Create()
        .WithService("checkout-game", "2.3.0")
        .WithDeployment("production", "checkout-game@2.3.0")
        .WithApplication("Checkout Game", "2.3.0", "204")
        .Build())
    .Build();
var client = LogBrewUnity.CreateClient("LOGBREW_API_KEY", "checkout-game", context: defaults);
var scene = UnityContext.Create().WithPlatform("ios").WithSceneName("Checkout");

Application.logMessageReceived += (condition, stackTrace, type) =>
    LogBrewUnity.CaptureLogMessage(client, NextId(), Now(), condition, type.ToString(), scene);

var port = FreePort();
using var server = new HttpListener();
server.Prefixes.Add($"http://127.0.0.1:{port}/");
server.Start();
var serving = Task.Run(async () =>
{
    var context = await server.GetContextAsync();
    context.Response.StatusCode = 503;
    context.Response.Close();
});

var playerFlow = TelemetryContext.Create()
    .WithSession("sess_123")
    .WithSubject("user_123", "user")
    .Build();
using (LogBrewTelemetry.ActivateContext(playerFlow))
using (LogBrewTrace.Activate(LogBrewTraceContext.ContinueOrCreate("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")))
{
    LogBrewUnity.CaptureSceneLoaded(client, NextId(), Now(), "Checkout", 1, scene);
    Debug.Log("checkout started");

    var requests = new UnityRequestTracker(client, NextId, Now, Realtime, scene);
    using (var http = new HttpClient())
    using (var request = new HttpRequestMessage(HttpMethod.Post, $"http://127.0.0.1:{port}/api/checkout"))
    {
        var tracked = requests.Start("POST", "/api/checkout", (name, value) => request.Headers.Add(name, value));
        using var response = http.Send(request);
        requests.Capture(tracked, (int)response.StatusCode, "UnityWebRequestError");
    }

    client.AddBreadcrumb(
        IssueBreadcrumb.Create(Now(), "checkout.request")
            .WithType("http")
            .WithLevel("warning")
            .WithMessage("checkout request returned 503"));
    Debug.LogWarning("checkout retry scheduled");

    var coroutines = new UnityCoroutineTracker(client, NextId, Now, Realtime, scene);
    var routine = coroutines.Trace("checkout.submit", SubmitCheckout());
    try
    {
        while (routine.MoveNext())
        {
        }
    }
    catch (InvalidOperationException error)
    {
        LogBrewUnity.CaptureException(client, NextId(), Now(), error, handled: true, context: scene);
    }

    var lifecycle = new UnityLifecycleTracker(client, NextId, Now, Realtime, context: scene);
    lifecycle.CapturePause(true);
    lifecycle.CapturePause(false);

    client.Metric(
        NextId(),
        Now(),
        MetricAttributes.Create("frame.duration", "histogram", 16.6, "ms", "delta")
            .WithMetadata(new Dictionary<string, object?> { ["scene"] = "Checkout" }));
}

await serving;
server.Stop();
using var transport = new HttpTransport(endpoint);
var result = client.Shutdown(transport);
Console.WriteLine($"shutdown status {result.StatusCode}");

static IEnumerator SubmitCheckout()
{
    yield return null;
    Debug.Log("submitting checkout");
    yield return null;
    throw new InvalidOperationException("payment declined");
}

static int FreePort()
{
    using var listener = new TcpListener(IPAddress.Loopback, 0);
    listener.Start();
    return ((IPEndPoint)listener.LocalEndpoint).Port;
}
