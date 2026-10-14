import assert from "node:assert/strict";
import { once } from "node:events";
import { createRequire } from "node:module";
import { connect } from "node:net";
import test from "node:test";
import express from "express";
import * as adapter from "@logbrew/express";

const TIMESTAMP = "2026-08-29T12:00:00Z";
const SPAN_ID = "2222222222222222";

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) { return; }
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
  assert.fail("handler delivery did not settle");
}

async function checkTail(t, {
  reject = true, aborted = false, concurrency = 1, customClient = false,
  manual = false, failTail = false, commonjs = false, slowInitial = false
} = {}) {
  const api = commonjs ? createRequire(import.meta.url)("@logbrew/express") : adapter;
  assert.equal(typeof api.withLogBrewExpressHandler, "function");
  const clients = [];
  const contexts = [];
  const bodies = [];
  const failures = [];
  const errors = [];
  let factoryCalls = 0;
  let tailCount = 0;
  let flushCount = 0;
  let releaseTail;
  const tail = new Promise((resolve) => { releaseTail = resolve; });
  let releaseInitial;
  const initialDelivery = new Promise((resolve) => { releaseInitial = resolve; });
  const originalError = new TypeError("handler failed");
  const transport = {
    async send(_key, body) {
      bodies.push(body);
      const hasTail = JSON.parse(body).events.some(({ type }) => type === "issue" || type === "log");
      if (slowInitial && !hasTail) { await initialDelivery; }
      return { statusCode: failTail && hasTail ? 400 : 202 };
    }
  };
  const app = express();
  app.use(api.logbrewMiddleware({
    serverApiKey: "LOGBREW_SERVER_API_KEY",
    transport,
    captureRequests: !manual,
    captureRequestMetrics: !manual,
    now: () => TIMESTAMP,
    spanIdFactory: () => SPAN_ID,
    ...(customClient ? {
      client() {
        factoryCalls += 1;
        return api.createLogBrewExpressClient({
          serverApiKey: "LOGBREW_SERVER_API_KEY",
          sdkName: "custom-request",
          context: { schemaVersion: 1, resource: { service: { name: "custom-request" } } }
        });
      }
    } : {}),
    onFlush() { flushCount += 1; },
    onCaptureError(error) { failures.push(error); }
  }));
  app.get("/tail/:id", api.withLogBrewExpressHandler(async (req, res) => {
    clients.push(req.logbrew.client);
    contexts.push(req.logbrew);
    assert.equal(req.logbrew.client, req.logbrew.logbrew);
    assert.equal(req.logbrew.transport, transport);
    if (aborted) {
      res.write("first chunk");
      res.flushHeaders();
    } else {
      res.end("ok");
    }
    await tail;
    assert.equal(api.getActiveLogBrewTrace().spanId, SPAN_ID);
    tailCount += 1;
    if (reject) { throw originalError; }
    req.logbrew.client.log(`tail-log-${tailCount}`, TIMESTAMP, { message: "handler completed", level: "info" });
    return "handler result";
  }));
  app.use(api.logbrewErrorHandler(manual ? { onCaptureError(error) { failures.push(error); } } : {}));
  app.use((error, _req, _res, _next) => { errors.push(error); });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => { releaseTail(); releaseInitial(); server.closeAllConnections(); server.close(); });
  await once(server, "listening");
  await Promise.all(Array.from({ length: concurrency }, (_value, index) => {
    const traceparent = `00-${String(index + 1).repeat(32)}-4444444444444444-00`;
    if (aborted) {
      return new Promise((resolve, rejectRequest) => {
        const socket = connect(server.address().port, "127.0.0.1", () => {
          socket.write(`GET /tail/private-id?search=private-query HTTP/1.1\r\nHost: localhost\r\nAuthorization: private-authorization\r\ntraceparent: ${traceparent}\r\n\r\n`);
        });
        socket.once("data", () => socket.destroy());
        socket.once("close", resolve);
        socket.once("error", rejectRequest);
      });
    }
    return fetch(`http://127.0.0.1:${server.address().port}/tail/private-id?search=private-query`, {
      headers: { traceparent, authorization: "private-authorization" }
    }).then(async (response) => { assert.equal(await response.text(), "ok"); });
  }));
  await waitFor(() => clients.length === concurrency && (manual || (slowInitial ? bodies.length === concurrency : flushCount === concurrency)));
  for (const client of clients) { assert.equal(client.deliveryHealth().lifecycle, "active"); }
  assert.equal(tailCount, 0);
  assert.equal(bodies.length, manual ? 0 : concurrency);
  releaseTail();
  if (slowInitial) {
    await waitFor(() => tailCount === concurrency && clients.every((client) => client.pendingEvents() === 3));
    assert.equal(bodies.length, concurrency);
    for (const client of clients) { assert.equal(client.deliveryHealth().lifecycle, "active"); }
    releaseInitial();
  }
  if (manual && !reject) {
    await waitFor(() => tailCount === concurrency && clients.every((client) => client.pendingEvents() === 1));
    assert.equal(bodies.length, 0);
    for (const context of contexts) { await context.shutdown(); }
  } else {
    await waitFor(() => clients.every((client) => failTail
      ? client.deliveryHealth().lifecycle === "active" && client.pendingEvents() === 1 && failures.length > 0
      : client.deliveryHealth().lifecycle === "closed"));
  }
  assert.equal(factoryCalls, customClient ? concurrency : 0);
  assert.equal(tailCount, concurrency);
  assert.equal(errors.length, reject ? concurrency : 0);
  for (const error of errors) { assert.equal(error, originalError); }
  assert.equal(failures.length, failTail ? concurrency : 0);
  const events = bodies.flatMap((body) => JSON.parse(body).events);
  assert.equal(events.length, (manual ? 1 : 3) * concurrency);
  assert.equal(events.filter(({ type }) => type === "span").length, manual ? 0 : concurrency);
  assert.equal(events.filter(({ type }) => type === "metric").length, manual ? 0 : concurrency);
  assert.equal(events.filter(({ type }) => type === (reject ? "issue" : "log")).length, concurrency);
  for (const event of events.filter(({ type }) => type !== "span")) {
    assert.equal(event.attributes.context.trace.spanId, SPAN_ID);
    assert.equal(event.attributes.context.trace.sampled, false);
    if (customClient) { assert.equal(event.attributes.context.resource.service.name, "custom-request"); }
  }
  const traces = events.filter(({ type }) => type === "span").map(({ attributes }) => attributes.traceId).sort();
  if (!manual) {
    assert.deepEqual(traces, Array.from({ length: concurrency }, (_value, index) => String(index + 1).repeat(32)));
    for (const event of events.filter(({ type }) => type === "span")) {
      assert.equal(event.attributes.name, "GET /tail/:id");
      assert.equal(event.attributes.status, aborted ? "error" : "ok");
    }
  }
  for (const body of bodies) {
    for (const marker of ["private-id", "private-query", "private-authorization"]) {
      assert.equal(body.includes(marker), false);
    }
  }
  if (failTail) {
    const failedBody = bodies.at(-1);
    let replay;
    await contexts[0].client.shutdown({ async send(_key, body) { replay = body; return { statusCode: 202 }; } });
    assert.equal(replay, failedBody);
  }
  assert.equal(api.getActiveLogBrewTrace(), undefined);
  for (const client of clients) { assert.equal(client.deliveryHealth().lifecycle, "closed"); }
}

