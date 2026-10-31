import { RecordingTransport, SdkError } from "@logbrew/sdk";
import {
  STATUS_ACCEPTED,
  STATUS_NO_CONTENT,
  assertFields,
  blockedTransport,
  deferred,
  flushWith,
  sampleClient
} from "./delivery-helpers.js";
import { callNames, recordingEventStore, storedEvent } from "./delivery-store-helpers.js";
import { fire, waitForCondition, withFakeTimers } from "./delivery-timer-helpers.js";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";

/**
 * @import { Deferred, LooseTransport } from "./delivery-helpers.js"
 * @import { FakeTimer } from "./delivery-timer-helpers.js"
 * @import { StoreCall } from "./delivery-store-helpers.js"
 * @import { LogBrewClient, TransportResponse } from "@logbrew/sdk"
 * @typedef {{ readonly bodies: readonly string[], readonly response: Deferred, readonly started: Deferred, readonly transport: LooseTransport }} HeldTransport
 */

const NONE = 0;
const ONE = 1;
const INTERVAL_MS = 2500;

/**
 * @param {LogBrewClient} client
 * @param {RecordingTransport} transport
 * @param {Readonly<FakeTimer> | undefined} scheduledTimer
 * @returns {void}
 */
function assertClosedAfterShutdown(client, transport, scheduledTimer) {
  assert.equal(scheduledTimer?.cleared, true);
  assert.equal(client.deliveryHealth().lifecycle, "closed");
  assert.equal(transport.sentBodies.length, ONE);
  assert.throws(
    () => {
      client.log("evt_after_shutdown", "2026-06-02T10:00:01Z", { level: "info", message: "ignored" });
    },
    /already shut down/u
  );
}

/**
 * @param {LogBrewClient} client
 * @param {RecordingTransport} transport
 * @param {Readonly<FakeTimer> | undefined} scheduledTimer
 * @returns {Promise<void>}
 */
async function assertStaleCallbackIgnored(client, transport, scheduledTimer) {
  fire(scheduledTimer);
  await nextTurn();
  assert.equal(transport.sentBodies.length, ONE);
  assert.equal(client.deliveryHealth().lifecycle, "closed");
}

/**
 * @returns {HeldTransport}
 */
function heldTransport() {
  const started = deferred();
  const response = deferred();
  /** @type {string[]} */
  const bodies = [];
  return {
    bodies,
    response,
    started,
    transport: {
      async send(_apiKey, body) {
        bodies.push(body);
        started.resolve();
        await response.promise;
        return { attempts: 1, statusCode: STATUS_ACCEPTED };
      }
    }
  };
}

/**
 * @param {LogBrewClient} client
 * @param {readonly string[]} bodies
 * @param {Readonly<Promise<TransportResponse>>} shutdown
 * @returns {Promise<void>}
 */
async function assertShutdownDrained(client, bodies, shutdown) {
  const response = await shutdown;
  assert.equal(response.statusCode, STATUS_NO_CONTENT);
  assert.equal(bodies.length, ONE);
  assert.equal(client.pendingEvents(), NONE);
  assertFields(client.deliveryHealth(), { coalesced: false, lifecycle: "closed", scheduled: false });
}

/**
 * @param {LogBrewClient} client
 * @param {readonly StoreCall[]} calls
 * @returns {void}
 */
function assertPurgedAfterFailedFlush(client, calls) {
  assert.equal(client.purgePendingEvents(), ONE);
  assert.equal(client.pendingEvents(), NONE);
  assert.equal(client.pendingBytes(), NONE);
  assert.deepEqual(callNames(calls), ["load", "append", "load", "purge"]);
}

await test("automatic delivery schedules recovered work and shutdown cancels stale callbacks", async () => withFakeTimers(async (timers) => {
  const store = recordingEventStore([storedEvent("log", "evt_recovered_auto_001")]);
  const transport = RecordingTransport.alwaysAccept();
  const client = sampleClient({ deliveryIntervalMs: INTERVAL_MS, eventStore: store, transport });
  assert.equal(timers.length, ONE);
  const [scheduledTimer] = timers;

  const response = await client.shutdown();
  assert.equal(response.statusCode, STATUS_ACCEPTED);
  assertClosedAfterShutdown(client, transport, scheduledTimer);
  await assertStaleCallbackIgnored(client, transport, scheduledTimer);
}));

