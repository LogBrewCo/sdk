import {
  CACHE_LOOKUP_NANOS,
  EPOCH_SECONDS,
  START_NANOS,
  TRACE_FLAGS_SAMPLED,
  TRACE_ID,
  ZERO_SECONDS,
  assertExcludes,
  eventById,
  hrTime,
  lastPayload,
  metadataValue,
  pick,
  sampleClient,
  sampleOpenTelemetryReadableSpan,
  spanContextOf
} from "./tracing-helpers.js";
import { RecordingTransport, createLogBrewOpenTelemetrySpanProcessor } from "@logbrew/sdk";
import assert from "node:assert/strict";
import test from "node:test";

/**
 * @import { SampleReadableSpan } from "./tracing-helpers.js"
 */

const ROOT_SPAN_ID = "00f067aa0ba902b7";
const CHILD_SPAN_ID = "b7ad6b7169203331";
const QUERY_START_NANOS = 150_000_000;
const QUERY_END_NANOS = 220_000_000;
const QUERY_DURATION_NANOS = 70_000_000;
const REQUEST_END_NANOS = 400_000_000;
const REQUEST_DURATION_NANOS = 300_000_000;
const ESCAPED_EXCEPTION_NANOS = 170_000_000;
const CACHE_LOOKUP_COUNT = 9;
const EVEN_DIVISOR = 2;
const NO_REMAINDER = 0;
const SPAN_AND_SUMMARY_EVENTS = 3;
const EXCEPTION_EVENTS = 2;
const ESCAPED_EXCEPTIONS = 1;
const EXPECTED_SUMMARY_METADATA = {
  "db.system": "postgresql",
  "deployment.environment.name": "production",
  "http.request.method": "GET",
  "http.response.status_code": 200,
  "http.route": "/orders/:id",
  "otel.trace.error_span_count": 1,
  "otel.trace.exception_event_count": 2,
  "otel.trace.exception_types": "TypeError",
  "otel.trace.root_kind": "server",
  "otel.trace.root_name": "GET /orders/:id",
  "otel.trace.root_span_id": ROOT_SPAN_ID,
  "otel.trace.span_count": 2,
  "otel.trace.summary_kind": "rooted",
  "service.name": "checkout",
  source: "opentelemetry.trace_summary"
};

/**
 * @returns {SampleReadableSpan}
 */
function databaseChildSpan() {
  return {
    ...sampleOpenTelemetryReadableSpan(),
    attributes: {
      "db.statement": "select * from users where api_key = 'redacted'",
      "db.system": "postgresql"
    },
    duration: hrTime(ZERO_SECONDS, QUERY_DURATION_NANOS),
    endTime: hrTime(EPOCH_SECONDS, QUERY_END_NANOS),
    kind: 0,
    name: "SELECT orders.by_id",
    parentSpanContext: {
      spanId: ROOT_SPAN_ID,
      traceFlags: 1,
      traceId: TRACE_ID
    },
    spanContext: spanContextOf(TRACE_ID, CHILD_SPAN_ID, TRACE_FLAGS_SAMPLED),
    startTime: hrTime(EPOCH_SECONDS, QUERY_START_NANOS),
    status: { code: 2 }
  };
}

/**
 * @returns {SampleReadableSpan}
 */
function rootRequestSpan() {
  return {
    ...sampleOpenTelemetryReadableSpan(),
    attributes: {
      "http.request.method": "GET",
      "http.response.status_code": 200,
      "http.route": "/orders/:id",
      "url.full": "https://api.example/orders/42?api_key=redacted#frag"
    },
    duration: hrTime(ZERO_SECONDS, REQUEST_DURATION_NANOS),
    endTime: hrTime(EPOCH_SECONDS, REQUEST_END_NANOS),
    kind: 1,
    name: "GET /orders/:id",
    parentSpanContext: undefined,
    parentSpanId: undefined,
    spanContext: spanContextOf(TRACE_ID, ROOT_SPAN_ID, TRACE_FLAGS_SAMPLED),
    startTime: hrTime(EPOCH_SECONDS, START_NANOS),
    status: { code: 1 }
  };
}

/**
 * @returns {NonNullable<SampleReadableSpan["events"]>}
 */
