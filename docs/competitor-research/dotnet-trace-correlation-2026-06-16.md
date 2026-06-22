# .NET Trace Correlation Comparison - 2026-06-16

## Scope

Follow-up to the all-SDK tracing priority. The .NET SDK already had explicit W3C `Traceparent` helpers, first-useful telemetry, `HttpTransport`, and an opt-in `Microsoft.Extensions.Logging` provider. It lacked the Sentry-competitive request-local correlation path where one request trace links .NET logs, captured issues, request spans, and request-duration metrics.

## Source Reviewed

- Sentry .NET `getsentry/sentry-dotnet` at commit `2f2842f20f9581468a0ab4e971bfd507557161b3`.
- Read `src/Sentry.AspNetCore/SentryTracingMiddleware.cs`: `TryStartTransaction` and `InvokeAsync`.
- Read `src/Sentry.Extensions.Logging/SentryStructuredLogger.cs`: `Log`.
- Read `src/Sentry.OpenTelemetry.Exporter/OtelPropagationContext.cs`: `Current`, `Snapshot`, `TraceId`, `SpanId`, and `ParentSpanId`.
- Read `src/Sentry.OpenTelemetry.Exporter/SentryPropagator.cs`: `Extract` and `Inject`.
- OpenTelemetry .NET `open-telemetry/opentelemetry-dotnet` at commit `41d2bb5a5f29aa8ad8f6566041434dccfb6b3252`.
- Read `src/OpenTelemetry/Logs/LogRecord.cs`: constructor activity capture and `TraceId` / `SpanId` properties.
- Read `src/OpenTelemetry/Logs/ILogger/OpenTelemetryLogger.cs`: `Log` and `LogRecordData.SetActivityContext(...)` use.
- Datadog .NET tracer `DataDog/dd-trace-dotnet` at commit `f308e58bebac1cf0f977fae6ddbe68e2f3ff399a`.
- Read `tracer/src/Datadog.Trace/AsyncLocalScopeManager.cs`: `Activate` and `Close`.
- Read `tracer/src/Datadog.Trace/CorrelationIdentifier.cs`: trace/log correlation keys.
- Read `tracer/src/Datadog.Trace/ClrProfiler/AutoInstrumentation/Logging/LogContext.cs`: `TryGetValues`, `TryGetTraceId`, and `TryGetSpanId`.
- Read `tracer/src/Datadog.Trace/ClrProfiler/AutoInstrumentation/Logging/ILogger/LogsInjection/DatadogLoggingScope.cs`: trace/span log-scope injection.

## Competitor Patterns

- Sentry opens a request transaction/scope in ASP.NET middleware, keeps that scope available while user handlers run, and finishes it after route/status information is known.
- Sentry and OpenTelemetry both use the platform's active execution context (`Activity.Current` in OTel, Sentry hub/scope in Sentry) so logs and errors inherit trace/span identity automatically.
- Datadog uses `AsyncLocal` active scope plus log injection keys so structured logs can pivot to the active span without developers manually passing IDs on every log call.
- All three provide richer automatic instrumentation than LogBrew has today, but that comes with heavier dependencies, agent/middleware wiring, or broader capture surfaces.

## LogBrew Improvement From This Pass

- Added `LogBrewTraceContext` for immutable W3C-shaped trace/span identity, local root generation, incoming `traceparent` continuation, outbound `traceparent`, sampled flags, and primitive correlation metadata.
- Added `LogBrewTrace` with `AsyncLocal` active context, previous-context restoration, `Current`, and primitive `MetadataWithCurrentTrace(...)` helpers.
- Added `LogBrewHttpRequestTelemetry` to emit one request span plus optional `http.server.duration` metric using the same trace/span IDs as logs and issues. Malformed incoming propagation falls back non-fatally to a local root trace for request helpers, while strict `Traceparent.Parse(...)` remains available for explicit validation.
- Updated `LogBrewLoggerProvider` so `ILogger` records automatically include active `traceId`, `spanId`, `parentSpanId`, `traceFlags`, and `traceSampled` metadata.
- Made `LogBrewClient` queue access lock-protected so request handlers and logger providers can safely enqueue from concurrent async work.
- Added packaged `examples/HttpTraceCorrelation.cs` plus installed-artifact validation for async log, issue, request span, and request-duration metric correlation from one W3C trace.

## Where LogBrew Is Better Today

- Lighter and more explicit for teams that want request trace-log-error-metric correlation without a .NET profiler/agent, ASP.NET package dependency, OpenTelemetry setup, global HTTP patching, payload capture, header capture, or raw propagation serialization.
- The request helper records route templates after stripping query strings/fragments and keeps metadata primitive-only.
- `AsyncLocal` active trace support works with standard async execution and remains under app-owned scopes rather than hidden global middleware.

## Where LogBrew Is Still Worse