test("wrapped late rejection preserves the issue after response completion", async (t) => { await checkTail(t); });
test("wrapped late log reaches delivery after response completion", async (t) => { await checkTail(t, { reject: false }); });
test("wrapped rejection after client abort preserves the issue", async (t) => { await checkTail(t, { aborted: true }); });
test("wrapped late log after client abort reaches delivery", async (t) => { await checkTail(t, { aborted: true, reject: false }); });
test("concurrent wrapped requests retain their custom clients and traces", async (t) => {
  await checkTail(t, { concurrency: 2, customClient: true });
});
test("failed wrapped tail delivery retains the exact batch for recovery", async (t) => { await checkTail(t, { failTail: true }); });
test("disabled automatic capture preserves app-owned manual delivery", async (t) => { await checkTail(t, { manual: true, reject: false }); });
test("error capture still delivers when wrapped manual requests already completed", async (t) => { await checkTail(t, { manual: true }); });
test("CommonJS exposes the explicit handler wrapper", async (t) => { await checkTail(t, { commonjs: true }); });
test("a wrapped rejection during initial delivery preserves both batches", async (t) => { await checkTail(t, { slowInitial: true }); });

test("the wrapper preserves synchronous receiver, return and throw behavior", () => {
  const wrap = adapter.withLogBrewExpressHandler;
  assert.equal(typeof wrap, "function");
  const receiver = { value: "result" };
  const result = {};
  assert.equal(wrap(function handler() { "use strict"; return this === undefined; })({}, {}, () => {}), true);
  const wrapped = wrap(function handler() { assert.equal(this, receiver); return result; });
  assert.equal(wrapped.call(receiver, {}, {}, () => {}), result);
  const failure = new TypeError("handler failure");
  assert.throws(() => wrap(() => { throw failure; })({}, {}, () => {}), (error) => error === failure);
  let rejected = false;
  try { wrap(() => { throw undefined; })({}, {}, () => {}); } catch (error) { assert.equal(error, undefined); rejected = true; }
  assert.equal(rejected, true);
});