function escapedExceptionEvents() {
  return [
    ...Array.from({ length: CACHE_LOOKUP_COUNT }, (_entry, index) => ({
      attributes: {
        "cache.hit": index % EVEN_DIVISOR === NO_REMAINDER
      },
      name: `cache.lookup.${index}`,
      time: hrTime(EPOCH_SECONDS, START_NANOS + index)
    })),
    {
      attributes: {
        "exception.escaped": true,
        "exception.message": "dynamic-user-marker checkout payload",
        "exception.stacktrace": "opaque stack marker",
        "exception.type": "CheckoutError"
      },
      name: "exception",
      time: hrTime(EPOCH_SECONDS, ESCAPED_EXCEPTION_NANOS)
    },
    {
      attributes: {
        "exception.escaped": false,
        "exception.message": "ignored nested marker",
        "exception.type": "RetryError"
      },
      name: "exception",
      time: hrTime(EPOCH_SECONDS, CACHE_LOOKUP_NANOS)
    }
  ];
}

/**
 * @param {unknown} summary
 * @returns {void}
 */
function assertRootedSummary(summary) {
  assert.equal(pick(summary, "type"), "span");
  assert.equal(pick(summary, "timestamp"), "2026-05-28T20:26:40.100Z");
  assert.deepEqual(pick(summary, "attributes"), {
    durationMs: 300,
    metadata: EXPECTED_SUMMARY_METADATA,
    name: "opentelemetry.trace:GET /orders/:id",
    spanId: pick(summary, "attributes.spanId"),
    status: "error",
    traceId: TRACE_ID
  });
  assert.match(String(pick(summary, "attributes.spanId")), /^[0-9a-f]{16}$/u);
  assertExcludes(JSON.stringify(summary), ["api_key=redacted", "db.statement", "url.full"]);
}

/**
 * @param {unknown} span
 * @returns {void}
 */
function assertSpanExceptionMetadata(span) {
  assert.equal(pick(span, "attributes.status"), "error");
  assert.equal(metadataValue(span, "otel.exception_event_count"), EXCEPTION_EVENTS);
  assert.equal(metadataValue(span, "otel.exception_escaped_count"), ESCAPED_EXCEPTIONS);
  assert.equal(metadataValue(span, "otel.exception_types"), "CheckoutError,RetryError");
}

/**
 * @param {unknown} summary
 * @returns {void}
 */
function assertSummaryExceptionMetadata(summary) {
  assert.equal(pick(summary, "attributes.status"), "error");
  assert.equal(metadataValue(summary, "otel.trace.exception_event_count"), EXCEPTION_EVENTS);
  assert.equal(metadataValue(summary, "otel.trace.exception_escaped_count"), ESCAPED_EXCEPTIONS);
  assert.equal(metadataValue(summary, "otel.trace.exception_types"), "CheckoutError,RetryError");
}

await test("OpenTelemetry span processor can emit a trace summary on flush", async () => {
  const client = sampleClient();
  const transport = RecordingTransport.alwaysAccept();
  const processor = createLogBrewOpenTelemetrySpanProcessor({
    client,
    eventIdPrefix: "otel",
    includeTraceSummary: true,
    transport
  });

  processor.onEnd(databaseChildSpan());
  processor.onEnd(rootRequestSpan());

  await processor.forceFlush();

  const payload = lastPayload(transport);
  assert.equal(pick(payload, "events.length"), SPAN_AND_SUMMARY_EVENTS);
  assertRootedSummary(eventById(payload, "otel_trace_1"));
});

await test("OpenTelemetry trace summary records escaped exception event summaries", async () => {
  const transport = RecordingTransport.alwaysAccept();
  const processor = createLogBrewOpenTelemetrySpanProcessor({
    client: sampleClient(),
    eventIdPrefix: "otel_exception",
    includeTraceSummary: true,
    transport
  });

  processor.onEnd({
    ...sampleOpenTelemetryReadableSpan(),
    events: escapedExceptionEvents(),
    kind: 1,
    name: "POST /checkout/:id",
    parentSpanContext: undefined,
    parentSpanId: undefined,
    spanContext: spanContextOf(TRACE_ID, "aaaaaaaaaaaaaaaa", TRACE_FLAGS_SAMPLED),
    status: { code: 0 }
  });

  await processor.forceFlush();

  const payload = lastPayload(transport);
  assertSpanExceptionMetadata(eventById(payload, "otel_exception_1"));
  assertSummaryExceptionMetadata(eventById(payload, "otel_exception_trace_1"));
  assertExcludes(JSON.stringify(payload), ["dynamic-user-marker", "opaque stack marker", "ignored nested marker"]);
});
