# JavaScript OpenTelemetry Exception Trace Summaries - 2026-07-04

## User Gap

JavaScript services that already emit OpenTelemetry spans often record exceptions as span events. Before this pass, LogBrew could queue OTel spans, safe span events, links, and trace summaries, but an escaped OTel exception event on an unset-status span was easy to miss unless the app also set OTel status to error. A real debugging view needs to show that the trace contains exception events without copying exception messages or stacks.

## Source Reading

- Sentry JavaScript `68fe9e8fbcf70f1a92468410a1686787d4f724a6`
- `packages/core/src/utils/spanUtils.ts`: `spanToJSON(...)`, `spanToStreamedSpanJSON(...)`, `getStatusMessage(...)`, `getSimpleStatus(...)`, `addStatusMessageAttribute(...)`.
- `packages/core/src/fetch.ts`: `instrumentFetchRequest(...)`, `endSpan(...)`; failed fetches set span status to error.
- `packages/core/src/tracing/sentrySpan.ts`: `recordException(...)` is present for compatibility, while Sentry's primary browser/server flows attach error state through events and span status.
- Pattern: Sentry makes status and error state easy to see in span JSON and streamed span payloads. Strong for time-to-answer; heavier hosted behavior remains outside LogBrew's SDK boundary.

- OpenTelemetry JS `d9c170c94884e345dff6d67322794e85e6e07f18`
- `packages/sdk-trace/src/export/ReadableSpan.ts`: `ReadableSpan` exposes status, events, links, resource, scope, and dropped counts.
- `packages/sdk-trace/src/Span.ts`: `setStatus(...)` validates status messages; `recordException(...)` creates an `exception` event with `exception.type`, `exception.message`, and `exception.stacktrace`.
- `packages/opentelemetry-exporter-zipkin/src/transform.ts`: exporter transforms span events and status into downstream annotations/tags.
- Pattern: OTel keeps exception details in span events; exporters decide what to preserve. LogBrew should copy useful event summaries, not full exception text.

- Datadog `dd-trace-js` `9919e404a97345a652d0090e281dd3d278077c86`
- `packages/dd-trace/src/span_format.js`: `extractError(...)`, `writeErrorMeta(...)` mark spans as error and write error type/message/stack metadata.
- `packages/datadog-plugin-graphql/src/execute.js`: `finishResolveSpan(...)` tags resolver spans with errors before finish.
- Pattern: Datadog makes span errors highly discoverable and includes rich error fields. Useful, but broader than LogBrew's default privacy boundary.

- PostHog JS `e480a3e23ecff45d2f9cf50332f6f59c54a7c736`
- `packages/node/src/client.ts`: `captureException(...)`, `captureExceptionImmediate(...)`.
- `packages/react-native/src/posthog-rn.ts`: `captureException(...)`, `addExceptionStep(...)`.
- Pattern: PostHog captures exception context as a first-class product signal, though not as an OTel span processor bridge.

## LogBrew Change

- `@logbrew/sdk` now summarizes OTel `exception` span events in `spanAttributesFromOpenTelemetryReadableSpan(...)`, the OTel span processor, and the OTel span exporter.
- Span metadata now includes `otel.exception_event_count`, optional `otel.exception_escaped_count`, and safe bounded comma-separated `otel.exception_types`.
- Trace summaries now include `otel.trace.exception_event_count`, optional `otel.trace.exception_escaped_count`, and safe comma-separated `otel.trace.exception_types`.
- If OTel status is unset and at least one exception event has `exception.escaped === true`, the LogBrew span becomes `error`. Explicit OTel `OK` status remains `ok`.
- Exception counts scan the readable span's events, while emitted exception type lists remain bounded. LogBrew still omits exception messages, stacks, raw propagation headers, full URLs, DB statements, payloads, baggage, and tracestate by default.

## Verification

- RED: `node --test --test-name-pattern "OpenTelemetry trace summary records escaped exception event summaries" js/logbrew-js/test/sdk.test.js` failed because the span stayed `ok` and no exception summary metadata existed.
- GREEN: `npm --prefix js/logbrew-js test` passed with 92 tests.
- GREEN installed-artifact proof: `bash scripts/real_user_js_opentelemetry_smoke.sh` packed `@logbrew/sdk`, installed it in a temporary app, installed current OTel packages, typechecked public APIs, and asserted processor/exporter payloads include safe exception counts/types while omitting unsafe OTel fields.

## Remaining Gaps

- Sentry and Datadog still lead on hosted trace UI, error grouping, span-to-error navigation, and richer automatic instrumentation.
- LogBrew still does not own OTel providers, processors, exporters, baggage, tracestate, or auto instrumentation. That keeps the SDK lighter, but full OTel pipeline interop remains a future gap.