await test("shutdown serializes behind active automatic delivery and permits no later mutation", async () => withFakeTimers(async () => {
  const gate = heldTransport();
  const client = sampleClient({ deliveryQueueThreshold: 1, transport: gate.transport });
  client.log("evt_shutdown_race_001", "2026-06-02T10:00:00Z", { level: "info", message: "before shutdown" });
  await gate.started.promise;

  const shutdown = client.shutdown();
  assert.equal(client.deliveryHealth().lifecycle, "shutting_down");
  assert.throws(
    () => {
      client.log("evt_shutdown_race_002", "2026-06-02T10:00:01Z", { level: "info", message: "late" });
    },
    /client is shutting down/u
  );
  gate.response.resolve();
  await assertShutdownDrained(client, gate.bodies, shutdown);
}));

await test("immediate shutdown supersedes an automatic threshold task before it starts", async () => withFakeTimers(async () => {
  const transport = RecordingTransport.alwaysAccept();
  const client = sampleClient({ deliveryQueueThreshold: 1, transport });
  client.log("evt_shutdown_before_auto_001", "2026-06-02T10:00:00Z", { level: "info", message: "shutdown wins" });

  await client.shutdown();
  const healthAtShutdown = client.deliveryHealth();
  await nextTurn();
  await nextTurn();

  assert.equal(transport.sentBodies.length, ONE);
  assert.equal(healthAtShutdown.flushes, ONE);
  assert.deepEqual(client.deliveryHealth(), healthAtShutdown);
}));

await test("purge rejects an automatic threshold cohort before its microtask starts", async () => withFakeTimers(async () => {
  const transport = RecordingTransport.alwaysAccept();
  const client = sampleClient({ deliveryQueueThreshold: 1, transport });
  client.log("evt_purge_race_001", "2026-06-02T10:00:00Z", { level: "info", message: "automatic cohort" });

  assert.throws(() => client.purgePendingEvents(), /delivery operation is active/u);
  await waitForCondition(() => client.pendingEvents() === NONE, "automatic cohort did not finish");
  assert.equal(transport.sentBodies.length, ONE);
}));

await test("explicit purge clears memory and persistence but rejects an active flush", async () => {
  const store = recordingEventStore();
  const client = sampleClient({ eventStore: store });
  client.log("evt_purge_001", "2026-06-02T10:00:00Z", { level: "info", message: "purge" });
  const gate = blockedTransport();
  const flushPromise = flushWith(client, gate.transport);
  await gate.started.promise;

  assert.throws(() => client.purgePendingEvents(), /cannot purge while a delivery operation is active/u);
  gate.response.resolve({ statusCode: 500 });
  await assert.rejects(flushPromise, /unexpected transport status 500/u);
  assertPurgedAfterFailedFlush(client, store.calls);
});

await test("successful shutdown closes the event store while failure leaves it retryable", async () => {
  const store = recordingEventStore();
  const client = sampleClient({ eventStore: store, maxRetries: 0 });
  client.log("evt_shutdown_store_001", "2026-06-02T10:00:00Z", { level: "info", message: "retry" });

  await assert.rejects(client.shutdown(new RecordingTransport([{ statusCode: 503 }])), /unexpected transport status 503/u);
  assert.equal(store.calls.some(([name]) => name === "close"), false);
  await client.shutdown(RecordingTransport.alwaysAccept());
  assert.deepEqual(callNames(store.calls), ["load", "append", "load", "load", "acknowledge", "close"]);
});

await test("event store close failure leaves the client terminal instead of reopening without ownership", async () => {
  const store = recordingEventStore();
  store.close = () => {
    throw new SdkError("persistence_commit_error", "persistent owner release could not be confirmed");
  };
  const client = sampleClient({ eventStore: store });

  await assert.rejects(client.shutdown(RecordingTransport.alwaysAccept()), /persistent owner release could not be confirmed/u);
  assert.throws(
    () => {
      client.log("evt_after_close_failure", "2026-06-02T10:00:00Z", { level: "info", message: "closed" });
    },
    /client is already shut down/u
  );
});
