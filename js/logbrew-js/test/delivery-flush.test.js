import {
  STATUS_ACCEPTED,
  STATUS_UNAVAILABLE,
  assertEventTypes,
  assertFields,
  enqueueAll,
  gatedFirstSend,
  parseJson,
  sampleClient
} from "./delivery-helpers.js";
import { activeTimer, hasActiveTimer, withFakeTimers } from "./delivery-timer-helpers.js";
import { RecordingTransport } from "@logbrew/sdk";
import assert from "node:assert/strict";
import test from "node:test";

/**
 * @import { FakeTimer } from "./delivery-timer-helpers.js"
 * @import { LogBrewClient } from "@logbrew/sdk"
 */

const ONE_ATTEMPT = 1;
const ONE_EVENT = 1;
const NO_EVENTS = 0;
const INTERVAL_MS = 2500;

/**
 * @param {LogBrewClient} client
 * @param {readonly Readonly<FakeTimer>[]} timers
 * @returns {void}
 */
function assertDrainedWithoutTimer(client, timers) {
  assert.equal(client.pendingEvents(), NO_EVENTS);
  assert.equal(client.deliveryHealth().scheduled, false);
  assert.equal(hasActiveTimer(timers), false);
}

await test("previewJson contains all supported event types", () => {
  const client = sampleClient();
  enqueueAll(client);
  const payload = parseJson(client.previewJson());
  assertEventTypes(payload);
});

await test("flush success clears the queue", async () => {
  const client = sampleClient();
  enqueueAll(client);
  const transport = RecordingTransport.alwaysAccept();

  const response = await client.flush(transport);

  assert.equal(response.statusCode, STATUS_ACCEPTED);
  assert.equal(response.attempts, ONE_ATTEMPT);
  assert.equal(client.pendingEvents(), NO_EVENTS);
  assert.match(transport.lastBody() ?? "", /"events"/u);
});

await test("manual flush clears backoff armed while it waited behind automatic delivery", async () => withFakeTimers(async (timers) => {
  const gate = gatedFirstSend(STATUS_UNAVAILABLE);
  const client = sampleClient({ deliveryQueueThreshold: 1, maxRetries: 0, transport: gate.transport });

  client.log("evt_manual_after_auto", "2026-06-02T10:00:00Z", { level: "info", message: "queued" });
  await gate.started.promise;
  const manualFlush = client.flush();
  gate.release.resolve();
  await manualFlush;

  const [firstBody, secondBody] = gate.bodies;
  assert.equal(firstBody, secondBody);
  assertDrainedWithoutTimer(client, timers);
}));

await test("custom manual flush failure restores the owned automatic scheduler", async () => withFakeTimers(async (timers) => {
  const ownedTransport = RecordingTransport.alwaysAccept();
  const client = sampleClient({ deliveryIntervalMs: INTERVAL_MS, deliveryQueueThreshold: 10, maxRetries: 0, transport: ownedTransport });
  client.log("evt_custom_flush_failure", "2026-06-02T10:00:00Z", { level: "info", message: "queued" });
  const initialTimer = activeTimer(timers);

  await assert.rejects(client.flush(new RecordingTransport([{ statusCode: 400 }])), /unexpected transport status 400/u);

  assert.equal(initialTimer?.cleared, true);
  assert.equal(client.pendingEvents(), ONE_EVENT);
  assertFields(client.deliveryHealth(), { pausedReason: "none", scheduled: true });
  assert.equal(activeTimer(timers)?.delay, INTERVAL_MS);
  assert.equal(ownedTransport.sentBodies.length, NO_EVENTS);
}));
