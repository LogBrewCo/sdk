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

## Honest Comparison

LogBrew is now stronger for teams that want a small, explicit, dependency-free bridge from an existing OTel provider into LogBrew's queue/transport behavior without broad automatic capture. The opt-in trace summary narrows Sentry's root/child transaction readability advantage for flushed OTel batches while staying safer by default for public SDK privacy boundaries because it refuses high-risk OTel attributes unless they are safe and explicitly allowlisted.

LogBrew is still worse than Sentry, Datadog, and full OpenTelemetry for automatic framework instrumentation, full transaction assembly, streaming spans, advanced batching, OTel collector/exporter interoperability, baggage/tracestate, broad semantic-convention coverage, and automatic outbound/DB/cache/queue spans. Next highest-impact JavaScript trace work is real framework-owned automatic instrumentation where it can remain privacy-bounded, plus backend upload/symbolication contracts for time-to-answer on minified/native errors.
