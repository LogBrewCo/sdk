import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import {
  createLogBrewExpressClient,
  createErrorEvent,
  getActiveLogBrewTrace,
  logbrewErrorHandler,
  logbrewMiddleware
} from "@logbrew/express";

const SPAN_ID = "2222222222222222";
const TIMESTAMP = "2026-08-29T12:00:00Z";

async function checkErrorMiddleware(t, { failFactory = false, aborted = false, concurrency = 1, failObserver = false } = {}) {
  const originalError = new TypeError("application failure");
  const factoryError = new RangeError("event factory failure");
  const batches = [];
  const failures = [];
  const factoryTraces = [];
  const responseTraces = [];
  const forwarded = [];
  const clients = [];
  const callbacks = [];
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  let flushes = 0;
  let resolveFlushed;
  const flushed = new Promise((resolve) => { resolveFlushed = resolve; });
  const app = express();
  app.use(logbrewMiddleware({
    serverApiKey: "LOGBREW_SERVER_API_KEY",
    captureRequestMetrics: true,
    spanIdFactory: () => SPAN_ID,
    transport: { async send(_key, body) { batches.push(JSON.parse(body)); return { statusCode: 202 }; } },
    onFlush() { flushes += 1; if (flushes === concurrency) { resolveFlushed(); } }
  }));
  app.get("/fail/:id", (_req, _res, next) => {
    callbacks.push(() => next(originalError));
    if (callbacks.length === concurrency) { resolveReady(); }
  });
  app.use(logbrewErrorHandler({
    errorEvent(error, { req, client, trace }) {
      clients.push(client);
      factoryTraces.push(getActiveLogBrewTrace());
      client.log(`factory-log-${factoryTraces.length}`, TIMESTAMP, { message: "error factory called", level: "info" });
      if (failFactory) { throw factoryError; }
      return createErrorEvent(error, req, { trace, now: () => TIMESTAMP });
    },
    onCaptureError(error, { trace }) {
      failures.push({ error, trace, active: getActiveLogBrewTrace() });
      if (failObserver) { throw new Error("observer failure"); }
    }
  }));
  app.use((error, _req, res, _next) => {
    forwarded.push(error);
    responseTraces.push(getActiveLogBrewTrace());
    if (aborted) {
      res.destroy();
    } else {
      res.status(500).end("failed");
    }
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, "listening");
  const responses = Array.from({ length: concurrency }, (_value, index) => fetch(
    `http://127.0.0.1:${server.address().port}/fail/private-id?search=private-query`,
    { headers: { traceparent: `00-${String(index + 1).repeat(32)}-4444444444444444-01`, authorization: "private-authorization" } }
  ).then(async (response) => {
    assert.equal(response.status, 500);
    assert.equal(await response.text(), "failed");
  }).catch((error) => { if (!aborted) { throw error; } }));
  await ready;
  assert.equal(getActiveLogBrewTrace(), undefined);
  for (const callback of callbacks) { callback(); }
  assert.equal(getActiveLogBrewTrace(), undefined);
  await Promise.all(responses);
  await flushed;
  for (const client of clients) { assert.equal(client.deliveryHealth().lifecycle, "closed"); }
  assert.equal(forwarded.length, concurrency);
  for (const error of forwarded) { assert.equal(error, originalError); }
  assert.equal(failures.length, failFactory ? concurrency : 0);
  for (const failure of failures) {
    assert.equal(failure.error, factoryError);
    assert.deepEqual(failure.active, failure.trace);
  }
  const traces = factoryTraces.map((trace) => trace?.traceId).sort();
  assert.deepEqual(traces, Array.from({ length: concurrency }, (_value, index) => String(index + 1).repeat(32)));
  assert.deepEqual(responseTraces.map((trace) => trace?.traceId).sort(), traces);
  assert.equal(batches.length, concurrency);
  for (const { events } of batches) {
    assert.equal(events.length, failFactory ? 3 : 4);
    const span = events.find(({ type }) => type === "span");
    assert.equal(span.attributes.status, "error");
    assert.equal(span.attributes.name, "GET /fail/:id");
    for (const event of events.filter(({ type }) => type !== "span")) {
      assert.equal(event.attributes.context.trace.traceId, span.attributes.traceId);
      assert.equal(event.attributes.context.trace.spanId, SPAN_ID);
    }
    assert.equal(events.filter(({ type }) => type === "issue").length, failFactory ? 0 : 1);
    const serialized = JSON.stringify(events);
    for (const marker of ["private-id", "private-query", "private-authorization"]) {
      assert.equal(serialized.includes(marker), false);
    }
  }
}

test("error factory failure preserves the original Express error", async (t) => {
  await checkErrorMiddleware(t, { failFactory: true });
});
test("out-of-band errors restore request trace through factory and response middleware", async (t) => {
  await checkErrorMiddleware(t);
});
test("concurrent out-of-band errors keep independent traces", async (t) => {
  await checkErrorMiddleware(t, { concurrency: 3 });
});
test("aborted error responses preserve capture and the original application error", async (t) => {
  await checkErrorMiddleware(t, { failFactory: true, aborted: true });
});
test("a rejecting capture observer cannot replace the application error", async (t) => {
  await checkErrorMiddleware(t, { failFactory: true, failObserver: true });
});

test("standalone error middleware retains rejected delivery despite a rejecting observer", async (t) => {
  const app = express();
  const client = createLogBrewExpressClient({ serverApiKey: "LOGBREW_SERVER_API_KEY" });
  const originalError = new TypeError("application failure");
  let forwarded;
  let captureFailure;
  let resolveReported;
  const reported = new Promise((resolve) => { resolveReported = resolve; });
  app.get("/fail", (_req, _res, next) => { next(originalError); });
  app.use(logbrewErrorHandler({
    client,
    transport: { async send() { return { statusCode: 400 }; } },
    async onCaptureError(error) {
      captureFailure = error;
      resolveReported();
      throw new Error("observer failure");
    }
  }));
  app.use((error, _req, res, _next) => { forwarded = error; res.status(500).end("failed"); });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, "listening");
  const response = await fetch(`http://127.0.0.1:${server.address().port}/fail`);
  assert.equal(response.status, 500);
  await response.text();
  await reported;
  assert.equal(forwarded, originalError);
  assert.ok(captureFailure);
  assert.equal(client.pendingEvents(), 1);
  assert.equal(client.deliveryHealth().lifecycle, "active");
});

