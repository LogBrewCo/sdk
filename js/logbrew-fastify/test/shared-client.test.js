import { createLogBrewFastifyClient, logbrewFastifyPlugin } from "@logbrew/fastify";
import { RecordingTransport } from "@logbrew/sdk";
import assert from "node:assert/strict";
import fastify from "fastify";
import { once } from "node:events";
import test from "node:test";

/**
 * @import { FastifyInstance } from "fastify"
 * @import { LogBrewClient } from "@logbrew/sdk"
 * @import { LogBrewFastifyOptions } from "@logbrew/fastify"
 * @typedef {{
 *   readonly captureErrors: readonly unknown[],
 *   readonly flushed: () => Promise<unknown>,
 *   readonly hooks: Pick<LogBrewFastifyOptions, "onCaptureError" | "onFlush">,
 *   readonly transport: RecordingTransport
 * }} Delivery
 */

const SERVER_API_KEY = "LOGBREW_SERVER_API_KEY";
const TIMESTAMP = "2026-06-02T10:00:00Z";
const FLUSHED = "flushed";
const TEST_TIMEOUT_MS = 10_000;
const SPANS = 3;
const ONE = 1;

/**
 * @param {unknown} value
 * @returns {value is Readonly<Record<string, unknown>>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null;
}

/**
 * @param {unknown} value
 * @returns {value is readonly unknown[]}
 */
function isList(value) {
  return Array.isArray(value);
}

/**
 * @param {readonly string[]} bodies
 * @returns {readonly unknown[]}
 */
function eventTypes(bodies) {
  return bodies.flatMap((body) => {
    /** @type {unknown} */
    const batch = JSON.parse(body);
    const events = isRecord(batch) ? batch["events"] : undefined;
    return isList(events) ? events.map((event) => (isRecord(event) ? event["type"] : undefined)) : [];
  });
}

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
 * @param {LogBrewFastifyOptions} options
 * @returns {Promise<FastifyInstance>}
 */
async function createApp(options) {
  const app = fastify();
  await app.register(logbrewFastifyPlugin, options);
  app.get("/ok", async () => ({ ok: true }));
  app.get("/fail", async () => {
    throw new Error("checkout failed");
  });
  return app;
}

/**
 * @param {FastifyInstance} app
 * @param {string} url
 * @param {() => Promise<unknown>} flushed
 * @returns {Promise<void>}
 */
async function requestAndFlush(app, url, flushed) {
  const settled = flushed();
  await app.inject({ method: "GET", url });
  await settled;
}

/**
 * @param {Delivery} delivery
 * @param {LogBrewClient} client
 * @returns {void}
 */
function assertClientStayedOpen(delivery, client) {
  assert.deepEqual(delivery.captureErrors, []);
  const types = eventTypes(delivery.transport.sentBodies);
  assert.deepEqual([types.filter((type) => type === "span").length, types.includes("issue")], [SPANS, true]);
  client.log("evt_after_requests", TIMESTAMP, { level: "info", message: "still open" });
  assert.equal(client.pendingEvents(), ONE);
}

void test("plugin keeps an application client open across requests", { timeout: TEST_TIMEOUT_MS }, async (testContext) => {
  const delivery = createDelivery();
  const client = createLogBrewFastifyClient({ serverApiKey: SERVER_API_KEY });
  const app = await createApp({ ...delivery.hooks, client, transport: delivery.transport });
  testContext.after(async () => app.close());
  await requestAndFlush(app, "/ok", delivery.flushed);
  await requestAndFlush(app, "/fail", delivery.flushed);
  await requestAndFlush(app, "/ok", delivery.flushed);
  assertClientStayedOpen(delivery, client);
});
