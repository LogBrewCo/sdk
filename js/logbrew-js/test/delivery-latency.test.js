import test from "node:test";
import assert from "node:assert/strict";

import { LogBrewClient } from "../index.js";

const timestamp = "2026-06-02T10:00:00Z";

function timedTransport() {
  const sends = [];
  let notify;
  const firstSend = new Promise((resolve) => { notify = resolve; });
  return {
    sends,
    firstSend,
    send(_apiKey, body) {
      sends.push({ at: performance.now(), events: JSON.parse(body).events.length });
      notify();
      return { statusCode: 202 };
    }
  };
}

function createClient(transport) {
  return LogBrewClient.create({ apiKey: "LOGBREW_API_KEY", sdkName: "logbrew-js", sdkVersion: "0.1.0", transport });
}

const deadline = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

test("a single event is delivered within about one second by default", async () => {
  const transport = timedTransport();
  const client = createClient(transport);
  const capturedAt = performance.now();
  client.log("evt_log_001", timestamp, { message: "checkout ready", level: "info" });

  await Promise.race([transport.firstSend, deadline(1500)]);

  assert.equal(transport.sends.length, 1, "the default interval must deliver one event within 1.5 s");
  assert.ok(transport.sends[0].at - capturedAt >= 900, "the first event still waits for its batch window");
  await client.shutdown();
});

test("a burst inside the delivery window still goes out as one request", async () => {
  const transport = timedTransport();
  const client = createClient(transport);
  for (let index = 0; index < 20; index += 1) {
    client.log(`evt_log_${index}`, timestamp, { message: "burst", level: "info" });
  }

  await Promise.race([transport.firstSend, deadline(1500)]);

  assert.deepEqual(transport.sends.map(({ events }) => events), [20]);
  await client.shutdown();
});