test("standalone factory failure delivers its earlier safe log", async (t) => {
  const app = express();
  const client = createLogBrewExpressClient({ serverApiKey: "LOGBREW_SERVER_API_KEY" });
  const originalError = new TypeError("application failure");
  const factoryError = new RangeError("factory failure");
  const failures = [];
  const batches = [];
  let forwarded;
  let resolveFlushed;
  const flushed = new Promise((resolve) => { resolveFlushed = resolve; });
  app.get("/fail", (_req, _res, next) => { next(originalError); });
  app.use(logbrewErrorHandler({
    client,
    transport: { async send(_key, body) { batches.push(JSON.parse(body)); return { statusCode: 202 }; } },
    errorEvent() {
      client.log("factory-log", TIMESTAMP, { message: "factory called", level: "info" });
      throw factoryError;
    },
    onCaptureError(error) { failures.push(error); },
    onFlush: resolveFlushed
  }));
  app.use((error, _req, res, _next) => { forwarded = error; res.status(500).end("failed"); });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, "listening");
  const response = await fetch(`http://127.0.0.1:${server.address().port}/fail`);
  await response.text();
  let timer;
  try {
    await Promise.race([
      flushed,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("factory log never flushed")), 500);
      })
    ]);
  } finally {
    globalThis.clearTimeout(timer);
  }
  assert.equal(response.status, 500);
  assert.equal(forwarded, originalError);
  assert.deepEqual(failures, [factoryError]);
  assert.deepEqual(batches.flatMap(({ events }) => events.map(({ id }) => id)), ["factory-log"]);
  assert.equal(client.pendingEvents(), 0);
  assert.equal(client.deliveryHealth().lifecycle, "closed");
});

async function sendClientError(t, options) {
  const batches = [];
  let resolveFlushed;
  const flushed = new Promise((resolve) => { resolveFlushed = resolve; });
  const forwarded = [];
  const app = express();
  const middlewareOptions = {
    serverApiKey: "LOGBREW_SERVER_API_KEY",
    transport: { async send(_key, body) { batches.push(JSON.parse(body)); return { statusCode: 202 }; } },
    onFlush() { resolveFlushed(); },
    ...options
  };
  app.use(logbrewMiddleware(middlewareOptions));
  app.use((_req, _res, next) => { next(Object.assign(new Error("Not Found"), { status: 404 })); });
  app.use(logbrewErrorHandler(middlewareOptions));
  app.use((error, _req, res, _next) => { forwarded.push(error); res.status(error.status).end("missing"); });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, "listening");
  const response = await fetch(`http://127.0.0.1:${server.address().port}/no-such-page`);
  assert.equal(response.status, 404);
  await flushed;
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].status, 404);
  return batches.flatMap(({ events }) => events);
}

test("errors with a 4xx status stay request spans, not issues", async (t) => {
  const events = await sendClientError(t, {});
  assert.equal(events.filter(({ type }) => type === "issue").length, 0);
  const span = events.find(({ type }) => type === "span");
  assert.equal(span.attributes.status, "ok");
  assert.equal(span.attributes.metadata.statusCode, 404);
});

test("captureClientErrors reports errors with a 4xx status as issues", async (t) => {
  const events = await sendClientError(t, { captureClientErrors: true });
  assert.equal(events.filter(({ type }) => type === "issue").length, 1);
});