- No automatic ASP.NET Core middleware/filter package yet; users still wire the explicit `LogBrewServerRequestTelemetry` helper from app-owned middleware.
- No automatic `ActivitySource`/OpenTelemetry exporter or ASP.NET Core instrumentation package yet; apps still opt into the explicit LogBrew bridge.
- No outbound `HttpClient`, database, messaging, cache, or rich child-span auto-instrumentation.
- No baggage, tracestate, span events, or exception event modeling beyond primitive metadata.

## Updated Evidence

- `dotnet run --project dotnet/logbrew-dotnet/tests/LogBrew.Tests/LogBrew.Tests.csproj --configuration Release`: 29 tests including 6 trace-correlation tests.
- `bash scripts/check_dotnet_package.sh`: builds, packs, checks NuGet metadata and README payload, runs examples, and validates `HttpTraceCorrelation` output.
- `bash scripts/real_user_dotnet_smoke.sh`: installs the built `LogBrew` NuGet package into temporary apps, proves install/remove/reinstall, logger integration, HTTP retry, and packaged `HttpTraceCorrelation` output from the installed artifact.

The trace example verifies one trace/span pair across an async `ILogger` record, captured issue, request span, and `http.server.duration` metric; verifies outbound W3C `traceparent`; checks malformed incoming propagation does not fail request setup; and checks query strings, fragments, non-primitive metadata, and raw propagation headers are not serialized into LogBrew telemetry.

## 2026-06-20 ASP.NET Core Request Helper Follow-Up

### Additional Source Reviewed

- Sentry .NET `getsentry/sentry-dotnet@2f2842f20f9581468a0ab4e971bfd507557161b3`.
- Re-read `src/Sentry.AspNetCore/SentryTracingMiddleware.cs`: `InvokeAsync`, `TryStartTransaction`, route naming, custom sampling context, status/error finish behavior.
- Re-read `src/Sentry.AspNetCore/SentryMiddleware.cs`: trace/baggage continuation, scope configuration, exception capture, and original exception rethrow.
- Re-read `src/Sentry.AspNetCore/RouteUtils.cs`: `GetRouteTemplate`, `ResolveRouteTemplate`, route parameter replacement, and transaction-name formatting.
- Datadog .NET tracer `DataDog/dd-trace-dotnet@b92777ccdbd8bc7f7ad0a7cb59d5d53f638e93e1`.
- Read `tracer/src/Datadog.Trace/Tagging/AspNetCoreTags.cs`, `AspNetCoreEndpointTags.cs`, `AspNetCoreMvcTags.cs`, and `AspNetCoreSingleSpanTags.cs`: endpoint, route, controller/action, and HTTP status tagging.
- OpenTelemetry .NET `open-telemetry/opentelemetry-dotnet@98c3e0cda87f98b770166594549ab9888f450a0f`.
- Read `src/OpenTelemetry.Api/Context/Propagation/TraceContextPropagator.cs`: W3C `traceparent` extraction/injection and invalid-context no-op behavior.
- Read `examples/AspNetCore/Program.cs`: `AddAspNetCoreInstrumentation` plus logs/traces/metrics setup shape.
- PostHog .NET `PostHog/posthog-dotnet@620bc6785fc864d9534fb21a6e2f50295fc9b65d`.
- Read `src/PostHog.AspNetCore/Tracing/PostHogRequestContextMiddleware.cs`, `PostHogRequestContextMiddlewareExtensions.cs`, `PostHogRequestContextOptions.cs`, `PostHogTracingHeaders.cs`, and `tests/UnitTests.AspNetCore/PostHogRequestContextMiddlewareTests.cs`: request-local context scope, optional exception capture, metadata extraction failure isolation, and original exception preservation.

### Pattern

Sentry, Datadog, and OpenTelemetry are stronger for automatic ASP.NET Core instrumentation: they derive route/template/status context from framework middleware or diagnostic sources, keep request-local context active while handlers run, and finish spans after response/error status is known. PostHog's ASP.NET helper is a useful explicit pattern: middleware-owned scope, bounded request metadata, and exception rethrow.

### LogBrew Change

- Added `LogBrewServerRequestTelemetry.CaptureAsync(...)` and `LogBrewServerRequestOptions`.
- The helper starts one request trace context from a valid incoming W3C `traceparent`, keeps it active through the app-owned handler, captures one request span, optional `http.server.duration` metric, and optional exception issue, then preserves the original response status or rethrows the original exception.
- It keeps route-template metadata query/hash-free, drops unsafe metadata keys, accepts primitive metadata only through the shared SDK validator, reports capture failures through an optional callback, and does not patch ASP.NET Core, inspect request/response bodies, capture arbitrary headers, serialize raw `traceparent`, open support tickets, infer usage/quota, or flush automatically.
- Added packaged `examples/AspNetCoreRequestTelemetry.cs` and README guidance. The example filters `Microsoft` and `System` logger categories before adding LogBrew so hosting lifetime logs do not leak local listener URLs into telemetry.

