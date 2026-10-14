import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { connect } from "node:net";
import test from "node:test";
import { RecordingTransport } from "@logbrew/sdk";
import {
  createHttpRequestEvent,
  createLogBrewNodeClient,
  getActiveLogBrewTrace,
  withLogBrewHttpHandler
} from "@logbrew/node";

const TRACE_ID = "11111111111111111111111111111111";
const SPAN_ID = "2222222222222222";
const TIMESTAMP = "2026-08-29T12:00:00Z";

async function requestStream(t, { abort = true, failure = false, commonjs = false, manual = false } = {}) {
  const wrapper = commonjs ? createRequire(import.meta.url)("@logbrew/node").withLogBrewHttpHandler : withLogBrewHttpHandler;
  const transport = failure ? new RecordingTransport([{ statusCode: 400 }]) : RecordingTransport.alwaysAccept();
  const client = createLogBrewNodeClient({ serverApiKey: "LOGBREW_SERVER_API_KEY", automaticDelivery: false });
  let response;
  let incomingRequest;
  let sdkListeners;
  let flushCount = 0;
  let failures = 0;
  let resolveDelivery;
  const delivery = new Promise((resolve) => { resolveDelivery = resolve; });
  let resolveTerminal;
  const terminal = new Promise((resolve) => { resolveTerminal = resolve; });
  const server = createServer(wrapper((req, res) => {
    response = res;
    incomingRequest = req;
    sdkListeners = { finish: res.listeners("finish"), close: res.listeners("close"), aborted: req.listeners("aborted") };
    assert.equal(getActiveLogBrewTrace().spanId, SPAN_ID);
    client.log("request-log", TIMESTAMP, { level: "info", message: "stream started" });
    req.once("aborted", resolveTerminal);
    res.once("close", resolveTerminal);
    res.write("first chunk");
    res.flushHeaders();
    if (!abort) {
      res.end("last chunk");
    }
  }, {
    client, transport,
    captureRequests: !manual,
    spanIdFactory: () => SPAN_ID,
    now: () => TIMESTAMP,
    requestEvent(req, res, { durationMs, trace }) {
      assert.equal(getActiveLogBrewTrace().spanId, SPAN_ID);
      client.metric("request-metric", TIMESTAMP, {
        name: "request.count", kind: "counter", temporality: "delta", unit: "1", value: 1
      });
      return createHttpRequestEvent(req, res, { durationMs, trace, now: () => TIMESTAMP, idFactory: () => "request-span" });
    },
    onFlush() { flushCount += 1; resolveDelivery(); },
    onCaptureError() { failures += 1; resolveDelivery(); }
  }));
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const socket = connect(server.address().port, "127.0.0.1", () => {
    socket.write(`GET /stream?search=private-query HTTP/1.1\r\nHost: localhost\r\nAuthorization: private-authorization\r\nCookie: private-cookie\r\ntraceparent: 00-${TRACE_ID}-4444444444444444-00\r\nConnection: close\r\n\r\n`);
  });
  socket.on("data", () => { if (abort) { socket.destroy(); } });
  await once(socket, "close");
  await terminal;
  if (manual) {
    assert.equal(flushCount, 0);
    assert.equal(client.pendingEvents(), 1);
    await client.shutdown(transport);
  } else {
    let timer;
    try {
      await Promise.race([
        delivery,
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("terminal response never flushed")), 500);
        })
      ]);
    } finally {
      globalThis.clearTimeout(timer);
    }
  }
  assert.equal(flushCount, manual || failure ? 0 : 1);
  assert.equal(failures, failure ? 1 : 0);
  assert.equal(client.pendingEvents(), failure ? 3 : 0);
  for (const name of ["finish", "close"]) {
    const remaining = response.listeners(name);
    for (const listener of sdkListeners[name]) {
      assert.equal(remaining.includes(listener), false);
    }
  }
  assert.ok(sdkListeners.aborted.every((listener) => !incomingRequest.listeners("aborted").includes(listener)));
  assert.equal(getActiveLogBrewTrace(), undefined);
  const body = transport.lastBody();
  for (const marker of ["private-query", "private-authorization", "private-cookie", `00-${TRACE_ID}-4444444444444444-00`]) {
    assert.equal(body.includes(marker), false);
  }
  const events = JSON.parse(body).events;
  assert.equal(events.length, manual ? 1 : 3);
  for (const event of events.filter(({ type }) => type !== "span")) {
    assert.equal(event.attributes.context.trace.traceId, TRACE_ID);
    assert.equal(event.attributes.context.trace.spanId, SPAN_ID);
    assert.equal(event.attributes.context.trace.sampled, false);
  }
  if (!manual) {
    const span = events.find(({ type }) => type === "span");
    assert.equal(span.attributes.status, abort ? "error" : "ok");
    assert.equal(span.attributes.metadata.responseCompleted, abort ? false : undefined);
    assert.equal(span.attributes.metadata.statusCode, 200);
    assert.equal(span.attributes.traceId, TRACE_ID);
    assert.equal(span.attributes.spanId, SPAN_ID);
    assert.equal(span.attributes.parentSpanId, "4444444444444444");
  }
}

test("Node peer disconnect flushes request telemetry under its trace", async (t) => {
  await requestStream(t);
});
test("Node completed response flushes once and removes lifecycle listeners", async (t) => {
  await requestStream(t, { abort: false });
});
test("Node aborted request retains its batch when delivery fails", async (t) => {
  await requestStream(t, { failure: true });
});
test("Node CommonJS consumers capture peer disconnects", async (t) => {
  await requestStream(t, { commonjs: true });
});
test("Node disabled request capture preserves manual delivery", async (t) => {
  await requestStream(t, { manual: true });
});
