import { logbrewMiddleware, withLogBrewExpressHandler } from "@logbrew/express";
import { RecordingTransport } from "@logbrew/sdk";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";

/**
 * @import { Request, Response } from "express"
 */

const NO_PORT = 0;
const ANY_PORT = 0;
const ONE = 1;
const INITIAL_DELIVERY = 1;
const COMPLETE_DELIVERY = 2;
const OPEN = "open";

/**
 * @returns {{ readonly open: () => void, readonly wait: () => Promise<unknown> }}
 */
function createGate() {
  const target = new EventTarget();
  const opened = once(target, OPEN);
  return {
    open: () => {
      target.dispatchEvent(new Event(OPEN));
    },
    wait: async () => opened
  };
}

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {unknown}
 */
function readField(value, key) {
  /** @type {unknown} */
  const field = typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
  return field;
}

/**
 * @param {string} body
 * @returns {readonly unknown[]}
 */
function eventsOf(body) {
  /** @type {unknown} */
  const batch = JSON.parse(body);
  const events = readField(batch, "events");
  return Array.isArray(events) ? events : [];
}

const transport = RecordingTransport.alwaysAccept();
const work = createGate();
const initialDelivery = createGate();
const delivered = createGate();
const app = express();
let deliveries = 0;

/**
 * @param {Request} req
 * @param {Response} res
 * @returns {Promise<void>}
 */
async function health(req, res) {
  res.json({ ok: true });
  await work.wait();
  req.logbrew?.client.log("evt_handler_complete", new Date().toISOString(), {
    level: "info",
    message: "handler work completed"
  });
}

app.use(logbrewMiddleware({
  onFlush: () => {
    deliveries += ONE;
    if (deliveries === INITIAL_DELIVERY) {
      initialDelivery.open();
    }
    if (deliveries === COMPLETE_DELIVERY) {
      delivered.open();
    }
  },
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  transport
}));
app.get("/health", withLogBrewExpressHandler(health));

const server = app.listen(ANY_PORT, "127.0.0.1");
await once(server, "listening");
try {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : NO_PORT;
  const response = await fetch(`http://127.0.0.1:${String(port)}/health`);
  assert.deepEqual(await response.json(), { ok: true });
  await initialDelivery.wait();
  work.open();
  await delivered.wait();
  const events = transport.sentBodies.flatMap((body) => eventsOf(body));
  assert.deepEqual(events.map((event) => readField(event, "type")), ["span", "log"]);
  process.stdout.write(`${JSON.stringify({
    ok: true,

    events
  })}\n`);
} finally {
  work.open();
  server.closeAllConnections();
  server.close();
  await once(server, "close");
}
