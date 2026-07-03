# JavaScript OpenTelemetry Span Processor - 2026-07-01

## Goal

Improve LogBrew JavaScript rich trace interop for apps that already use OpenTelemetry. Before this pass, LogBrew could copy the active OTel span context into child LogBrew logs/spans/actions, but it could not consume ended OTel `ReadableSpan` data through a SpanProcessor-compatible path. That left LogBrew weaker than Sentry and OpenTelemetry for teams that expect existing OTel spans, events, links, route metadata, and flush/shutdown hooks to reach the observability backend.

## Source Evidence

- Sentry JavaScript: `getsentry/sentry-javascript@88e7ad5444ece21f074e53768cb8633e00fa3a2b`.
- Files read: `packages/opentelemetry/src/spanProcessor.ts` (`SentrySpanProcessor`, `onStart`, `onEnd`, `forceFlush`, `shutdown`, `backfillStreamedSpanDataFromOtel`) and `packages/opentelemetry/src/spanExporter.ts` (`SentrySpanExporter`, `export`, `flush`, `_maybeSend`, `createTransactionForOtelSpan`, `createAndFinishSpanForOtelSpan`, `getSpanData`).
- Pattern: Sentry installs a true OTel span processor, captures parent/scope state on start, converts ended OTel spans into transactions/spans, groups child spans under completed roots, preserves links and measurements, and flushes/clears through the exporter. Tradeoff: deep coupling, broad OTel span conversion, and more vendor-specific lifecycle behavior.

- OpenTelemetry JS: `open-telemetry/opentelemetry-js@c989308b87403e19923f440810d6ab47e7c2ba0d`.
- Files read: `packages/sdk-trace/src/SpanProcessor.ts` (`SpanProcessor` interface), `packages/sdk-trace/src/export/ReadableSpan.ts` (`ReadableSpan` shape), `packages/sdk-trace/src/export/SimpleSpanProcessor.ts` (`onEnd`, sampled-span guard, `forceFlush`, `shutdown`), and `packages/sdk-trace/src/export/BatchSpanProcessorBase.ts` (`_maxQueueSize`, `_addToBuffer`, `_flushAll`, `_flushOneBatch`, shutdown flush).
- Pattern: OTel processors are explicit provider hooks with predictable `onStart`, `onEnd`, `forceFlush`, and `shutdown`; the standard processors drop unsampled spans by default, bound queue size, and make flush/shutdown explicit.

- Datadog JavaScript: `DataDog/dd-trace-js@7ffe20cf044810793377b05f4e97490ecd2c903c`.
- Files read: `packages/dd-trace/src/opentelemetry/tracer.js` (`startSpan`, `_convertOtelContextToDatadog`, link normalization, attribute sanitization), `packages/dd-trace/src/opentelemetry/span.js` (`onEnd` bridge), and `packages/dd-trace/src/span_processor.js` (`process`, `export`, buffer/chunk behavior).
- Pattern: Datadog provides a rich OTel-compatible tracer shim that maps OTel spans/contexts/links into Datadog tracing. Tradeoff: broader runtime ownership and vendor trace-state handling.

- PostHog JavaScript: `PostHog/posthog-js@a5181ba36f64cf69108be2f0fbf1e68dbeb4e827`.
- Files read: `packages/ai/src/otel/processor.ts` (`PostHogSpanProcessor`, blank-key no-op, `onEnd` filtering), `packages/ai/src/otel/exporter.ts` (`PostHogTraceExporter`), `packages/ai/src/otel/redact.ts` (`redactSpan`), and `packages/ai/src/otel/spans.ts` (`isAISpan`).
- Pattern: PostHog is narrower than Sentry/Datadog: it uses a processor/exporter seam, filters to AI spans, and redacts before export. Tradeoff: useful only for a specific product domain.

## LogBrew Design

