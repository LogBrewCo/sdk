# .NET Support Ticket Diagnostics Research - 2026-06-20

## Goal

Prepare .NET developers and support agents for the planned backend support-ticket API without calling routes that are not live yet. The safer SDK gap is a local, typed, token-free payload draft for explicit user or agent handoff. LogBrew must not silently open tickets, infer backend ownership, or leak credentials in diagnostics.

## Source Evidence

- Sentry .NET `getsentry/sentry-dotnet@2f2842f20f9581468a0ab4e971bfd507557161b3`: read `src/Sentry/SentryOptions.cs` `SendDefaultPii`, `BeforeSendInternal`, `SetBeforeSend(...)`, and `AddEventProcessor(...)`; `src/Sentry/SentryClient.cs` `CaptureEvent(...)`; `src/Sentry/Internal/SentryEventHelper.cs` `DoBeforeSend(...)`; `src/Sentry.AspNetCore/ScopeExtensions.cs` request/header PII gating.
- Datadog .NET `DataDog/dd-trace-dotnet@b92777ccdbd8bc7f7ad0a7cb59d5d53f638e93e1`: read `tracer/src/Datadog.Trace/Util/Http/QueryStringManager.cs` `TruncateAndObfuscate(...)`; `QueryStringObfuscation/RedactAllObfuscator.cs` `Obfuscate(...)`; `Logging/Internal/ExceptionRedactor.cs` `Redact(...)`; `Span.cs` `SetExceptionTags(...)`; `Ci/CiEnvironment/CIEnvironmentValues.cs` `RemoveSensitiveInformationFromUrl(...)`.
- OpenTelemetry .NET `open-telemetry/opentelemetry-dotnet@98c3e0cda87f98b770166594549ab9888f450a0f`: read `src/OpenTelemetry.Api/Trace/SpanContext.cs` `IsValid`; `ActivityContextExtensions.cs` `IsValid(...)`; `Context/Propagation/TraceContextPropagator.cs` `Inject(...)` and `TryExtractTraceparent(...)`; `Logs/LogRecordData.cs` trace/span context fields.
- PostHog .NET `PostHog/posthog-dotnet@620bc6785fc864d9534fb21a6e2f50295fc9b65d`: read `src/PostHog/IPostHogClient.cs` `Capture(...)` and `CaptureException(...)`; `PostHogClient.cs` `CaptureExceptionCore(...)`; `PostHog.AspNetCore/Tracing/PostHogTracingHeaders.cs` `Extract(...)`, `SanitizeHeaderValue(...)`, `SanitizeValue(...)`, `GetCurrentUrl(...)`, and `GetRequestPath(...)`; `PostHogRequestContextMiddleware.cs` exception capture path.

## Competitor Patterns

- Sentry is strongest for full telemetry mutation: event processors and `beforeSend` can inspect, mutate, or drop captured events before transport. This is powerful for hosted telemetry, but too broad for support diagnostics because it runs inside the capture pipeline and can carry request/event context.
- Datadog has strong redaction primitives for internal telemetry and HTTP/query handling. It keeps dedicated exception redaction paths for internal logs, but normal span error tags can still include exception messages and stacks.
- OpenTelemetry is the cleanest source for trace/span validity and W3C traceparent behavior. It validates trace/span identifiers and copies context into logs, but support payloads should not copy baggage, tracestate, or raw propagation metadata.
- PostHog keeps capture explicit and uses bounded request/header sanitization in ASP.NET helpers. It is less error-observability-focused than Sentry, but its safe string/header handling is a useful support-diagnostics pattern.

## LogBrew Implementation

- Added `SupportTicketDraftInput` and `SupportTicketDraft` to `LogBrew`.
- The helper validates planned source/category enums, required title/description, optional project/runtime/framework/package/version/release/event fields, and lowercases valid non-zero W3C trace IDs.
- Diagnostics are bounded to JSON-like values. Sensitive keys are redacted, URLs keep only path, local paths are replaced, exceptions keep only type, unsupported objects are omitted, and nested arrays/maps are depth/item-limited.
- The helper intentionally does not send data, open support tickets, call `POST /api/support/tickets`, use account/session API credentials, infer backend ownership, or treat planned routes as deployed.

## Honest Comparison

- Better than broad Sentry/PostHog mutation hooks for support diagnostics because the LogBrew helper is narrow, local-only, typed, and explicit. It cannot silently enqueue a support ticket or mutate telemetry.
- Safer than raw error/context upload because exception messages and stacks are not copied into support diagnostics by default.
- Still weaker than Sentry/Datadog on deployed support workflows, backend ticket storage/routing, and rich hosted issue workflows because backend support routes are not live yet.

## Verification

- TDD red: `dotnet run --project dotnet/logbrew-dotnet/tests/LogBrew.Tests/LogBrew.Tests.csproj --configuration Release` failed with missing `SupportTicketDraft` and `SupportTicketDraftInput`.
- Green: focused .NET tests passed with support draft payload shape, enum validation, trace ID validation, nested diagnostics redaction, URL-origin stripping, local-path redaction, exception type-only capture, unsupported-value omission, and no hidden token/path/origin/raw propagation leakage.
