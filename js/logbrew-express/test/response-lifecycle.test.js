import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request } from "node:http";
import { createRequire } from "node:module";
import { connect } from "node:net";
import test from "node:test";

import express from "express";
import { RecordingTransport } from "@logbrew/sdk";
import { createNodeFetchTransport } from "@logbrew/node";
import {
  getActiveLogBrewTrace,
  logbrewErrorHandler,
  logbrewMiddleware
} from "@logbrew/express";

const TRACE_ID = "11111111111111111111111111111111";
const SPAN_ID = "2222222222222222";
const TIMESTAMP = "2026-08-29T12:00:00Z";

async function runRequest(t, {
  aborted = false, failure = false, metricsOnly = false, commonjs = false, networkDelivery = false, manual = false,
  continued = false
} = {}) {
  const adapter = commonjs ? createRequire(import.meta.url)("@logbrew/express") : { logbrewMiddleware, logbrewErrorHandler };
  let transport = RecordingTransport.alwaysAccept();
  let deliveredBody;
  let deliveryCount = 0;
  if (networkDelivery) {
    const collector = createServer(async (req, res) => {
      assert.equal(req.headers.authorization, "Bearer test-key");
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      deliveredBody = Buffer.concat(chunks).toString("utf8");
      deliveryCount += 1;
      res.writeHead(202);
      res.end();
    });
    t.after(() => {
      collector.closeAllConnections();
      collector.close();
    });
    collector.listen(0, "127.0.0.1");
    await once(collector, "listening");
    transport = createNodeFetchTransport({ endpoint: `http://127.0.0.1:${collector.address().port}/v1/events` });
  }
  const app = express();
  let response;
  let originalFinishListeners;
  let sdkFinishListeners;
  let sdkAbortListeners;
  let incomingRequest;
  let requestClient;
  let flushCount = 0;
  let resolveFlush;
  let rejectFlush;
  const flushed = new Promise((resolve, reject) => {
    resolveFlush = resolve;
    rejectFlush = reject;
  });
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  app.use((_req, res, next) => {
    originalFinishListeners = new Set(res.listeners("finish"));
    next();
  });
  app.use(adapter.logbrewMiddleware({
    serverApiKey: "test-key",
    transport,
    captureRequests: !metricsOnly && !manual,
    captureRequestMetrics: !manual,
    now: () => TIMESTAMP,
    traceIdFactory: () => TRACE_ID,
    spanIdFactory: () => SPAN_ID,
    onFlush() {
      flushCount += 1;
      resolveFlush();
    },
    onCaptureError: rejectFlush
  }));
  app.get("/stream/:id", (req, res, next) => {
    response = res;
    incomingRequest = req;
    sdkFinishListeners = res.listeners("finish").filter((listener) => !originalFinishListeners.has(listener));
    sdkAbortListeners = req.listeners("aborted");
    requestClient = req.logbrew.client;
    assert.equal(getActiveLogBrewTrace().spanId, SPAN_ID);
    requestClient.log("stream-log", TIMESTAMP, { level: "info", message: "stream started" });
    res.once("close", resolveClosed);
    req.once("aborted", resolveClosed);
    res.write("first chunk");
    res.flushHeaders();
    if (failure) {
      next(new TypeError("stream failure"));
    } else if (!aborted) {
      res.end("last chunk");
    }
  });
  app.use(adapter.logbrewErrorHandler());
  app.use((error, _req, res, _next) => {
    assert.equal(error.message, "stream failure");
    res.destroy();
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await once(server, "listening");
  await new Promise((resolve, reject) => {
    if (aborted) {
      const socket = connect(server.address().port, "127.0.0.1", () => {
        const propagation = continued ? `traceparent: 00-${TRACE_ID}-4444444444444444-00\r\n` : "";
        socket.write(`GET /stream/private-id?search=private-query HTTP/1.1\r\nHost: localhost\r\nAuthorization: private-authorization\r\nCookie: private-cookie\r\n${propagation}\r\n`);
      });
      socket.once("data", () => socket.destroy());
      socket.once("close", resolve);
      socket.once("error", reject);
      return;
    }
    const outgoing = request({
      host: "127.0.0.1",
      port: server.address().port,
      path: "/stream/private-id?search=private-query",
      headers: { authorization: "private-authorization", cookie: "private-cookie" }
    }, (incoming) => {
      incoming.on("error", (error) => {
        if (aborted || failure) {
          resolve();
        } else {
          reject(error);
        }
      });
      incoming.on("data", () => {
        if (aborted) {
          incoming.destroy();
          outgoing.destroy();
          resolve();
        }
      });
      incoming.on("end", resolve);
    });
    outgoing.on("error", (error) => {
      if (failure) {
        resolve();
      } else {
        reject(error);
      }
    });
    outgoing.end();
  });
  await closed;
  if (manual) {
    assert.equal(flushCount, 0);
    assert.equal(requestClient.pendingEvents(), 1);
    await requestClient.shutdown(transport);
  }
  let timer;
  try {
    await Promise.race([
      ...(manual ? [Promise.resolve()] : []),
      flushed,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("closed response never flushed")), 500);
      })
    ]);
  } finally {
    globalThis.clearTimeout(timer);
  }
  assert.equal(flushCount, manual ? 0 : 1);
  assert.equal(requestClient.pendingEvents(), 0);
  assert.ok(sdkFinishListeners.every((listener) => !response.listeners("finish").includes(listener)));
  assert.ok(sdkAbortListeners.every((listener) => !incomingRequest.listeners("aborted").includes(listener)));
  assert.ok(response.listeners("close").every((listener) => listener === resolveClosed));
  assert.equal(getActiveLogBrewTrace(), undefined);
  const body = networkDelivery ? deliveredBody : transport.lastBody();
  if (networkDelivery) {
    assert.equal(deliveryCount, 1);
  }
  for (const marker of ["private-id", "private-query", "private-authorization", "private-cookie"]) {
    assert.equal(body.includes(marker), false);
  }
  const events = JSON.parse(body).events;
  assert.equal(events.length, manual ? 1 : metricsOnly ? 2 : failure ? 4 : 3);
  const log = events.find(({ id }) => id === "stream-log");
  assert.equal(log.attributes.context.trace.traceId, TRACE_ID);
  assert.equal(log.attributes.context.trace.spanId, SPAN_ID);
  assert.equal(log.attributes.context.trace.sampled, !continued);
  const span = events.find(({ type }) => type === "span");
  if (!metricsOnly && !manual) {
    assert.equal(span.attributes.name, "GET /stream/:id");
    assert.equal(span.attributes.traceId, TRACE_ID);
    assert.equal(span.attributes.spanId, SPAN_ID);
    assert.equal(span.attributes.parentSpanId, continued ? "4444444444444444" : undefined);
    assert.equal(span.attributes.status, aborted || failure ? "error" : "ok");
    assert.equal(span.attributes.metadata.responseCompleted, aborted || failure ? false : undefined);
  }
  if (!manual) {
    const metric = events.find(({ type }) => type === "metric");
    assert.equal(metric.attributes.metadata.routeTemplate, "/stream/:id");
    assert.equal(metric.attributes.context.trace.spanId, SPAN_ID);
    assert.equal(metric.attributes.context.trace.sampled, !continued);
    assert.equal(metric.attributes.metadata.responseCompleted, aborted || failure ? false : undefined);
  }
  if (failure) {
    const issue = events.find(({ type }) => type === "issue");
    assert.equal(issue.attributes.context.trace.spanId, SPAN_ID);
  }
}

test("client disconnect flushes streamed request telemetry", async (t) => {
  await runRequest(t, { aborted: true });
});

test("completed streams flush once and release lifecycle listeners", async (t) => {
  await runRequest(t);
});

test("late streaming errors flush their issue and failed request once", async (t) => {
  await runRequest(t, { failure: true });
});

test("metrics-only disconnected requests flush without a request span", async (t) => {
  await runRequest(t, { aborted: true, metricsOnly: true });
});

test("CommonJS consumers flush disconnected streams", async (t) => {
  await runRequest(t, { aborted: true, commonjs: true });
});

test("disconnected streams deliver one correlated batch over HTTP", async (t) => {
  await runRequest(t, { aborted: true, networkDelivery: true, continued: true });
});

test("disabled automatic capture preserves manual delivery", async (t) => {
  await runRequest(t, { aborted: true, manual: true });
});
