import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import { RecordingTransport } from "@logbrew/sdk";
import {
  createHttpRequestEvent,
  createLogBrewNodeClient,
  fetchWithLogBrewSpan,
  getActiveLogBrewTrace,
  withLogBrewHttpHandler
} from "../index.js";

const TIMESTAMP = "2026-08-29T12:00:00Z";
const TRACE_ID = "11111111111111111111111111111111";
const REQUEST_SPAN_ID = "2222222222222222";
const FETCH_SPAN_ID = "3333333333333333";

test("ordinary HTTP requests root and correlate every signal captured in their scope", async (t) => {
  const transport = RecordingTransport.alwaysAccept();
  const client = createLogBrewNodeClient({
    automaticDelivery: false,
    serverApiKey: "LOGBREW_SERVER_API_KEY"
  });
  let finishFlush;
  let failFlush;
  let handlerError;
  const flushed = new Promise((resolve, reject) => {
    finishFlush = resolve;
    failFlush = reject;
  });
  const server = createServer(withLogBrewHttpHandler(async (req, res) => {
    assert.deepEqual(getActiveLogBrewTrace(), {
      traceId: TRACE_ID,
      spanId: REQUEST_SPAN_ID,
      sampled: true
    });
    client.log("request-log", TIMESTAMP, { level: "info", message: "request accepted" });
    client.issue("request-issue", TIMESTAMP, { level: "error", message: "request failed", title: "Request failure" });
    client.action("request-action", TIMESTAMP, { name: "request handled", status: "success" });
    client.metric("request-metric", TIMESTAMP, {
      kind: "counter",
      name: "request.count",
      temporality: "delta",
      unit: "1",
      value: 1
    });
    await fetchWithLogBrewSpan("https://example.invalid/dependency", undefined, {
      client,
      fetchImpl: async (_input, init) => {
        assert.equal(new Headers(init.headers).get("traceparent"), `00-${TRACE_ID}-${FETCH_SPAN_ID}-01`);
        return new Response(null, { status: 204 });
      },
      id: "dependency-span",
      now: () => TIMESTAMP,
      routeTemplate: "/dependency",
      spanIdFactory: () => FETCH_SPAN_ID
    });
    res.end("ok");
  }, {
    client,
    idFactory: () => "request-span",
    now: () => TIMESTAMP,
    onCaptureError: failFlush,
    onError(error, { res }) {
      handlerError = error;
      res.statusCode = 500;
      res.end();
    },
    onFlush: finishFlush,
    spanIdFactory: () => REQUEST_SPAN_ID,
    traceIdFactory: () => TRACE_ID,
    transport
  }));
  t.after(() => server.close());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const response = await fetch(`http://127.0.0.1:${server.address().port}/orders?private=omitted`);
  assert.equal(response.status, 200, handlerError?.stack);
  await flushed;

  const events = JSON.parse(transport.lastBody()).events;
  assert.deepEqual(events.map(({ id }) => id).sort(), [
    "request-action",
    "request-issue",
    "request-log",
    "request-metric",
    "request-span",
    "dependency-span"
  ].sort());
  const requestSpan = events.find(({ id }) => id === "request-span");
  assert.equal(requestSpan.type, "span");
  assert.equal(requestSpan.attributes.traceId, TRACE_ID);
  assert.equal(requestSpan.attributes.spanId, REQUEST_SPAN_ID);
  assert.equal(requestSpan.attributes.parentSpanId, undefined);
  assert.equal(JSON.stringify(requestSpan).includes("private=omitted"), false);

  for (const event of events.filter(({ type }) => type !== "span")) {
    assert.deepEqual(event.attributes.context.trace, {
      traceId: TRACE_ID,
      spanId: REQUEST_SPAN_ID,
      sampled: true
    });
  }
  const dependency = events.find(({ id }) => id === "dependency-span");
  assert.equal(dependency.attributes.traceId, TRACE_ID);
  assert.equal(dependency.attributes.parentSpanId, REQUEST_SPAN_ID);
  assert.equal(dependency.attributes.spanId, FETCH_SPAN_ID);
});

test("missing and malformed traceparent values create safe local request roots", () => {
  for (const traceparent of [undefined, "malformed-private-propagation"]) {
    const event = createHttpRequestEvent(
      { headers: { ...(traceparent ? { traceparent } : {}) }, method: "GET", url: "/health" },
      { statusCode: 200 },
      {
        idFactory: () => "request-root",
        now: () => TIMESTAMP,
        spanIdFactory: () => REQUEST_SPAN_ID,
        traceIdFactory: () => TRACE_ID
      }
    );
    assert.equal(event.type, "span");
    assert.equal(event.attributes.traceId, TRACE_ID);
    assert.equal(event.attributes.spanId, REQUEST_SPAN_ID);
    assert.equal(event.attributes.parentSpanId, undefined);
    assert.equal(JSON.stringify(event).includes("malformed-private-propagation"), false);
  }

  const fallback = createHttpRequestEvent(
    { headers: {}, method: "GET", url: "/health" },
    { statusCode: 200 },
    {
      spanIdFactory: () => "0000000000000000",
      traceIdFactory: () => {
        throw new Error("factory failure");
      }
    }
  );
  assert.match(fallback.attributes.traceId, /^(?!0{32})[0-9a-f]{32}$/u);
  assert.match(fallback.attributes.spanId, /^(?!0{16})[0-9a-f]{16}$/u);

  const continued = createHttpRequestEvent(
    {
      headers: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" },
      method: "GET",
      url: "/health"
    },
    { statusCode: 200 },
    { spanIdFactory: () => REQUEST_SPAN_ID }
  );
  assert.equal(continued.attributes.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
  assert.equal(continued.attributes.parentSpanId, "00f067aa0ba902b7");
  assert.equal(continued.attributes.spanId, REQUEST_SPAN_ID);
});