### Evidence

- Red TDD: focused .NET tests failed on missing `LogBrewServerRequestTelemetry` and `LogBrewServerRequestOptions`.
- `dotnet run --project dotnet/logbrew-dotnet/tests/LogBrew.Tests/LogBrew.Tests.csproj --configuration Release`: 39 tests passed, including request span/metric/log correlation, exception issue capture with original exception preservation, and capture-failure isolation.
- `bash scripts/check_dotnet_package.sh`: passed with NuGet pack proof, README guidance, source example build, and packaged `AspNetCoreRequestTelemetry.cs` inclusion.
- `bash scripts/real_user_dotnet_smoke.sh`: passed with installed NuGet proof, local Kestrel request, incoming `traceparent`, app logger correlation, request span, duration metric, and validator checks that query text, raw `traceparent`, local URL, headers, cookies, and sensitive-looking text do not appear in emitted telemetry.

### Remaining Gap

LogBrew is now safer and lighter than automatic ASP.NET instrumentation for teams that want explicit app-owned request telemetry and installed-artifact proof. It remains weaker than Sentry/Datadog/OpenTelemetry for transparent automatic ASP.NET coverage, baggage/tracestate, rich span events/exceptions/links, profiling, and deep outbound/DB/cache/queue auto-instrumentation.

## 2026-06-21 Activity / OpenTelemetry Context Follow-Up

### Additional Source Reviewed

- Sentry .NET `getsentry/sentry-dotnet@2f2842f20f9581468a0ab4e971bfd507557161b3`.
- Read `src/Sentry.OpenTelemetry.Exporter/OtelPropagationContext.cs`: `Snapshot`, `Current`, `TraceId`, `SpanId`, `ParentSpanId`, and `IsSampled` read from `Activity.Current`.
- Read `src/Sentry.OpenTelemetry.Exporter/SentryPropagator.cs`: `Extract` and `Inject` mapping between Sentry trace headers and `ActivityContext`.
- Read `src/Sentry/HubExtensions.cs`: `GetTraceIdAndSpanId(...)` prefers an external propagation context snapshot before hub/scope fallbacks for logs and metrics.
- OpenTelemetry .NET `open-telemetry/opentelemetry-dotnet@98c3e0cda87f98b770166594549ab9888f450a0f`.
- Read `src/OpenTelemetry.Api/ActivityContextExtensions.cs`: validity check shape for default contexts.
- Read `src/OpenTelemetry/Logs/ILogger/OpenTelemetryLogger.cs`: `Log(...)` captures `Activity.Current` once while building log records.
- Read `src/OpenTelemetry.Api/Logs/LogRecordData.cs`: `SetActivityContext(...)` copies `TraceId`, `SpanId`, and `TraceFlags` or clears them when no activity exists.
- Datadog .NET tracer `DataDog/dd-trace-dotnet@b92777ccdbd8bc7f7ad0a7cb59d5d53f638e93e1`.
- Read `tracer/src/Datadog.Trace/Activity/ActivityListener.cs`: reflective `Activity.Current` access and DiagnosticSource compatibility.
- Read `tracer/src/Datadog.Trace/Activity/Handlers/ActivityHandlerCommon.cs`: W3C Activity trace/span/parent mapping into Datadog span context.
- Read `tracer/src/Datadog.Trace/Activity/OtlpHelpers.cs`: OTLP Activity trace/span conversion and validity checks.
- PostHog .NET `PostHog/posthog-dotnet@620bc6785fc864d9534fb21a6e2f50295fc9b65d`.
- Re-read `src/PostHog.AspNetCore/Tracing/PostHogRequestContextMiddleware.cs` and `PostHogTracingHeaders.cs`: explicit request-local scope and bounded request metadata extraction, but no W3C Activity bridge in the inspected source.

### Pattern

Sentry and OpenTelemetry make existing .NET `Activity` context the bridge between traces and logs: they snapshot or read `Activity.Current`, copy trace ID/span ID/flags, and avoid crashing when context is absent or invalid. Datadog is much heavier and maps Activity events through listener/profiler infrastructure. PostHog's inspected ASP.NET helper remains request-context oriented rather than W3C trace-context oriented.

### LogBrew Change

- Added `LogBrewTraceContext.TryCreateChildFromCurrentActivity(...)`, `TryCreateChildFromActivity(...)`, and `TryCreateChildFromActivityContext(...)`.
- The helpers copy only valid W3C `Activity` / `ActivityContext` trace ID, span ID, and recorded flag into a fresh LogBrew child context. The source Activity span becomes `parentSpanId`; LogBrew generates its own child span ID for local log/action/span/metric correlation.
- Null, unstarted, non-W3C, default, and all-zero contexts return `false` without throwing.
- The bridge does not add an OpenTelemetry package dependency, own exporters/processors, read tracestate or baggage, patch HTTP clients, capture payloads, serialize raw propagation headers, mutate `Activity.Current`, open support tickets, or infer usage/quota.
- Added packaged `examples/ActivityTraceCorrelation.cs`, README guidance, `scripts/check_dotnet_activity_trace_payload.py`, and source plus installed NuGet verifier coverage.