- Added dependency-free `spanAttributesFromOpenTelemetryReadableSpan(...)` for OTel `ReadableSpan`-like objects.
- Added `createLogBrewOpenTelemetrySpanProcessor(...)`, an opt-in SpanProcessor-compatible handle for app-owned OTel providers.
- The processor queues spans through the existing `LogBrewClient.span(...)` path and uses existing flush/shutdown transport behavior when an app provides a transport.
- It follows OTel sampled-span behavior by default; apps can opt into unsampled capture.
- It summarizes up to eight events and eight links, carries W3C trace/span IDs, duration, parent span ID, status, route/method/status metadata, service/environment resource metadata, instrumentation scope, span kind, and dropped-count metadata.
- It can also emit one opt-in synthetic trace summary span per trace with `includeTraceSummary: true`. The summary is created on `forceFlush()`/`shutdown()`, carries trace ID, span count, error count, root span ID/name/kind, duration, and safe route/service/environment metadata, and makes a flushed batch read like one request or transaction without adopting Sentry's transaction lifecycle.
- Concurrent `forceFlush()` calls share the in-flight flush so the same queued batch is not sent twice.
- It blocks high-risk OTel keys by default: full URLs, headers, query/fragment values, payload/body, cookies, private auth values, DB statements, exception messages, and stacks.
- Additional span, event, link, and resource attributes require explicit allowlists and still pass the sensitive-key block.

## Verification

- Red test first: `npm test` failed because `createLogBrewOpenTelemetrySpanProcessor` was not exported.
- Unit verification: `npm test` passed with 80 tests, including sanitized `ReadableSpan` conversion, SpanProcessor queue/drop/flush behavior, and concurrent `forceFlush()` coalescing.
- Installed-artifact verification: `bash scripts/real_user_js_opentelemetry_smoke.sh` passed. The temporary npm app installed the packed `@logbrew/sdk`, `@opentelemetry/api`, `@opentelemetry/context-async-hooks`, `@opentelemetry/sdk-trace-base`, and `typescript`; proved no-OTel fallback, active context copy, type declarations, real `BasicTracerProvider` ended-span processing, safe event/link metadata, and absence of blocked sensitive OTel keys in the flushed payload.
- Follow-up trace-summary verification: red `node --test --test-name-pattern "OpenTelemetry span processor can emit a trace summary" test/sdk.test.js` first failed with only two detail spans flushed. Green `npm test` passed with 81 tests after adding opt-in trace summaries. The installed-artifact smoke now proves `includeTraceSummary: true` against a real `BasicTracerProvider` and verifies the summary plus detail span still omit blocked URL, DB statement, exception message/stack, cache key, and API-key-like values.

## SpanExporter Follow-Up - 2026-07-03

### Source Refresh

- Sentry JavaScript current HEAD: `getsentry/sentry-javascript@cf895c95995a6dff121484eadfa3a82980646f91`.
- Files reread: `packages/opentelemetry/src/spanExporter.ts` (`SentrySpanExporter`, `export`, `flush`, `_maybeSend`, `createTransactionForOtelSpan`, `createAndFinishSpanForOtelSpan`, `getSpanData`) and `packages/opentelemetry/src/spanProcessor.ts` (`SentrySpanProcessor`, `forceFlush`, `shutdown`, `onEnd`). Pattern remained exporter-backed transaction/span grouping.

- OpenTelemetry JS current HEAD: `open-telemetry/opentelemetry-js@40d67b7690a61bd9af0a4e5b5b9f4a14b11fc50e`.
- Files read: `packages/sdk-trace/src/export/SpanExporter.ts` (`SpanExporter.export`, `shutdown`, optional `forceFlush`), `SimpleSpanProcessor.ts` (`onEnd`, `_doExport`, `forceFlush`, `shutdown`), `BatchSpanProcessorBase.ts` (`onEnd`, `_addToBuffer`, `_flushOneBatch`, `shutdown`), `ReadableSpan.ts`, and `SpanProcessor.ts`. Pattern: standard processors call exporter `export(spans, callback)`, then `forceFlush()`/`shutdown()` for lifecycle.

