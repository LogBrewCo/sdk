# .NET First-Useful Telemetry Comparison - 2026-06-15

This pass compared the first useful .NET service telemetry path for a developer evaluating LogBrew against Sentry, Datadog, OpenTelemetry, and PostHog. The test used isolated temporary `dotnet new console` apps and isolated `NUGET_PACKAGES` directories, then installed the current public packages from NuGet.

## Real install footprint

| Package path | Version resolved | Direct package refs | Files | NuGet cache footprint | Install time |
| --- | ---: | ---: | ---: | ---: | ---: |
| `LogBrew` | `0.1.0` | 1 | 214 | 10,652 KiB | 0.8s |
| `Sentry.Extensions.Logging` | `6.6.0` | 1 | 467 | 240,044 KiB | 7.4s |
| `Datadog.Trace` | `3.45.0` | 1 | 17 | 952 KiB | 2.7s |
| `Datadog.Trace.Bundle` | `3.45.0` | 1 | 178 | 624,348 KiB | 16.0s |
| OpenTelemetry quickstart packages | `1.16.0` | 3 | 522 | 23,336 KiB | 6.2s |
| `PostHog` | `2.7.1` | 1 | 512 | 22,968 KiB | 3.1s |

`Datadog.Trace` alone is small, but Datadog's current docs state that custom instrumentation with v3 requires automatic instrumentation as well. `Datadog.Trace.Bundle` is the per-application NuGet path for that operational setup, so both numbers are relevant.

## Sources reviewed

- Sentry .NET docs: [Microsoft.Extensions.Logging](https://docs.sentry.io/platforms/dotnet/guides/extensions-logging/), [ASP.NET Core](https://docs.sentry.io/platforms/dotnet/guides/aspnetcore/), and [ASP.NET Core trace propagation](https://docs.sentry.io/platforms/dotnet/guides/aspnetcore/tracing/trace-propagation/). Sentry is strong on logging-to-breadcrumbs/events, framework integration, traces, profiling, and metrics beta, but the first path is a broader SDK and framework integration decision.
- Sentry source at `getsentry/sentry-dotnet@2f2842f20f9581468a0ab4e971bfd507557161b3`: `src/Sentry.Extensions.Logging/SentryLogger.cs`, `src/Sentry.Extensions.Logging/SentryLoggerProvider.cs`, and `src/Sentry/SentryOptions.cs`. The source confirms mature logging provider behavior with breadcrumb/event thresholds and global SDK options.
- Datadog docs: [.NET Core tracing](https://docs.datadoghq.com/tracing/trace_collection/dd_libraries/dotnet-core/), [.NET Framework tracing](https://docs.datadoghq.com/tracing/trace_collection/dd_libraries/dotnet-framework/), and [.NET log/trace correlation](https://docs.datadoghq.com/tracing/other_telemetry/connect_logs_and_traces/dotnet/). Datadog is strong on automatic instrumentation and trace-log correlation, but its current .NET path includes agent/profiler setup and environment configuration.
- Datadog source at `DataDog/dd-trace-dotnet@c6f007bc1f0e0b206bf3924935ffc89c6b47084f`: `tracer/src/Datadog.Trace.Manual/CorrelationIdentifier.cs`, `tracer/src/Datadog.Trace.Manual/Tracer.cs`, and `tracer/src/Datadog.Trace.Manual/SpanContextInjector.cs`. The source reinforces the value of trace/log correlation and carrier injection while showing the global tracer model.
- OpenTelemetry docs: [.NET](https://opentelemetry.io/docs/languages/dotnet/) and [Getting Started](https://opentelemetry.io/docs/languages/dotnet/getting-started/). OpenTelemetry is the strongest standards baseline for traces, metrics, and logs, but the quickstart asks users to assemble several packages and provider/exporter setup.
- OpenTelemetry source at `open-telemetry/opentelemetry-dotnet@ddaa257e145fa90fb892e5e2eddf22adee633a0d`: `src/OpenTelemetry.Api/Context/Propagation/TraceContextPropagator.cs`, `examples/Console/InstrumentationWithActivitySource.cs`, and `src/OpenTelemetry.Api.ProviderBuilderExtensions/Trace/OpenTelemetryDependencyInjectionTracingServiceCollectionExtensions.cs`.
- PostHog docs: [.NET SDK](https://posthog.com/docs/libraries/dotnet). PostHog is strong for product analytics, feature flags, and ASP.NET Core conveniences, but it is not a logs/traces/metrics observability-first path.
- PostHog source at `PostHog/posthog-dotnet@fbaf2d188e4576f8c9d146783b22072c3b22fdc2`: `src/PostHog/Api/PostHogApiClient.cs`, `src/PostHog/Api/CapturedEvent.cs`, and `src/PostHog.AspNetCore/Tracing/PostHogRequestContextMiddleware.cs`.

## What competitors do better

- Sentry has broader .NET framework coverage, errors, tracing, profiling, and log-to-event/breadcrumb workflows.
- Datadog has stronger automatic instrumentation and trace-log correlation once the tracer and runtime configuration are in place.
- OpenTelemetry remains the portability baseline for teams already using `ActivitySource`, meters, exporters, and collectors.
- PostHog has more mature product analytics, feature-flag, and ASP.NET Core feature-management workflows.

## What LogBrew can now do better

- The .NET path remains app-owned and lightweight for hosted LogBrew telemetry: no automatic HTTP patching, no visual replay, no request/response body capture, and no arbitrary header capture.
- The new first-useful example emits release, environment, service log, product action, network milestone, `http.server.duration` histogram metric, and a W3C-linked span from one copyable console app.
- `Traceparent` validates W3C shape, rejects forbidden/all-zero IDs, normalizes IDs, exposes sampled flags, creates outbound `traceparent` headers, and derives LogBrew span attributes with primitive metadata only.
- LogBrew's `ILogger` provider remains explicit and app-owned: it preserves existing logging configuration, respects minimum levels and scopes, omits exception stack text unless opted in, and reports capture failures through `OnError`.

## Changes made

- Added `dotnet/logbrew-dotnet/src/LogBrew/Traceparent.cs` with dependency-free W3C traceparent parse/create/header/span helpers.
- Added `dotnet/logbrew-dotnet/examples/FirstUsefulTelemetry.cs`, a packaged first-useful service payload example.
- Updated `dotnet/logbrew-dotnet/README.md` with first-useful telemetry and W3C trace context guidance.
- Updated `dotnet/logbrew-dotnet/examples/Makefile`, `scripts/check_dotnet_package.sh`, `scripts/real_user_dotnet_smoke.sh`, and `scripts/check_release_metadata.py` so package and installed-NuGet proof cover the new example and helper.
- Added `scripts/check_dotnet_first_useful_payload.py` to verify event order, trace/session correlation, route-template privacy, metric shape, W3C child span linkage, and outbound traceparent output.

## Remaining honest gaps

- .NET still lacks a first-party ASP.NET Core request wrapper with deterministic W3C child spans, route-template capture, and opt-in request duration metrics comparable to JS/Python framework packages.
- Source-map/native symbolication and backend release-artifact lookup proof remain worse than Sentry/Datadog and should not be claimed as supported.
- LogBrew's .NET path is intentionally explicit. That is safer and easier to audit, but it is not a substitute for automatic framework instrumentation in teams that need broad transparent capture immediately.

## Next priority

Add the same first-useful installed proof to PHP, Ruby, and Rust. For .NET specifically, the next high-value gap is a thin ASP.NET Core request helper that preserves app response ownership, continues W3C `traceparent` as a child span, omits query strings by default, and makes request duration metrics opt-in.