### Evidence

- Red TDD: focused .NET tests failed on missing `TryCreateChildFromActivity(...)` and `TryCreateChildFromCurrentActivity(...)`.
- `dotnet run --project dotnet/logbrew-dotnet/tests/LogBrew.Tests/LogBrew.Tests.csproj --configuration Release`: 43 tests passed, including Activity, Activity.Current, ActivityContext, and invalid-context cases.
- `bash scripts/check_dotnet_package.sh`: passed with NuGet pack proof, README guidance, packaged Activity example inclusion, source example run, and payload validation.
- `bash scripts/real_user_dotnet_smoke.sh`: passed with installed local NuGet proof, packaged Activity example run, log/action/span/metric correlation, Activity parent-span linkage, outgoing W3C `traceparent`, and checks that raw propagation text, incoming parent span ID, and non-primitive metadata do not appear in telemetry.

### Remaining Gap

LogBrew is now better for developers who want a lightweight, explicit bridge from existing .NET Activity/OpenTelemetry context into LogBrew without taking over exporters or global instrumentation. Sentry/Datadog/OpenTelemetry remain stronger for automatic ActivitySource collection, ASP.NET/HttpClient/DB/cache/queue instrumentation, baggage/tracestate, rich span events/exceptions/links, profiling, and deep framework auto-discovery.

## 2026-06-21 Activity and ActivityContext Bridge Follow-Up

### Source Basis

This follow-up uses the source already recorded above: Sentry .NET `getsentry/sentry-dotnet@2f2842f20f9581468a0ab4e971bfd507557161b3` OpenTelemetry exporter propagation context, OpenTelemetry .NET `open-telemetry/opentelemetry-dotnet@41d2bb5a5f29aa8ad8f6566041434dccfb6b3252` log `Activity` context capture, and Datadog .NET `DataDog/dd-trace-dotnet@f308e58bebac1cf0f977fae6ddbe68e2f3ff399a` async scope/log correlation paths. The source-backed pattern is that .NET users expect the platform `Activity` context to be the bridge between framework/OTel spans and logs.

### LogBrew Change

- Added `LogBrewTraceContext.TryCreateChildFromCurrentActivity(...)`, `TryCreateChildFromActivity(...)`, and `TryCreateChildFromActivityContext(...)`.
- The helpers copy only W3C trace ID, parent span ID, and sampled flag from an existing `Activity` or `ActivityContext`, reject null/non-W3C/default/all-zero contexts, and always create a fresh LogBrew child span.
- The bridge remains dependency-free: no OpenTelemetry package reference, exporters, processors, global ASP.NET/HTTP patching, baggage, tracestate, payload/header capture, raw propagation serialization, or mutation of `Activity.Current`.
- Added packaged `examples/ActivityTraceCorrelation.cs` plus README guidance and installed-artifact validation for Activity-to-LogBrew log/action/span/metric correlation.

### Evidence

- Red TDD: focused .NET tests failed on missing `TryCreateChildFromActivityContext(...)`.
- `dotnet run --project dotnet/logbrew-dotnet/tests/LogBrew.Tests/LogBrew.Tests.csproj --configuration Release`: 43 tests passed, including Activity, ActivityContext, current Activity, and invalid-context coverage.
- `bash scripts/check_dotnet_package.sh`: passed with NuGet pack proof, README guidance, source example build, packaged `ActivityTraceCorrelation.cs` inclusion, and payload validation.
- `bash scripts/real_user_dotnet_smoke.sh`: passed with packed NuGet install/remove/reinstall proof and installed Activity/ActivityContext bridge validation.

### Remaining Gap

LogBrew is now better for explicit, dependency-free .NET OTel/W3C interop when an app already owns `Activity` instrumentation. It is still weaker than Sentry/Datadog/OpenTelemetry for transparent automatic ASP.NET instrumentation, baggage/tracestate, rich span events/exceptions/links, profiling, and deep outbound `HttpClient`/EF/SqlClient/Redis/Kafka auto-instrumentation.

## 2026-06-21 Outbound HttpClient Follow-Up

### Additional Source Reviewed

