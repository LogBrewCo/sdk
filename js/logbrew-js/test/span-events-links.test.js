import { callUnchecked, field, firstPreviewEvent, invokeUnchecked, sampleClient } from "./batch-helpers.js";
import assert from "node:assert/strict";
import { spanAttributesFromTraceparent } from "@logbrew/sdk";
import test from "node:test";

const TIMESTAMP = "2026-06-02T10:00:04Z";
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "b7ad6b7169203331";
const LINKED_TRACE_ID = "11111111111111111111111111111111";
const LINKED_SPAN_ID = "2222222222222222";
const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const NEGATIVE_DURATION_MS = -1;
const QUERY_DURATION_MS = 33;
const FIRST_ATTEMPT = 1;
const LINK_SHARD = 3;
const OVER_LIMIT = 9;
const TRACE_ID_LENGTH = 32;
const NEXT = 1;

const EXPECTED_SPAN_EVENTS = [
  {
    metadata: {
      attempt: FIRST_ATTEMPT,
      phase: "before_query",
      retryable: false
    },
    name: "db.pool.wait",
    timestamp: TIMESTAMP
  },
  {
    metadata: {
      exceptionEscaped: true,
      exceptionType: "TypeError"
    },
    name: "exception"
  }
];

/**
 * @param {unknown} attributes
 * @returns {unknown}
 */
function spanAttributesOfFirstEvent(attributes) {
  const client = sampleClient();
  invokeUnchecked(client, "span", ["evt_span_001", TIMESTAMP, attributes]);
  return field(firstPreviewEvent(client), "attributes");
}

/**
 * @returns {unknown}
 */
function unsafeSpanEvents() {
  return [
    {
      metadata: {
        attempt: FIRST_ATTEMPT,
        ignoredObject: { nested: true },
        phase: "before_query",
        retryable: false
      },
      name: "db.pool.wait",
      timestamp: TIMESTAMP
    },
    {
      metadata: {
        exceptionEscaped: true,
        exceptionMessage: ["should not serialize"],
        exceptionType: "TypeError"
      },
      name: "exception"
    }
  ];
}

await test("negative span duration fails validation", () => {
  const client = sampleClient();
  assert.throws(
    () => {
      client.span("evt_span_001", TIMESTAMP, {
        durationMs: NEGATIVE_DURATION_MS,
        name: "GET /health",
        spanId: "span_001",
        status: "ok",
        traceId: "trace_001"
      });
    },
    /span durationMs must be non-negative/u
  );
});

await test("span events serialize bounded primitive metadata", () => {
  const attributes = spanAttributesOfFirstEvent({
    durationMs: QUERY_DURATION_MS,
    events: unsafeSpanEvents(),
    metadata: { service: "checkout" },
    name: "postgresql SELECT orders.select_by_id",
    spanId: "span_001",
    status: "error",
    traceId: "trace_001"
  });

  assert.deepEqual(field(attributes, "events"), EXPECTED_SPAN_EVENTS);
});

await test("too many span events fail validation", () => {
  const client = sampleClient();
  assert.throws(
    () => {
      client.span("evt_span_many_events", TIMESTAMP, {
        events: Array.from({ length: OVER_LIMIT }, (_entry, index) => ({ name: `step.${index}` })),
        name: "GET /health",
        spanId: "span_001",
        status: "ok",
        traceId: "trace_001"
      });
    },
    /span events must contain at most 8 entries/u
  );
});

await test("span links serialize bounded primitive metadata", () => {
  const attributes = spanAttributesOfFirstEvent({
    links: [
      {
        metadata: {
          ignoredNested: { nope: true },
          relation: "batch_item",
          shard: LINK_SHARD
        },
        sampled: true,
        spanId: LINKED_SPAN_ID,
        traceId: LINKED_TRACE_ID
      }
    ],
    name: "queue publish email.welcome",
    spanId: SPAN_ID,
    status: "ok",
    traceId: TRACE_ID
  });

  assert.deepEqual(field(attributes, "links"), [
    {
      metadata: {
        relation: "batch_item",
        shard: LINK_SHARD
      },
      sampled: true,
      spanId: LINKED_SPAN_ID,
      traceId: LINKED_TRACE_ID
    }
  ]);
});

await test("too many span links fail validation", () => {
  const client = sampleClient();
  assert.throws(
    () => {
      client.span("evt_span_many_links", TIMESTAMP, {
        links: Array.from({ length: OVER_LIMIT }, (_entry, index) => ({
          spanId: LINKED_SPAN_ID,
          traceId: String(index + NEXT).padStart(TRACE_ID_LENGTH, "0")
        })),
        name: "queue publish email.welcome",
        spanId: SPAN_ID,
        status: "ok",
        traceId: TRACE_ID
      });
    },
    /span links must contain at most 8 entries/u
  );
});

await test("traceparent span helper preserves safe span events", () => {
  const span = callUnchecked(spanAttributesFromTraceparent, [
    TRACEPARENT,
    {
      events: [
        {
          metadata: {
            hit: false,
            ignored: { nested: true },
            system: "redis"
          },
          name: "cache.lookup"
        }
      ],
      name: "GET /orders/:id",
      spanId: SPAN_ID,
      status: "ok"
    }
  ]);

  assert.deepEqual(field(span, "events"), [
    {
      metadata: {
        hit: false,
        system: "redis"
      },
      name: "cache.lookup"
    }
  ]);
});

await test("traceparent span helper preserves safe span links", () => {
  const span = callUnchecked(spanAttributesFromTraceparent, [
    TRACEPARENT,
    {
      links: [
        {
          metadata: {
            ignoredNested: { nope: true },
            relation: "batch_item"
          },
          sampled: false,
          spanId: LINKED_SPAN_ID,
          traceId: LINKED_TRACE_ID
        }
      ],
      name: "queue publish email.welcome",
      spanId: SPAN_ID,
      status: "ok"
    }
  ]);

  assert.deepEqual(field(span, "links"), [
    {
      metadata: {
        relation: "batch_item"
      },
      sampled: false,
      spanId: LINKED_SPAN_ID,
      traceId: LINKED_TRACE_ID
    }
  ]);
});
