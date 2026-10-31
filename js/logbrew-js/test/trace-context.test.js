import { CHILD_SPAN_ID, PARENT_SPAN_ID, TRACE_ID, callUnchecked } from "./tracing-helpers.js";
import {
  createBaggage,
  createTraceContextHeaders,
  createTraceparent,
  createTraceparentHeaders,
  createTracestate,
  parseBaggage,
  parseTraceparent,
  parseTracestate,
  spanAttributesFromTraceparent
} from "@logbrew/sdk";
import assert from "node:assert/strict";
import test from "node:test";

const UPPERCASE_TRACEPARENT = "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01";

await test("traceparent helpers parse, create, and continue W3C trace context", () => {
  const context = parseTraceparent(UPPERCASE_TRACEPARENT);

  assert.deepEqual(context, {
    parentSpanId: PARENT_SPAN_ID,
    sampled: true,
    traceFlags: "01",
    traceId: TRACE_ID,
    version: "00"
  });
  assert.equal(
    createTraceparent({ spanId: CHILD_SPAN_ID, traceFlags: "00", traceId: context.traceId }),
    "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-00"
  );
  assert.deepEqual(
    createTraceparentHeaders({ spanId: CHILD_SPAN_ID, traceFlags: "00", traceId: context.traceId }),
    { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-00" }
  );
  assert.deepEqual(
    callUnchecked(spanAttributesFromTraceparent, [
      UPPERCASE_TRACEPARENT,
      {
        durationMs: 12.5,
        metadata: { service: "checkout", skipped: { nested: true } },
        name: "GET /checkout",
        spanId: CHILD_SPAN_ID,
        status: "ok"
      }
    ]),
    {
      durationMs: 12.5,
      metadata: { service: "checkout" },
      name: "GET /checkout",
      parentSpanId: PARENT_SPAN_ID,
      spanId: CHILD_SPAN_ID,
      status: "ok",
      traceId: TRACE_ID
    }
  );
});

await test("trace context helpers create explicit tracestate and baggage carriers", () => {
  assert.deepEqual(parseTracestate("rojo=00f067aa0ba902b7, congo=t61rcWkgMzE"), [
    { key: "rojo", value: "00f067aa0ba902b7" },
    { key: "congo", value: "t61rcWkgMzE" }
  ]);
  assert.equal(
    createTracestate([
      { key: "rojo", value: "00f067aa0ba902b7" },
      { key: "congo", value: "t61rcWkgMzE" }
    ]),
    "rojo=00f067aa0ba902b7,congo=t61rcWkgMzE"
  );
  assert.deepEqual(parseBaggage("release=checkout%401.2.3, region = eu-west ; sampled=true"), [
    { key: "release", value: "checkout@1.2.3" },
    { key: "region", properties: ["sampled=true"], value: "eu-west" }
  ]);
  assert.equal(
    createBaggage([
      { key: "release", value: "checkout@1.2.3" },
      { key: "region", properties: ["sampled=true"], value: "eu-west" }
    ]),
    "release=checkout%401.2.3,region=eu-west;sampled=true"
  );
  assert.deepEqual(
    createTraceContextHeaders({
      baggage: [{ key: "release", value: "checkout@1.2.3" }],
      spanId: CHILD_SPAN_ID,
      traceFlags: "01",
      traceId: TRACE_ID,
      tracestate: [{ key: "rojo", value: "00f067aa0ba902b7" }]
    }),
    {
      baggage: "release=checkout%401.2.3",
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01",
      tracestate: "rojo=00f067aa0ba902b7"
    }
  );
});

await test("trace context helpers reject oversized or malformed carriers", () => {
  assert.throws(() => createTracestate([{ key: "Vendor", value: "opaque" }]), /tracestate key must be lowercase/u);
  assert.throws(
    () => createTracestate(Array.from({ length: 33 }, (_entry, index) => ({ key: `v${index}`, value: "opaque" }))),
    /tracestate must contain at most 32 entries/u
  );
  assert.throws(() => createBaggage([{ key: "bad key", value: "value" }]), /baggage key must use RFC header-name characters/u);
  assert.throws(
    () => createBaggage(Array.from({ length: 65 }, (_entry, index) => ({ key: `k${index}`, value: "v" }))),
    /baggage must contain at most 64 entries/u
  );
});

await test("traceparent helpers reject malformed W3C trace context", () => {
  assert.throws(
    () => parseTraceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01"),
    /traceparent traceId must not be all zeros/u
  );
  assert.throws(
    () => parseTraceparent("ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"),
    /traceparent version ff is not allowed/u
  );
  assert.throws(
    () => createTraceparent({ spanId: "0000000000000000", traceId: TRACE_ID }),
    /spanId must not be all zeros/u
  );
  assert.throws(
    () => spanAttributesFromTraceparent("not-a-traceparent", { name: "GET /checkout", spanId: CHILD_SPAN_ID, status: "ok" }),
    /traceparent must use W3C/u
  );
});