- Sentry .NET `getsentry/sentry-dotnet@2f2842f20f9581468a0ab4e971bfd507557161b3`.
- Read `src/Sentry/SentryMessageHandler.cs`: `SendAsync`, `Send`, `PropagateTraceHeaders`, `AddTraceparentHeader`, and duplicate-header checks.
- Read `src/Sentry/SentryHttpMessageHandler.cs`: `ProcessRequest`, `HandleResponse`, HTTP span origin, method/server metadata, breadcrumb/status handling, and original exception preservation.
- OpenTelemetry .NET contrib `open-telemetry/opentelemetry-dotnet-contrib@b04a8ba4d4dadee7723fb0dac5c818de69ba3c50`.
- Read `src/OpenTelemetry.Instrumentation.Http/Implementation/HttpHandlerDiagnosticListener.cs`: DiagnosticSource start/stop/exception handling, propagator injection, request filtering, method/status tags, URL redaction path, and enrichment callbacks.
- Read `src/OpenTelemetry.Instrumentation.Http/HttpClientTraceInstrumentationOptions.cs`: `FilterHttpRequestMessage`, enrichment hooks, exception enrichment, and query-redaction configuration.
- Datadog .NET tracer `DataDog/dd-trace-dotnet@b92777ccdbd8bc7f7ad0a7cb59d5d53f638e93e1`.
- Read `tracer/src/Datadog.Trace/SpanContextInjector.cs`: explicit context injection seam for unsupported libraries.
- Read `tracer/src/Datadog.Trace/ClrProfiler/ScopeFactory.cs`: outbound HTTP scope creation, nested-instrumentation avoidance, cleaned URI resource naming, status/tag population, and excluded URL handling.
- Read `tracer/src/Datadog.Trace/Activity/Handlers/ActivityHandlerCommon.cs`: Activity trace/span mapping and invalid Activity suppression.
- PostHog .NET `PostHog/posthog-dotnet@620bc6785fc864d9534fb21a6e2f50295fc9b65d`.
- Re-read `src/PostHog.AspNetCore/Tracing/PostHogRequestContextMiddleware.cs` and `PostHogTracingHeaders.cs`: request-local context and bounded header extraction; no outbound W3C `HttpClient` span propagation was found in inspected source.

### Pattern

Sentry, Datadog, and OpenTelemetry are stronger for transparent outbound HTTP instrumentation: they wrap handlers or subscribe to `System.Net.Http` DiagnosticSource/Activity events, inject propagation, create client spans, enrich status/error metadata, and avoid duplicate instrumentation. That power comes with broader capture surfaces, handler/global instrumentation, richer URL/host tagging, baggage/tracestate paths, and more moving parts.

The source-backed lightweight pattern LogBrew can safely adopt in the core SDK is explicit app-owned send wrapping: the app chooses the `HttpClient`, request, route template, and metadata; LogBrew creates one child span, injects one normalized W3C `traceparent`, keeps the child trace active during the send, and records only sanitized primitive metadata.

### LogBrew Change

- Added `LogBrewHttpClientTelemetry.SendAsync(...)` and `LogBrewHttpClientOptions`.
- Added `LogBrewHttpClientHandler` for apps that already compose outbound clients through `DelegatingHandler` or `IHttpClientFactory` pipelines.
- Added `WithRequestFilter(...)` and `WithRouteTemplateSelector(...)` so handler/typed-client users can skip noisy calls and choose low-cardinality route names per request without global instrumentation.
- The helper creates a child context from `LogBrewTrace.Current`, or from `Activity.Current` when no LogBrew trace is active, otherwise a local root.
- `SendAsync(...)` and `LogBrewHttpClientHandler` share one telemetry core: overwrite any existing request `traceparent` with one normalized child-span header, send through the app-owned HTTP path, preserve the original response/exception/cancellation behavior, and capture one `HTTP {METHOD} {routeTemplate}` span.
- Span metadata is privacy-bounded: `source=http.client`, normalized method, route template, status code, sampled flag, exception type only, and safe primitive app metadata after dropping unsafe dependency keys.
- Added shared `TelemetryMetadata.CopySafeDependencyMetadata(...)` so operation spans and outbound HTTP spans use the same unsafe dependency metadata filter.
- Added packaged `examples/HttpClientOutboundTelemetry.cs`, `scripts/check_dotnet_http_client_payload.py`, README guidance, Makefile target, source package proof, installed NuGet proof, and release metadata validation.

### Evidence

- Red TDD: focused .NET tests failed on missing `LogBrewHttpClientTelemetry`/`LogBrewHttpClientOptions`, then missing `LogBrewHttpClientHandler`, then missing `WithRequestFilter(...)` and `WithRouteTemplateSelector(...)`.
- `dotnet run --project dotnet/logbrew-dotnet/tests/LogBrew.Tests/LogBrew.Tests.csproj --configuration Release`: 50 tests passed, including outbound helper and handler traceparent injection, active child context during send, filtered-request no-capture/no-header-mutation behavior, per-request route template selection, sanitized span metadata, original exception preservation, capture-failure isolation, and option validation.
- `bash scripts/check_dotnet_package.sh`: passed with NuGet pack proof, packaged example inclusion, source example execution through `LogBrewHttpClientHandler`, handler/filter/selector symbol inclusion, and outbound HTTP payload validation.
- `bash scripts/real_user_dotnet_smoke.sh`: passed after a retry; first run failed because the existing ASP.NET readiness loop expired while `dotnet run` was still at `Building...`. The readiness loop was increased from 20s to 40s to reduce cold-build flake.
- Static and hygiene gates passed: release metadata, ShellCheck 0.11.0, markdown links, backend contract reports, confidentiality scan, generated-artifact hygiene, `git diff --check`, automation TOML parse/prompt-size check, and thermo review.

