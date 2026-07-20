# LogBrew HttpClient integration

Optional `IHttpClientFactory` correlation for explicitly selected named and typed clients.

## Install

```bash
dotnet add package LogBrew.HttpClient
```

## Usage

```csharp
using LogBrew;
using LogBrew.HttpClient;
using Microsoft.Extensions.DependencyInjection;

var telemetry = LogBrewClient.Create(
    "LOGBREW_API_KEY",
    "checkout-service",
    "1.0.0");

services
    .AddHttpClient("catalog")
    .AddLogBrewCorrelation(telemetry);
```

The extension changes only the named or typed builder on which it is called. Repeating it for the same builder name is idempotent and the first registration wins. Unselected clients remain unchanged, and no process-wide diagnostics listener or handler filter is installed.

Correlation requires an active `LogBrewTrace.Current`. Without one, the handler delegates literally: it does not evaluate its filter, inspect request metadata, change headers, emit a span, or invoke the diagnostics callback. With a parent, each handler execution receives a distinct W3C child `traceparent`; the caller's original header and active trace are returned before the task completes.

Add correlation after an app-owned retry handler when every retry execution should own a separate child span. Handler completion is the timing boundary, so response identity, streaming content, cancellation, and disposal remain app-owned.

Captured fields are limited to method, normalized DNS host without scheme or port, status code, duration, source, sampled state, real cancellation, and exception type. The integration never records URL paths, query strings, fragments, IP addresses, arbitrary headers, bodies, exception messages or stacks, authentication material, baggage, tracestate, client names, or arbitrary metadata. Capture and filter failures are advisory and do not replace HTTP responses or exceptions. LogBrew SDK delivery requests are excluded to prevent self-correlation.

The packaged `examples/HttpClientFactoryCorrelation.cs` file contains a complete selected-client registration.
