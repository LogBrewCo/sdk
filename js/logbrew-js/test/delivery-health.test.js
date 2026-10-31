import {
  STATUS_ACCEPTED,
  STATUS_UNAVAILABLE,
  assertExcludes,
  assertFields,
  blockedTransport,
  parseJson,
  sampleClient
} from "./delivery-helpers.js";
import { recordingEventStore, storedEvent } from "./delivery-store-helpers.js";
import { RecordingTransport } from "@logbrew/sdk";
import assert from "node:assert/strict";
import test from "node:test";
import { withReplacements } from "./delivery-timer-helpers.js";

/**
 * @import { BlockedTransport, LooseTransport } from "./delivery-helpers.js"
 * @import { DeliveryHealthSnapshot, LogBrewClient } from "@logbrew/sdk"
 */

const NONE = 0;
const ONE = 1;
const FIRST_CLOCK_MS = 2000;
const REGRESSED_CLOCK_MS = 1000;
const LATER_CLOCK_MS = 3000;

/**
 * @returns {{ readonly bodies: readonly string[], readonly transport: LooseTransport }}
 */
function retryOnceTransport() {
  /** @type {string[]} */
  const bodies = [];
  return {
    bodies,
    transport: {
      async send(_apiKey, body) {
        bodies.push(body);
        return { statusCode: bodies.length === ONE ? STATUS_UNAVAILABLE : STATUS_ACCEPTED };
      }
    }
  };
}

/**
 * @param {DeliveryHealthSnapshot} health
 * @returns {void}
 */
function assertAcceptedAfterRetry(health) {
  assertFields(health, {
    acceptedEvents: 1,
    attempts: 2,
    batches: 1,
    deliveryState: "accepted",
    lastStatusClass: "success",
    schemaVersion: 1,
    storage: "memory"
  });
  assert.equal(health.lastAttemptAtUnixMs > NONE, true);
  assert.equal(health.lastAcceptedAtUnixMs >= health.lastAttemptAtUnixMs, true);
}

/**
 * @param {DeliveryHealthSnapshot} health
 * @returns {void}
 */
function assertStablePrivateJson(health) {
  assert.equal(Object.isFrozen(health), true);
  assert.equal(Object.isFrozen(health.droppedByReason), true);
  const serialized = JSON.stringify(health);
  assert.deepEqual(parseJson(serialized), health);
  assertExcludes(serialized, ["private-key-value", "private-sdk-name", "private-event-id", "private payload text"]);
  assert.equal(Object.hasOwn(health, "statusCode"), false);
}

/**
 * @param {LogBrewClient} client
 * @param {(now: number) => void} setNow
 * @returns {void}
 */
function dropAcrossClockRegression(client, setNow) {
  client.log("evt_kept_clock", "2026-06-02T10:00:00Z", { level: "info", message: "kept" });
  client.log("evt_drop_clock_1", "2026-06-02T10:00:01Z", { level: "info", message: "drop" });
  assert.equal(client.deliveryHealth().lastDroppedAtUnixMs, FIRST_CLOCK_MS);

  setNow(REGRESSED_CLOCK_MS);
  client.log("evt_drop_clock_2", "2026-06-02T10:00:02Z", { level: "info", message: "drop again" });
  assert.equal(client.deliveryHealth().lastDroppedAtUnixMs, FIRST_CLOCK_MS);
}

/**
 * @param {LogBrewClient} client
 * @param {BlockedTransport} gate
 * @returns {Promise<{ readonly flush: Promise<unknown>, readonly shutdown: Promise<unknown> }>}
 */
async function startOverlap(client, gate) {
  const flush = client.flush();
  await gate.started.promise;
  const shutdown = client.shutdown();
  return { flush, shutdown };
}