### Remaining Gap

LogBrew is now better for teams that want explicit installed-package outbound HTTP trace propagation through either a one-off send helper or normal handler pipeline without global patching, baggage/tracestate, URL/header/body capture, or profiler setup. Sentry, Datadog, and OpenTelemetry remain stronger for automatic transparent `HttpClient` instrumentation, request filtering at instrumentation level, richer semantic conventions, baggage/tracestate, span events/exceptions/links, and deep automatic EF/SqlClient/Redis/Kafka instrumentation.

## 2026-06-21 Explicit Activity Span Capture Follow-Up

### Additional Source Reviewed

- Sentry .NET `getsentry/sentry-dotnet@2f2842f20f9581468a0ab4e971bfd507557161b3`.
- Read `src/Sentry.OpenTelemetry/SentrySpanProcessor.cs`: `SentrySpanProcessor.OnStart(...)`, `OnEnd(...)`, Activity-to-transaction/span mapping, tag/resource copying, HTTP status mapping, status/description parsing, and exception-event synthesis.
- Read `src/Sentry.OpenTelemetry.Exporter/ActivityExtensions.cs`: `ActivitySpanId`/`ActivityTraceId` to Sentry ID conversion.
- Read `src/Sentry.OpenTelemetry/OpenTelemetryExtensions.cs`: HTTP method/full-URL/status attribute helpers.
- Read `src/Sentry.OpenTelemetry/TracerProviderBuilderExtensions.cs`: `AddSentry(...)` processor registration and propagator setup.
- OpenTelemetry .NET `open-telemetry/opentelemetry-dotnet@98c3e0c`.
- Read `src/OpenTelemetry/BaseProcessor.cs`: processor lifecycle contract for `OnStart(...)`, `OnEnd(...)`, force flush, and shutdown.
- Read `src/OpenTelemetry.Exporter.Console/ConsoleActivityExporter.cs`: exported Activity fields for trace ID, span ID, parent span ID, flags, kind, display name, status, duration, tags, events, links, source, and resource attributes.
- Datadog .NET tracer `DataDog/dd-trace-dotnet@b92777ccdbd8bc7f7ad0a7cb59d5d53f638e93e1`.
- Read `tracer/src/Datadog.Trace/Activity/ActivityListener.cs`, `ActivityListenerHandler.cs`, `Activity/OtlpHelpers.cs`, and `Activity/Handlers/DisableActivityHandler.cs`: ActivitySource listener setup, W3C ID forcing, disabled-source matching, tag/event/link/status copying, and OTel semantic mapping.

### Pattern

Sentry, Datadog, and OpenTelemetry are still stronger for automatic `ActivitySource` collection because they install processors/listeners, receive every matching Activity, and copy richer Activity tags/events/links/resources into exported spans. That improves transparent coverage but also broadens dependency, lifecycle, and privacy surfaces through global registration, richer attribute capture, baggage/tracestate paths, and automatic framework ownership.

The safer LogBrew core pattern is explicit capture from an app-owned `Activity`: use the Activity's W3C trace/span IDs when the caller asks, copy only a small safe semantic allowlist, and preserve existing app/framework instrumentation ownership.

### LogBrew Change

- Added `LogBrewActivitySpanTelemetry.Capture(...)` and `LogBrewActivitySpanOptions`.
- The helper captures one LogBrew span from a valid W3C `System.Diagnostics.Activity`, using the Activity trace ID/span ID, optional parent span ID, recorded flag, duration, Activity name/kind/source metadata, and a safe primitive tag allowlist for HTTP method/route/status, DB system/operation, and messaging system/operation.
- Invalid null, unstarted, non-W3C, default, or all-zero Activities return `false` without queuing telemetry.
- SDK capture failures, such as invalid timestamps, report through optional `OnError(...)` and do not interrupt app-owned Activity or request flows.
- The helper remains dependency-free: no OpenTelemetry package reference, exporters, processors, ActivityListener, DiagnosticSource subscription, global HTTP/ASP.NET patching, baggage, tracestate, raw traceparent serialization, headers, payloads, full URLs, query strings, or support-ticket behavior.
- Updated packaged `examples/ActivityTraceCorrelation.cs`, README guidance, and `scripts/check_dotnet_activity_trace_payload.py` so installed-package proof covers both Activity-to-child LogBrew correlation and the Activity span itself.
- Bumped the scoped NuGet package version to `LogBrew` `0.1.2` for a changed-package release after CI/publish verification.

### Evidence

