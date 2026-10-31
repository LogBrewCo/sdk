import { CLIENT_IDENTITY, field, items, parseJson } from "./capture-helpers.js";
import { LogBrewClient } from "@logbrew/sdk";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import test from "node:test";

/**
 * @import { Transport, TransportResponse } from "@logbrew/sdk"
 */

/**
 * @typedef {{ readonly at: number, readonly events: number }} TimedSend
 * @typedef {Transport & { readonly firstSend: Promise<unknown>, readonly sends: TimedSend[] }} TimedTransport
 */

const timestamp = "2026-06-02T10:00:00Z";
const ACCEPTED = 202;
const DELIVERY_DEADLINE_MS = 1500;
const MIN_BATCH_WINDOW_MS = 900;
const BURST_SIZE = 20;
const ONE_REQUEST = 1;

/**
 * @returns {TimedTransport}
 */
function timedTransport() {
  /** @type {TimedSend[]} */
  const sends = [];
  const notifier = new EventTarget();
  return {
    firstSend: once(notifier, "send"),
    /**
     * @param {string} _apiKey
     * @param {string} body
     * @returns {TransportResponse}
     */
    send(_apiKey, body) {
      const payload = parseJson(body);
      sends.push({ at: performance.now(), events: items(field(payload, "events")).length });
      notifier.dispatchEvent(new Event("send"));
      return { attempts: 1, statusCode: ACCEPTED };
    },
    sends
  };
}

/**
 * @param {Transport} transport
 * @returns {LogBrewClient}
 */
function createClient(transport) {
  return LogBrewClient.create({ ...CLIENT_IDENTITY, transport });
}

/**
 * @param {Readonly<Promise<unknown>>} firstSend
 * @returns {Promise<void>}
 */
async function firstSendOrDeadline(firstSend) {
  const deadline = new AbortController();
  try {
    await Promise.race([firstSend, delay(DELIVERY_DEADLINE_MS, undefined, { signal: deadline.signal })]);
  } finally {
    deadline.abort();
  }
}

await test("a single event is delivered within about one second by default", async () => {
  const transport = timedTransport();
  const client = createClient(transport);
  const capturedAt = performance.now();
  client.log("evt_log_001", timestamp, { level: "info", message: "checkout ready" });

  await firstSendOrDeadline(transport.firstSend);

  assert.equal(transport.sends.length, ONE_REQUEST, "the default interval must deliver one event within 1.5 s");
  const [first] = transport.sends;
  assert.ok(first !== undefined && first.at - capturedAt >= MIN_BATCH_WINDOW_MS, "the first event still waits for its batch window");
  await client.shutdown();
});

await test("a burst inside the delivery window still goes out as one request", async () => {
  const transport = timedTransport();
  const client = createClient(transport);
  for (const index of Array.from({ length: BURST_SIZE }).keys()) {
    client.log(`evt_log_${index}`, timestamp, { level: "info", message: "burst" });
  }

  await firstSendOrDeadline(transport.firstSend);

  assert.deepEqual(transport.sends.map(({ events }) => events), [BURST_SIZE]);
  await client.shutdown();
});