await test("delivery health snapshot reports exact retry acceptance with stable private JSON", async () => {
  const { bodies, transport } = retryOnceTransport();
  const client = sampleClient({ apiKey: "private-key-value", automaticDelivery: false, maxRetries: 1, sdkName: "private-sdk-name", transport });
  client.log("private-event-id", "2026-06-02T10:00:00Z", { level: "error", message: "private payload text" });

  await client.flush();

  const health = client.deliveryHealth();
  assertAcceptedAfterRetry(health);
  const [firstBody, secondBody] = bodies;
  assert.equal(firstBody, secondBody);
  assertStablePrivateJson(health);
});

await test("delivery health snapshot reports bounded queue drops by stable reason", () => {
  const client = sampleClient({ maxQueueSize: 1 });
  client.log("evt_kept_001", "2026-06-02T10:00:00Z", { level: "info", message: "kept" });
  client.log("evt_dropped_001", "2026-06-02T10:00:01Z", { level: "info", message: "dropped" });

  const health = client.deliveryHealth();
  assert.equal(health.droppedEvents, ONE);
  assert.equal(health.lastDropReason, "queue_overflow");
  assert.deepEqual(health.droppedByReason, { event_too_large: 0, evicted_for_fatal: 0, queue_bytes_overflow: 0, queue_overflow: 1 });
  assert.equal(health.lastDroppedAtUnixMs > NONE, true);
});

await test("delivery health timestamps do not move backward when the wall clock regresses", async () => {
  const clock = { now: FIRST_CLOCK_MS };
  await withReplacements(Date, { now: () => clock.now }, async () => {
    const client = sampleClient({ automaticDelivery: false, maxQueueSize: 1, transport: RecordingTransport.alwaysAccept() });
    dropAcrossClockRegression(client, (now) => {
      clock.now = now;
    });

    clock.now = LATER_CLOCK_MS;
    await client.flush();
    const accepted = client.deliveryHealth();
    assert.equal(accepted.lastAttemptAtUnixMs, LATER_CLOCK_MS);
    assert.equal(accepted.lastAcceptedAtUnixMs, LATER_CLOCK_MS);
  });
});

await test("delivery health snapshot reports persisted restart hydration without content", () => {
  const store = recordingEventStore([storedEvent("log", "private-recovered-event")]);
  const client = sampleClient({ apiKey: "private-key-value", eventStore: store, sdkName: "private-sdk-name" });

  const health = client.deliveryHealth();
  assertFields(health, {
    deliveryState: "queued",
    hydratedBytes: store.records.at(NONE)?.eventBytes,
    hydratedEvents: 1,
    queueEvents: 1,
    storage: "persistent"
  });
  assertExcludes(JSON.stringify(health), ["private-key-value", "private-sdk-name", "private-recovered-event"]);
});

await test("delivery health snapshot stays coherent across overlapping flush and shutdown", async () => {
  const gate = blockedTransport();
  const client = sampleClient({ automaticDelivery: false, transport: gate.transport });
  client.log("evt_overlap_001", "2026-06-02T10:00:00Z", { level: "info", message: "overlap" });

  const { flush, shutdown } = await startOverlap(client, gate);
  assertFields(client.deliveryHealth(), { deliveryState: "in_flight", inFlight: true, lifecycle: "shutting_down", pendingOperations: 2 });

  gate.response.resolve({ statusCode: STATUS_ACCEPTED });
  await flush;
  await shutdown;
  assertFields(client.deliveryHealth(), { acceptedEvents: 1, inFlight: false, lifecycle: "closed", pendingOperations: 0 });
});

await test("delivery health snapshot classifies malformed transport responses without leaking them", async () => {
  const client = sampleClient({
    automaticDelivery: false,
    maxRetries: 0,
    transport: {
      async send() {
        return { responseBody: "private-response-body", statusCode: "private-malformed-status" };
      }
    }
  });
  client.log("evt_malformed_001", "2026-06-02T10:00:00Z", { level: "error", message: "private event body" });

  await assert.rejects(client.flush(), /invalid transport response/u);

  const health = client.deliveryHealth();
  assertFields(health, { deliveryState: "queued", lastOutcome: "failed", lastStatusClass: "invalid_response" });
  assertExcludes(JSON.stringify(health), ["private-malformed-status", "private-response-body", "private event body", "evt_malformed_001"]);
});