- Red TDD: focused .NET tests failed on missing `LogBrewActivitySpanTelemetry` and `LogBrewActivitySpanOptions`.
- `dotnet run --project dotnet/logbrew-dotnet/tests/LogBrew.Tests/LogBrew.Tests.csproj --configuration Release`: 54 tests passed, including explicit Activity span capture, invalid Activity suppression, capture-failure isolation, and option validation.
- `bash scripts/check_dotnet_package.sh`: passed with NuGet pack proof, README guidance, source example execution, packaged Activity example inclusion, and payload validation for the Activity span plus privacy exclusions.
- `bash scripts/real_user_dotnet_smoke.sh`: passed with packed NuGet install/remove/reinstall proof and installed Activity span payload validation.

## 2026-06-21 Optional ASP.NET Core Middleware Package Follow-Up

### Additional Source Reviewed

- Sentry .NET `getsentry/sentry-dotnet@2f2842f20f9581468a0ab4e971bfd507557161b3`.
- Read `src/Sentry.AspNetCore/SentryTracingMiddleware.cs`: `TryStartTransaction(...)`, `InvokeAsync(...)`, request transaction activation, route/status finishing, and original exception rethrow.
- Read `src/Sentry.AspNetCore/SentryMiddleware.cs`: `InvokeAsync(...)`, trace/baggage continuation through `HttpContext.Items`, request scope setup, exception capture, and flush behavior.
- Read `src/Sentry.AspNetCore/ApplicationBuilderExtensions.cs`, `SentryTracingMiddlewareExtensions.cs`, `RouteUtils.cs`, and `Extensions/HttpContextExtensions.cs`: middleware registration, duplicate-registration guard, route-template formatting, and transaction-name selection.
- OpenTelemetry .NET contrib `open-telemetry/opentelemetry-dotnet-contrib@b04a8ba4d4dadee7723fb0dac5c818de69ba3c50`.
- Read `src/OpenTelemetry.Instrumentation.AspNetCore/Implementation/HttpInListener.cs`: `OnStartActivity(...)`, `OnStopActivity(...)`, `OnException(...)`, W3C extraction, route/status/error tagging, query redaction, and enrichment failure isolation.
- Read `src/OpenTelemetry.Instrumentation.AspNetCore/AspNetCoreTraceInstrumentationOptions.cs` and `AspNetCoreInstrumentationTracerProviderBuilderExtensions.cs`: filter/enrich options, instrumentation registration, ActivitySource selection, and duplicate DiagnosticSource subscription protection.
- Datadog .NET tracer `DataDog/dd-trace-dotnet@b92777ccdbd8bc7f7ad0a7cb59d5d53f638e93e1`.
- Read `tracer/src/Datadog.Trace/PlatformHelpers/AspNetCoreHttpRequestHandler.cs`: `StartAspNetCorePipelineScope(...)`, `StopAspNetCorePipelineScope(...)`, `HandleAspNetCoreException(...)`, and `CopyAspNetCoreActivityTagsIfRequired(...)`.
- Read `tracer/src/Datadog.Trace/DiagnosticListeners/AspNetCoreDiagnosticObserver.cs`, `AspNetCoreResourceNameHelper.cs`, `Tagging/AspNetCoreTags.cs`, and `AspNetCoreEndpointTags.cs`: DiagnosticSource routing, endpoint route simplification, and route/status tag shape.
- PostHog .NET `PostHog/posthog-dotnet@620bc6785fc864d9534fb21a6e2f50295fc9b65d`.
- Read `src/PostHog.AspNetCore/Tracing/PostHogRequestContextMiddleware.cs`, `PostHogRequestContextMiddlewareExtensions.cs`, `PostHogRequestContextOptions.cs`, and `PostHogTracingHeaders.cs`: explicit middleware-owned request scope, optional exception capture, bounded header/context parsing, and original exception preservation.

### Pattern

Sentry, Datadog, and OpenTelemetry are stronger for automatic ASP.NET Core coverage because they own middleware or DiagnosticSource listeners, derive route/status/error context after the framework has selected an endpoint, keep request-local scope active while handlers run, and finish spans after the downstream pipeline returns or throws. PostHog shows a lighter explicit package pattern: opt-in middleware, bounded request context, failure isolation, and original exception rethrow.

### LogBrew Change

- Added a separate `LogBrew.AspNetCore` package instead of adding ASP.NET Core framework dependencies to the base `LogBrew` NuGet package.
- Added `app.UseLogBrewRequestTelemetry(client, options => ...)` with `LogBrewAspNetCoreOptions`.
- The middleware extracts a route template from `RouteEndpoint.RoutePattern.RawText` by default, supports `WithRouteTemplateSelector(...)` for low-cardinality app-owned names, and supports `WithRequestFilter(...)` for health/noisy route suppression.
- It delegates serialization to the existing `LogBrewServerRequestTelemetry` core helper: one request span, optional `http.server.duration` metric, optional exception issue, active `LogBrewTrace.Current` while downstream handlers run, original response status, and original exception rethrow.
- It supports static metadata and per-request `WithMetadataProvider(...)`; unsafe keys and non-primitive values are still filtered by the core request helper.
- It intentionally avoids request/response bodies, arbitrary headers, raw `traceparent` serialization, query strings, network origins, baggage, tracestate, support-ticket creation, usage/quota inference, global ASP.NET patching, DiagnosticSource subscription, Activity processors, and automatic flush.
- Added packaged `examples/AspNetCoreMiddlewareTelemetry.cs`, a dedicated `LogBrew.AspNetCore` README, release metadata validation for both NuGet packages, duplicate-safe NuGet push wiring, and registry verification support for `LogBrew.AspNetCore`.

