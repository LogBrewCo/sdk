import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { createLogBrewNodeClient, withLogBrewHttpHandler } from "@logbrew/node";

async function runHandlerTail(t, { reject = true, slow = false, deliveryFailure = false, thenable = false } = {}) {
  const batches = [];
  const captureFailures = [];
  const client = createLogBrewNodeClient({ serverApiKey: "LOGBREW_SERVER_API_KEY", automaticDelivery: false });
  let resolveFlushed;
  const flushed = new Promise((resolve) => { resolveFlushed = resolve; });
  let resolveTail;
  const tail = new Promise((resolve) => { resolveTail = resolve; });
  let resolveHandled;
  const handled = new Promise((resolve) => { resolveHandled = resolve; });
  let resolveStarted;
  const started = new Promise((resolve) => { resolveStarted = resolve; });
  let resolveTransport;
  const transportGate = new Promise((resolve) => { resolveTransport = resolve; });
  let flushCount = 0;
  const failure = new TypeError("late handler failure");
  const server = createServer(withLogBrewHttpHandler((_req, res) => {
    res.end("ok");
    const operation = tail.then(() => {
      if (reject) {
        throw failure;
      }
      client.log("tail-log", "2026-08-29T12:00:00Z", { message: "handler completed", level: "info" });
    });
    return thenable ? { then: (resolve, rejectOperation) => operation.then(resolve, rejectOperation) } : operation;
  }, {
    client,
    transport: {
      async send(_key, body) {
        batches.push(JSON.parse(body));
        if (batches.length === 1) {
          resolveStarted();
          if (slow) {
            await transportGate;
          }
        }
        return { statusCode: deliveryFailure && batches.length === 2 ? 400 : 202 };
      }
    },
    idFactory: () => "request-span",
    spanIdFactory: () => "2222222222222222",
    traceIdFactory: () => "11111111111111111111111111111111",
    onFlush() {
      flushCount += 1;
      resolveFlushed();
      if (!reject && flushCount === 2) {
        resolveHandled();
      }
    },
    onCaptureError(error) { captureFailures.push(error); },
    onError(error) { assert.equal(error, failure); resolveHandled(); }
  }));
  t.after(() => { resolveTail(); resolveTransport(); server.closeAllConnections(); server.close(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const response = await fetch(`http://127.0.0.1:${server.address().port}/stream?search=private-query`);
  assert.equal(await response.text(), "ok");
  await (slow ? started : flushed);
  resolveTail();
  resolveTransport();
  await handled;
  assert.equal(captureFailures.length, deliveryFailure ? 1 : 0);
  assert.equal(client.pendingEvents(), deliveryFailure ? 1 : 0);
  const events = batches.flatMap(({ events: captured }) => captured);
  assert.equal(events.filter(({ type }) => type === "span").length, 1);
  assert.equal(events.length, 2);
  const event = events.find(({ type }) => type === (reject ? "issue" : "log"));
  assert.ok(event, "handler tail was lost after response shutdown");
  assert.equal(event.attributes.context.trace.traceId, "11111111111111111111111111111111");
  assert.equal(event.attributes.context.trace.spanId, "2222222222222222");
  assert.equal(JSON.stringify(events).includes("private-query"), false);
}

test("a handler rejection after response delivery preserves the correlated issue", async (t) => {
  await runHandlerTail(t);
});
test("successful handler tails deliver their log before shutdown", async (t) => {
  await runHandlerTail(t, { reject: false });
});
test("a rejection during request delivery preserves both serialized batches", async (t) => {
  await runHandlerTail(t, { slow: true });
});
test("failed late issue delivery retains the issue for recovery", async (t) => {
  await runHandlerTail(t, { deliveryFailure: true });
});
test("thenable handler tails retain their trace and application result", async (t) => {
  await runHandlerTail(t, { reject: false, thenable: true });
});
