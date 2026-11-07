import { ANY_PORT, HOST, SERVER_ERROR, eventType, eventsOfBodies, finalErrorHandler, serve } from "./support.js";
import { createLogBrewExpressClient, logbrewErrorHandler, logbrewMiddleware } from "@logbrew/express";
import { RecordingTransport } from "@logbrew/sdk";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import test from "node:test";

/**
 * @import { Express, Request, Response } from "express"
 * @import { LogBrewClient } from "@logbrew/sdk"
 * @import { LogBrewExpressOptions, LogBrewExpressSharedOptions } from "@logbrew/express"
 * @typedef {{
 *   readonly captureErrors: readonly unknown[],
 *   readonly flushed: () => Promise<unknown>,
 *   readonly hooks: Pick<LogBrewExpressOptions & LogBrewExpressSharedOptions, "onCaptureError" | "onFlush">,
 *   readonly transport: RecordingTransport
 * }} Delivery
 */

const SERVER_API_KEY = "lb_server_test_shared";
const TIMESTAMP = "2026-06-02T10:00:00Z";
const FLUSHED = "flushed";
const TEST_TIMEOUT_MS = 10_000;
const SPANS = 3;
const ONE = 1;

/**
 * @returns {Delivery}
 */
function createDelivery() {
  const flushes = new EventTarget();
  /** @type {unknown[]} */
  const captureErrors = [];
  /**
   * @returns {void}
   */
  function settle() {
    flushes.dispatchEvent(new Event(FLUSHED));
  }
  return {
    captureErrors,
    flushed: async () => once(flushes, FLUSHED),
    hooks: {
      onCaptureError: (error) => {
        captureErrors.push(error);
        settle();
      },
      onFlush: settle
    },
    transport: RecordingTransport.alwaysAccept()
  };
}

/**
 * @param {Request} _req
 * @param {Response} res
 * @returns {void}
 */
function sendOk(_req, res) {
  res.send("ok");
}

/**
 * @returns {never}
 */
function failCheckout() {
  throw new TypeError("checkout failed");
}

/**
 * @param {unknown} _error
 * @param {Response} res
 * @returns {void}
 */
function respondFailed(_error, res) {
  res.status(SERVER_ERROR).end("failed");
}

/**
 * @param {LogBrewExpressSharedOptions} options
 * @returns {Express}
 */
function createApp(options) {
  const app = express();
  app.use(logbrewMiddleware(options));
  app.get("/ok", sendOk);
  app.get("/fail", failCheckout);
  app.use(logbrewErrorHandler(options));
  app.use(finalErrorHandler(respondFailed));
  return app;
}

/**
 * @param {string} url
 * @param {() => Promise<unknown>} flushed
 * @returns {Promise<void>}
 */
async function requestAndFlush(url, flushed) {
  const settled = flushed();
  const response = await fetch(url);
  await response.text();
  await settled;
}

/**
 * @param {Delivery} delivery
 * @param {LogBrewClient} client
 * @returns {void}
 */
function assertClientStayedOpen(delivery, client) {
  assert.deepEqual(delivery.captureErrors, []);
  const types = eventsOfBodies(delivery.transport.sentBodies).map((event) => eventType(event));
  assert.deepEqual([types.filter((type) => type === "span").length, types.includes("issue")], [SPANS, true]);
  client.log("evt_after_requests", TIMESTAMP, { level: "info", message: "still open" });
  assert.equal(client.pendingEvents(), ONE);
}

void test("middleware keeps an application client open across requests", { timeout: TEST_TIMEOUT_MS }, async (testContext) => {
  const delivery = createDelivery();
  const client = createLogBrewExpressClient({ serverApiKey: SERVER_API_KEY });
  const app = createApp({ ...delivery.hooks, client, transport: delivery.transport });
  const server = await serve(testContext, () => app.listen(ANY_PORT, HOST));
  const origin = `http://${HOST}:${server.port}`;
  await requestAndFlush(`${origin}/ok`, delivery.flushed);
  await requestAndFlush(`${origin}/fail`, delivery.flushed);
  await requestAndFlush(`${origin}/ok`, delivery.flushed);
  assertClientStayedOpen(delivery, client);
});
