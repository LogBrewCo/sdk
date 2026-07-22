using LogBrew;
using LogBrew.HttpClient;
using Microsoft.Extensions.DependencyInjection;

var telemetry = LogBrewClient.Create(
    "LOGBREW_API_KEY",
    "checkout-service",
    "1.0.0");
var services = new ServiceCollection();
services
    .AddHttpClient("catalog")
    // Add after retry middleware when each attempt should own a distinct child.
    .AddLogBrewCorrelation(
        telemetry,
        options => options.WithEventIdPrefix("checkout_catalog"));

using var provider = services.BuildServiceProvider();
var factory = provider.GetRequiredService<IHttpClientFactory>();
using var catalog = factory.CreateClient("catalog");

// Selection is explicit and duplicate registration is idempotent/first-wins.
// Without an active parent, requests pass through without inspection or capture.
// With a parent, the caller's traceparent is returned after the handler completes.
// Only method, normalized DNS host, status, duration, source, sampled state,
// real cancellation, and exception type are eligible; URLs, bodies, headers, and
// SDK delivery are excluded.
using var parent = LogBrewTrace.Activate(LogBrewTraceContext.CreateRoot());
using var response = await catalog.GetAsync(
    new Uri("https://catalog.example.test/items", UriKind.Absolute));