test("the wrapper forwards a promise rejection once without requiring middleware", async () => {
  const wrap = adapter.withLogBrewExpressHandler;
  assert.equal(typeof wrap, "function");
  const failure = new TypeError("handler failure");
  const errors = [];
  assert.equal(await wrap(async () => { throw failure; })({}, {}, (error) => { errors.push(error); }), undefined);
  assert.deepEqual(errors, [failure]);
  assert.equal(await wrap(() => Promise.resolve(42))({}, {}, () => {}), 42);
  assert.equal(await wrap(() => ({ then(resolve) { resolve(42); } }))({}, {}, () => {}), 42);
  const falsyErrors = [];
  await wrap(() => Promise.reject(undefined))({}, {}, (error) => { falsyErrors.push(error); });
  assert.equal(falsyErrors.length, 1);
  assert.ok(falsyErrors[0] instanceof Error);
});

test("the wrapper rejects invalid request handlers", () => {
  for (const handler of [undefined, {}, (_error, _req, _res, _next) => {}]) {
    assert.throws(() => adapter.withLogBrewExpressHandler(handler), (error) => error.code === "configuration_error");
  }
});

test("overlapping wrapped handlers keep the client until both settle", async (t) => {
  const bodies = [];
  const errors = [];
  let client;
  let releaseFirst;
  let releaseSecond;
  let firstEnded = false;
  let secondEnded = false;
  const firstTail = new Promise((resolve) => { releaseFirst = resolve; });
  const secondTail = new Promise((resolve) => { releaseSecond = resolve; });
  const failure = new TypeError("handler failure");
  const app = express();
  app.use(adapter.logbrewMiddleware({
    serverApiKey: "LOGBREW_SERVER_API_KEY",
    transport: { async send(_key, body) { bodies.push(JSON.parse(body)); return { statusCode: 202 }; } }
  }));
  app.get("/overlap", adapter.withLogBrewExpressHandler(async (_req, _res, next) => {
    next();
    await firstTail;
    firstEnded = true;
    throw failure;
  }), adapter.withLogBrewExpressHandler(async (req, res) => {
    client = req.logbrew.client;
    res.end("ok");
    await secondTail;
    client.log("second-tail", TIMESTAMP, { message: "handler completed", level: "info" });
    secondEnded = true;
  }));
  app.use(adapter.logbrewErrorHandler());
  app.use((error, _req, _res, _next) => { errors.push(error); });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => { releaseFirst(); releaseSecond(); server.closeAllConnections(); server.close(); });
  await once(server, "listening");
  const response = await fetch(`http://127.0.0.1:${server.address().port}/overlap`);
  assert.equal(await response.text(), "ok");
  await waitFor(() => bodies.length === 1 && client.pendingEvents() === 0);
  releaseSecond();
  await waitFor(() => secondEnded && client.pendingEvents() === 1);
  assert.equal(firstEnded, false);
  assert.equal(client.deliveryHealth().lifecycle, "active");
  releaseFirst();
  await waitFor(() => client.deliveryHealth().lifecycle === "closed");
  assert.deepEqual(errors, [failure]);
  assert.equal(bodies.length, 2);
  const events = bodies.flatMap(({ events }) => events);
  assert.deepEqual(events.map(({ type }) => type), ["span", "log", "issue"]);
  const trace = events[0].attributes.traceId;
  assert.ok(events.slice(1).every(({ attributes }) => attributes.context.trace.traceId === trace));
});
