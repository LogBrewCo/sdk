import { CHILD_SPAN_ID, PARENT_SPAN_ID, TRACE_FLAGS_SAMPLED, TRACE_FLAGS_UNSAMPLED, TRACE_ID, sampleOpenTelemetryReadableSpan, spanContextOf } from "./tracing-helpers.js";
import {
  logbrewTraceContextFromCurrentOpenTelemetrySpan,
  logbrewTraceContextFromOpenTelemetrySpan,
  logbrewTraceContextFromOpenTelemetrySpanContext,
  spanAttributesFromOpenTelemetryReadableSpan
} from "@logbrew/sdk";
import assert from "node:assert/strict";
import test from "node:test";

const EXPECTED_READABLE_SPAN = {
  durationMs: 125,
  events: [
    {
      metadata: {
        "exception.escaped": false,
        "exception.type": "TypeError"
      },
      name: "exception",
      timestamp: "2026-05-28T20:26:40.160Z"
    },
    {
      metadata: {
        "cache.hit": false
      },
      name: "cache.lookup",
      timestamp: "2026-05-28T20:26:40.180Z"
    }
  ],
  links: [
    {
      metadata: {
        "messaging.operation.name": "process"
      },
      sampled: true,
      spanId: "2222222222222222",
      traceId: "11111111111111111111111111111111"
    }
  ],
  metadata: {
    "deployment.environment.name": "production",
    "http.request.method": "GET",
    "http.response.status_code": 200,
    "http.route": "/orders/:id",
    "otel.dropped_attributes_count": 1,
    "otel.dropped_events_count": 2,
    "otel.dropped_links_count": 3,
    "otel.exception_event_count": 1,
    "otel.exception_types": "TypeError",
    "otel.kind": "client",
    "otel.scope.name": "@opentelemetry/instrumentation-http",
    "otel.scope.version": "1.2.3",
    release: "checkout@1.2.3",
    "service.name": "checkout",
    source: "opentelemetry.readable_span"
  },
  name: "GET /orders/:id",
  parentSpanId: PARENT_SPAN_ID,
  spanId: CHILD_SPAN_ID,
  status: "ok",
  traceId: TRACE_ID
};

await test("OpenTelemetry span context helper creates a LogBrew child trace", () => {
  const spanContext = {
    spanId: "00F067AA0BA902B7",
    traceFlags: 1,
    traceId: "4BF92F3577B34DA6A3CE929D0E0E4736",
    traceState: { raw: "not-copied" }
  };
  const trace = logbrewTraceContextFromOpenTelemetrySpanContext(spanContext, { spanId: CHILD_SPAN_ID });

  assert.deepEqual(trace, {
    parentSpanId: PARENT_SPAN_ID,
    sampled: true,
    spanId: CHILD_SPAN_ID,
    traceId: TRACE_ID
  });
});

await test("OpenTelemetry span helper duck-types span objects and validates child span ids", () => {
  const trace = logbrewTraceContextFromOpenTelemetrySpan(
    { spanContext: spanContextOf(TRACE_ID, PARENT_SPAN_ID, TRACE_FLAGS_UNSAMPLED) },
    { spanIdFactory: () => CHILD_SPAN_ID }
  );

  assert.deepEqual(trace, {
    parentSpanId: PARENT_SPAN_ID,
    sampled: false,
    spanId: CHILD_SPAN_ID,
    traceId: TRACE_ID
  });
  assert.throws(
    () => logbrewTraceContextFromOpenTelemetrySpanContext(
      { spanId: PARENT_SPAN_ID, traceFlags: 1, traceId: TRACE_ID },
      { spanIdFactory: () => "0000000000000000" }
    ),
    /spanId must not be all zeros/u
  );
  assert.throws(
    () => logbrewTraceContextFromOpenTelemetrySpan(
      { spanContext: spanContextOf(TRACE_ID, PARENT_SPAN_ID, TRACE_FLAGS_SAMPLED) },
      { spanId: "bad" }
    ),
    /spanId must be 16/u
  );
});

await test("OpenTelemetry current span helper uses explicit API seam and returns null for invalid contexts", () => {
  const trace = logbrewTraceContextFromCurrentOpenTelemetrySpan({
    openTelemetryApi: {
      trace: {
        getActiveSpan: () => ({ spanContext: spanContextOf(TRACE_ID, PARENT_SPAN_ID, TRACE_FLAGS_SAMPLED) })
      }
    },
    spanId: CHILD_SPAN_ID
  });

  assert.deepEqual(trace, {
    parentSpanId: PARENT_SPAN_ID,
    sampled: true,
    spanId: CHILD_SPAN_ID,
    traceId: TRACE_ID
  });
  assert.equal(
    logbrewTraceContextFromCurrentOpenTelemetrySpan({
      openTelemetryApi: { trace: { getActiveSpan: () => undefined } },
      spanId: CHILD_SPAN_ID
    }),
    null
  );
  assert.equal(
    logbrewTraceContextFromOpenTelemetrySpanContext({
      spanId: PARENT_SPAN_ID,
      traceFlags: 1,
      traceId: "00000000000000000000000000000000"
    }),
    null
  );
});

await test("OpenTelemetry ReadableSpan helper creates privacy-bounded LogBrew span attributes", () => {
  const span = spanAttributesFromOpenTelemetryReadableSpan(sampleOpenTelemetryReadableSpan(), {
    attributeKeys: ["messaging.operation.name"],
    eventAttributeKeys: ["cache.hit"],
    linkAttributeKeys: ["messaging.operation.name"],
    metadata: { release: "checkout@1.2.3" }
  });

  assert.deepEqual(span, EXPECTED_READABLE_SPAN);
});
