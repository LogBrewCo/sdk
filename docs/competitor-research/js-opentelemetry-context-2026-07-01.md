# JavaScript OpenTelemetry Context Bridge - 2026-07-01

## Scope

Close a high-impact JavaScript rich-trace gap: apps that already use OpenTelemetry JS should be able to correlate LogBrew logs/actions/spans with the active OTel trace without replacing their tracer provider, exporter, processor, or instrumentation stack.

## Public Source Read

- Sentry JavaScript `getsentry/sentry-javascript@e3161515dd5324e664b97e69ddcb7fa8ef6cd838`: read `packages/opentelemetry/src/trace.ts` `_startSpan(...)`, `startSpan(...)`, `withActiveSpan(...)`, `getContext(...)`, `continueTrace(...)`, `startNewTrace(...)`, `getTraceContextForScope(...)`; the same package's async context setup module; `packages/opentelemetry/src/utils/getActiveSpan.ts` `getActiveSpan()`; `packages/opentelemetry/src/utils/getTraceData.ts` `getTraceData(...)`; `packages/opentelemetry/src/contextManager.ts` `wrapContextManagerClass(...)`; and worker-runtime OTel tracer shims that expose `setupOpenTelemetryTracer(...)`. Pattern: Sentry can make OTel the active context layer, register/wrap tracer providers, start active/inactive spans, continue remote traces with OTel `SpanContext`, and generate outbound trace headers from active OTel state.
- OpenTelemetry JavaScript `open-telemetry/opentelemetry-js@c989308b87403e19923f440810d6ab47e7c2ba0d`: read `api/src/trace/context-utils.ts` `getActiveSpan()`, `setSpan(...)`, `setSpanContext(...)`, `getSpanContext(...)`; `api/src/trace/spancontext-utils.ts` `isValidTraceId(...)`, `isValidSpanId(...)`, `isSpanContextValid(...)`, `wrapSpanContext(...)`; `api/src/trace/trace_flags.ts` `TraceFlags`; `api/src/trace/span_context.ts` `SpanContext`; `api/src/trace/NoopTracer.ts` `startSpan(...)`/`startActiveSpan(...)`; and `api/src/trace/NonRecordingSpan.ts` `spanContext()`. Pattern: OTel JS represents trace/span IDs as strings, sampled state as bit `0x01`, active spans in context values, and non-recording spans as valid propagation carriers even without an SDK exporter.
- Datadog JavaScript `DataDog/dd-trace-js@7ffe20cf044810793377b05f4e97490ecd2c903c`: read `packages/dd-trace/src/opentelemetry/tracer.js` `startSpan(...)`, `startActiveSpan(...)`, `_convertOtelContextToDatadog(...)`; `packages/dd-trace/src/opentelemetry/span_context.js` `traceId`, `spanId`, `traceFlags`, `traceState`; `packages/dd-trace/src/opentelemetry/span.js` `spanContext()`, `end(...)`; `packages/datadog-plugin-prisma/src/datadog-tracing-helper.js` `getTraceParent(...)`; and `packages/datadog-plugin-prisma/test/integration-test/server-ts-v7-otel.mjs`. Pattern: Datadog offers a full OTel-compatible tracer/provider bridge around Datadog spans, maps OTel parents into Datadog contexts, preserves traceparent/tracestate enough for DBM paths, and verifies active OTel spans through a real Prisma integration test.
- PostHog JavaScript `PostHog/posthog-js@a5181ba36f64cf69108be2f0fbf1e68dbeb4e827`: read `packages/ai/src/otel/processor.ts` `PostHogSpanProcessor`, `packages/ai/src/otel/exporter.ts` `PostHogTraceExporter`, `packages/ai/src/otel/redact.ts` `redactSpan(...)`, `packages/ai/src/otel/spans.ts` `isAISpan(...)`, and `packages/ai/tests/otel.test.ts` / `packages/ai/tests/processor.test.ts`. Pattern: PostHog's OTel source focuses on AI span export/filtering/redaction through OTel processor/exporter hooks rather than a general active-context copy helper.

## Takeaways

- Sentry and Datadog remain stronger when users want the vendor SDK to own or deeply participate in the OpenTelemetry runtime, including tracer providers, context managers, processors, exporters, span lifecycle, semantic attributes, links, events, baggage, and tracestate.
- Native OTel JS is the source of truth for active span lookup and valid ID/sampled semantics. The useful dependency-optional boundary for LogBrew is to copy only public `SpanContext` IDs and sampled state.
- PostHog is stronger for AI-specific OTel export workflows, but not for general application trace correlation.
- A full JS OTel processor/exporter would increase dependency footprint and privacy surface. The safer market-ready step is copy-only correlation from existing OTel traces into LogBrew events.

## LogBrew Implementation

- Added `logbrewTraceContextFromOpenTelemetrySpanContext(...)`, `logbrewTraceContextFromOpenTelemetrySpan(...)`, and `logbrewTraceContextFromCurrentOpenTelemetrySpan(...)` to `@logbrew/sdk`.
- The helpers duck-type OTel objects and default installs add no `@opentelemetry/*` dependency.
- The current-span helper returns `null` when OTel is absent or no valid active span exists; when present it copies only valid trace ID, parent span ID, and sampled flag into a fresh LogBrew child span.
- It intentionally does not install OpenTelemetry, own tracer providers/exporters/processors, read attributes/events/links, ingest baggage/tracestate, serialize raw propagation metadata, patch clients, or capture payloads, headers, cookies, full URLs, query strings, or fragments.

## Verification

- `npm test --prefix js/logbrew-js`
- `bash scripts/real_user_js_opentelemetry_smoke.sh`

Installed smoke evidence: packed `@logbrew/sdk@0.1.3`, installed/removed/reinstalled it in a temporary ESM app, proved `logbrewTraceContextFromCurrentOpenTelemetrySpan()` returns `null` before OTel install, installed `@opentelemetry/api@1.9.1` and `@opentelemetry/context-async-hooks@2.8.0`, typechecked packaged declarations with `typescript@5.9.2`, activated a real OTel `NonRecordingSpan` through `AsyncLocalStorageContextManager`, and verified LogBrew log/span/action correlation plus normalized downstream `traceparent`.

## Honest Gap After This Pass

LogBrew is now better for a small, dependency-optional, privacy-bounded active OTel trace copy helper that works from the core package and keeps first-event setup light. Sentry and Datadog remain stronger for full JS OTel runtime ownership, automatic instrumentation, processor/exporter interop, semantic attributes, span events/exceptions/links, baggage/tracestate, and framework/driver auto-patching. PostHog remains stronger for AI-specific OTel export. The next JavaScript trace priority should be source-backed automatic framework/driver spans or full OTel processor/exporter interop only when it can preserve clear install guidance, safe defaults, and fake-intake proof.