- PostHog JavaScript current HEAD: `PostHog/posthog-js@cc01eea218219b1f36145143c62586c66c459e84`.
- Files reread: `packages/ai/src/otel/exporter.ts` (`PostHogTraceExporter.export`) and `packages/ai/src/otel/processor.ts` (`PostHogSpanProcessor`, no-op missing-key behavior, `BatchSpanProcessor` delegation). Pattern: expose both exporter and processor seams, filter/redact before export.

- Datadog JavaScript current HEAD: `DataDog/dd-trace-js@80c5d963ec7ff5d20c7fc2d662deff463fd47843`.
- File reread: `packages/dd-trace/src/span_processor.js` (`SpanProcessor.process`, buffer/chunk checks, `_exporter.export`). Pattern: internal processor exports finished chunks through an exporter boundary.

### LogBrew Design

- Added `createLogBrewOpenTelemetrySpanExporter(...)`, an opt-in `SpanExporter`-compatible bridge for app-owned OTel processors such as `SimpleSpanProcessor` or `BatchSpanProcessor`.
- It uses the same dependency-free `ReadableSpan` conversion, sampled-span default, safe attribute allowlists, event/link bounds, trace summaries, queue behavior, and transport retry path as the existing processor.
- Export callbacks return the standard numeric shape used by OTel JS (`code: 0` for success, `code: 1` for failure) without importing OpenTelemetry packages into default installs.
- It reports failure for invalid inputs or calls after exporter shutdown, and otherwise lets the LogBrew client transport path handle retry/status behavior.
- It avoids owning tracer providers, instrumentation packages, exporters/processors beyond the returned app-owned object, global context managers, baggage, tracestate, payloads, headers, cookies, full URLs, query strings, DB statements, exception messages, and stacks.

### Verification

- Red first: `npm test --prefix js/logbrew-js -- --test-name-pattern "OpenTelemetry span exporter"` failed because `createLogBrewOpenTelemetrySpanExporter` was not exported.
- Green focused unit proof: same command passed after implementation.
- Full package unit proof: `npm test --prefix js/logbrew-js` passed with 82 tests.
- Installed-artifact proof: `bash scripts/real_user_js_opentelemetry_smoke.sh` packed local `@logbrew/sdk`, installed it into a temporary npm app, installed current `@opentelemetry/api@1.9.1`, `@opentelemetry/context-async-hooks@2.9.0`, `@opentelemetry/sdk-trace-base@2.9.0`, and `typescript`, then proved no-OTel fallback, type declarations, real `SimpleSpanProcessor(exporter)` export, trace summary, and blocked-value sanitization. The smoke intentionally uses the installed stable API shape, where `SimpleSpanProcessor` receives the exporter directly.

## Honest Comparison

LogBrew is now stronger for teams that want a small, explicit, dependency-free bridge from an existing OTel provider into LogBrew's queue/transport behavior without broad automatic capture. The processor and exporter seams cover both common integration styles: apps can register the LogBrew processor directly or pass the LogBrew exporter to their existing OTel processor chain. The opt-in trace summary narrows Sentry's root/child transaction readability advantage for flushed OTel batches while staying safer by default for public SDK privacy boundaries because it refuses high-risk OTel attributes unless they are safe and explicitly allowlisted.

LogBrew is still worse than Sentry, Datadog, and full OpenTelemetry for automatic framework instrumentation, full transaction assembly, streaming spans, advanced batching, OTLP/collector interoperability, baggage/tracestate, broad semantic-convention coverage, and automatic outbound/DB/cache/queue spans. Next highest-impact JavaScript trace work is real framework-owned automatic instrumentation where it can remain privacy-bounded, plus backend upload/symbolication contracts for time-to-answer on minified/native errors.