### Evidence

- Red TDD: focused ASP.NET Core tests failed on missing `UseLogBrewRequestTelemetry(...)`.
- `dotnet run --project dotnet/logbrew-dotnet/tests/LogBrew.AspNetCore.Tests/LogBrew.AspNetCore.Tests.csproj --configuration Release`: 4 tests passed, covering active trace/log correlation, route-template span/metric output, absolute-selector URL stripping, unsafe metadata dropping, exception preservation, and filter skip behavior.
- `bash scripts/check_dotnet_package.sh`: passed with 54 core tests, 4 ASP.NET Core tests, both NuGet package builds, nupkg metadata/readme/example inspection, source example builds, and Makefile helper discovery.
- `bash scripts/real_user_dotnet_smoke.sh`: passed with packed local `LogBrew` plus `LogBrew.AspNetCore` packages, installed package graph/install-remove-reinstall proof, manual ASP.NET Core request helper proof, and installed `LogBrew.AspNetCore` Kestrel middleware proof using incoming W3C `traceparent` while checking that query text, raw propagation, local URL, headers, cookies, and sensitive-looking text are absent from emitted telemetry.

### Remaining Gap

LogBrew is now stronger for teams that want a small opt-in ASP.NET Core middleware package with installed-package proof, predictable privacy boundaries, and no global instrumentation. Sentry, Datadog, and OpenTelemetry remain stronger for transparent DiagnosticSource/ActivitySource instrumentation, richer semantic conventions, baggage/tracestate, span events/exceptions/links, profiling, and automatic outbound/EF/SqlClient/Redis/Kafka coverage.

### Remaining Gap

LogBrew is now better for teams that want explicit, lightweight Activity span capture without taking over OpenTelemetry exporters/processors or globally listening to all `ActivitySource` data. Sentry, Datadog, and OpenTelemetry remain stronger for automatic ActivitySource/ASP.NET/HttpClient/EF/SqlClient/Redis/Kafka instrumentation, baggage/tracestate, rich span events/exceptions/links, resource attributes, profiling, and deeper semantic conventions.

## 2026-06-22 Dependency Span Installed-Artifact Proof

### Source Basis

This verifier-focused follow-up uses the existing source evidence above for Sentry .NET outbound/Activity patterns, OpenTelemetry .NET HTTP/ASP.NET instrumentation, and Datadog .NET scope/HTTP/Activity handling. The same competitor pattern applies to dependency spans: Sentry, Datadog, and OpenTelemetry are stronger where they can auto-instrument EF/SqlClient/Redis/Kafka-style libraries, while LogBrew's safer current boundary is explicit app-owned operation wrapping with low-cardinality names and primitive metadata.

### LogBrew Change

- Added packaged `examples/DependencySpansTelemetry.cs` for the existing `LogBrewOperationTracing` database, cache, and queue helpers.
- Added `scripts/check_dotnet_dependency_spans_payload.py` and wired it into `bash scripts/check_dotnet_package.sh`.
- The temporary-app proof creates one database span, one cache span, and one queue span under the same W3C parent trace, verifies callback result preservation, and checks dependency metadata redaction for raw statements, connection details, cache identifiers, and message contents.
- No new runtime dependency, profiler, EF/Redis/Kafka client hook, global instrumentation, body/header/query capture, baggage, tracestate, support-ticket behavior, or usage/quota inference was added.

### Evidence

- Red TDD: `python3 scripts/check_release_metadata.py` failed on missing `examples/DependencySpansTelemetry.cs` and missing package include.
- `python3 scripts/check_release_metadata.py`: passed after implementation.
- `python3 -m unittest tests/test_release_metadata.py`: 12 tests passed.
- `bash scripts/check_dotnet_package.sh`: passed with 59 core tests, 4 ASP.NET Core tests, NuGet pack proof, source example execution, and dependency span payload validation.

### Remaining Gap

LogBrew now has installed-artifact proof for explicit DB/cache/queue operation spans, which is safer and easier to audit than hidden dependency auto-instrumentation. It is still weaker than Sentry/Datadog/OpenTelemetry for automatic EF/SqlClient/Redis/Kafka discovery, richer semantic conventions, span events/exceptions/links, baggage/tracestate, and profiling.
