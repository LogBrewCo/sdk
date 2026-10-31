import {
  STATUS_ACCEPTED,
  STATUS_UNAVAILABLE,
  assertExcludes,
  assertFields,
  eventIds,
  gatedFirstSend,
  sampleClient
} from "./delivery-helpers.js";
import { activeTimer, fire, waitForCondition, withFakeTimers, withReplacements } from "./delivery-timer-helpers.js";
import { RecordingTransport } from "@logbrew/sdk";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";

/**
 * @import { GatedTransport, LooseTransport } from "./delivery-helpers.js"
 * @import { FakeTimer } from "./delivery-timer-helpers.js"
 * @import { LogBrewClient } from "@logbrew/sdk"
 */

const INTERVAL_MS = 2500;
const FIRST_RETRY_DELAY_MS = 1250;
const SECOND_RETRY_DELAY_MS = 2500;
const THRESHOLD = 10;
const FAILED_SENDS = 2;
const ONE = 1;
const TWO = 2;
const SENT_WITH_LATER_WORK = 4;
const NONE = 0;
const NO_JITTER = 0;
const PRIVATE_VALUES = ["private-key-value", "private-host-name", "private-event-id", "private payload text"];
const IDLE_HEALTH = {
  acceptedEvents: 0,
  attempts: 0,
  automaticDelivery: true,
  batches: 0,
  coalesced: false,
  consecutiveFailures: 0,
  deliveryState: "idle",
  droppedByReason: { event_too_large: 0, evicted_for_fatal: 0, queue_bytes_overflow: 0, queue_overflow: 0 },
  droppedEvents: 0,
  failures: 0,
  flushes: 0,
  hydratedBytes: 0,
  hydratedEvents: 0,
  inFlight: false,
  lastAcceptedAtUnixMs: 0,
  lastAttemptAtUnixMs: 0,
  lastDropReason: "none",
  lastDroppedAtUnixMs: 0,
  lastOutcome: "idle",
  lastStatusClass: "none",
  lifecycle: "active",
  pausedReason: "none",
  pendingOperations: 0,
  queueBytes: 0,
  queueEvents: 0,
  retryDelayMs: 0,
  scheduled: false,
  schemaVersion: 1,
  storage: "memory"
};

/**
 * @returns {void}
 */
function assertInvalidAutomaticConfigs() {
  assert.throws(() => sampleClient({ automaticDelivery: true }), /automaticDelivery requires transport/u);
  assert.throws(() => sampleClient({ deliveryIntervalMs: 60_001 }), /deliveryIntervalMs must be at most 60000/u);
  assert.throws(() => sampleClient({ deliveryQueueThreshold: 2, maxQueueSize: 1 }), /deliveryQueueThreshold must not exceed maxQueueSize/u);
}

/**
 * @param {LogBrewClient} client
 * @param {readonly Readonly<FakeTimer>[]} timers
 * @returns {void}
 */
function assertScheduledHealth(client, timers) {
  assert.equal(timers.length, ONE);
  assertFields(timers.at(NONE), { delay: INTERVAL_MS, unrefCalls: ONE });
  assert.deepEqual(client.deliveryHealth(), {
    ...IDLE_HEALTH,
    deliveryState: "scheduled",
    queueBytes: client.pendingBytes(),
    queueEvents: 1,
    scheduled: true
  });
}

/**
 * @param {LogBrewClient} client
 * @returns {void}
 */
function assertAcceptedHealth(client) {
  const acceptedHealth = client.deliveryHealth();
  assert.deepEqual(acceptedHealth, {
    ...IDLE_HEALTH,
    acceptedEvents: 1,
    attempts: 1,
    batches: 1,
    deliveryState: "accepted",
    flushes: 1,
    lastAcceptedAtUnixMs: acceptedHealth.lastAcceptedAtUnixMs,
    lastAttemptAtUnixMs: acceptedHealth.lastAttemptAtUnixMs,
    lastOutcome: "accepted",
    lastStatusClass: "success"
  });
  assert.equal(acceptedHealth.lastAttemptAtUnixMs > NONE, true);
  assert.equal(acceptedHealth.lastAcceptedAtUnixMs >= acceptedHealth.lastAttemptAtUnixMs, true);
}

/**
 * @param {LogBrewClient} client
 * @param {GatedTransport} gate
 * @returns {Promise<void>}
 */
async function startFirstCohort(client, gate) {
  client.log("evt_cohort_001", "2026-06-02T10:00:00Z", { level: "info", message: "first" });
  await gate.started.promise;
  client.log("evt_cohort_002", "2026-06-02T10:00:01Z", { level: "info", message: "second" });
  client.log("evt_cohort_003", "2026-06-02T10:00:02Z", { level: "info", message: "third" });
}

/**
 * @param {LogBrewClient} client
 * @param {readonly string[]} bodies
 * @returns {void}
 */
function assertCohortBodies(client, bodies) {
  const [firstBody, secondBody] = bodies;
  assert.deepEqual(eventIds(firstBody), ["evt_cohort_001"]);
  assert.deepEqual(eventIds(secondBody), ["evt_cohort_002", "evt_cohort_003"]);
  assert.equal(client.deliveryHealth().flushes, TWO);
}

/**
 * @returns {{ readonly bodies: readonly string[], readonly transport: LooseTransport }}
 */
function transientTransport() {
  /** @type {string[]} */
  const bodies = [];
  return {
    bodies,
    transport: {
      async send(_apiKey, body) {
        bodies.push(body);
        return { attempts: 1, statusCode: bodies.length <= FAILED_SENDS ? STATUS_UNAVAILABLE : STATUS_ACCEPTED };
      }
    }
  };
}

/**
 * @param {LogBrewClient} client
 * @returns {void}
 */
function assertFirstFailure(client) {
  assert.equal(client.pendingEvents(), ONE);
  assertFields(client.deliveryHealth(), {
    consecutiveFailures: 1,
    deliveryState: "retrying",
    lastOutcome: "failed",
    lastStatusClass: "server_error",
    pausedReason: "none",
    retryDelayMs: FIRST_RETRY_DELAY_MS
  });
  const failureHealth = client.deliveryHealth();
  assertExcludes(JSON.stringify(failureHealth), PRIVATE_VALUES);
  assert.equal(Object.hasOwn(failureHealth, "statusCode"), false);
}

/**
 * @param {LogBrewClient} client
 * @param {readonly Readonly<FakeTimer>[]} timers
 * @param {readonly string[]} bodies
 * @returns {Promise<Readonly<FakeTimer>>}
 */
async function assertBackoffHoldsLaterWork(client, timers, bodies) {
  const retryTimer = activeTimer(timers);
  assert.ok(retryTimer);
  assert.equal(retryTimer.delay, FIRST_RETRY_DELAY_MS);
  client.log("evt_later_work", "2026-06-02T10:00:01Z", { level: "info", message: "captured during backoff" });
  await nextTurn();
  assert.equal(bodies.length, ONE);
  assert.equal(activeTimer(timers), retryTimer);
  return retryTimer;
}

/**
 * @param {LogBrewClient} client
 * @param {readonly Readonly<FakeTimer>[]} timers
 * @param {readonly string[]} bodies
 * @returns {Promise<Readonly<FakeTimer> | undefined>}
 */
async function assertSecondFailure(client, timers, bodies) {
  await waitForCondition(() => client.deliveryHealth().failures === TWO, "second automatic failure was not recorded");
  const [firstBody, secondBody] = bodies;
  assert.equal(firstBody, secondBody);
  assertFields(client.deliveryHealth(), { consecutiveFailures: 2, retryDelayMs: SECOND_RETRY_DELAY_MS });
  const secondRetryTimer = activeTimer(timers);
  assert.equal(secondRetryTimer?.delay, SECOND_RETRY_DELAY_MS);
  return secondRetryTimer;
}

/**
 * @param {LogBrewClient} client
 * @param {readonly string[]} bodies
 * @returns {Promise<void>}
 */
async function assertRetryAccepted(client, bodies) {
  await waitForCondition(() => bodies.length === SENT_WITH_LATER_WORK, "automatic retry and retained later work did not send");
  await waitForCondition(() => client.pendingEvents() === NONE, "automatic retry did not acknowledge");
  const [firstBody, , thirdBody, fourthBody] = bodies;
  assert.equal(firstBody, thirdBody);
  assert.deepEqual(eventIds(fourthBody), ["evt_later_work"]);
  assertFields(client.deliveryHealth(), {
    consecutiveFailures: 0,
    failures: 2,
    flushes: 1,
    lastOutcome: "accepted",
    pausedReason: "none",
    retryDelayMs: 0
  });
}

await test("automatic delivery validates its owner and supports explicit manual opt-out", async () => withFakeTimers(async (timers) => {
  assertInvalidAutomaticConfigs();
  const transport = RecordingTransport.alwaysAccept();
  const client = sampleClient({ automaticDelivery: false, transport });
  client.log("evt_manual_001", "2026-06-02T10:00:00Z", { level: "info", message: "manual mode" });
  await nextTurn();

  assert.equal(timers.length, NONE);
  assert.equal(transport.sentBodies.length, NONE);
  assert.equal(client.deliveryHealth().automaticDelivery, false);
  await client.flush();
  assert.equal(transport.sentBodies.length, ONE);
}));

await test("automatic delivery arms one unref timer and flushes on its interval", async () => withFakeTimers(async (timers) => {
  const transport = RecordingTransport.alwaysAccept();
  const client = sampleClient({ deliveryIntervalMs: INTERVAL_MS, deliveryQueueThreshold: THRESHOLD, transport });
  client.log("evt_interval_001", "2026-06-02T10:00:00Z", { level: "info", message: "interval delivery" });
  assertScheduledHealth(client, timers);

  fire(timers.at(NONE));
  await waitForCondition(() => transport.sentBodies.length === ONE, "interval delivery did not send");
  await waitForCondition(() => client.pendingEvents() === NONE, "interval delivery did not acknowledge");
  assertAcceptedHealth(client);
}));

await test("automatic threshold coalesces capture during I/O into one trailing cohort", async () => withFakeTimers(async () => {
  const gate = gatedFirstSend(STATUS_ACCEPTED);
  const client = sampleClient({ deliveryQueueThreshold: 1, transport: gate.transport });

  await startFirstCohort(client, gate);
  assertFields(client.deliveryHealth(), { coalesced: true, inFlight: true });
  assert.equal(gate.bodies.length, ONE);

  gate.release.resolve();
  await waitForCondition(() => gate.bodies.length === TWO, "coalesced cohort did not send");
  await waitForCondition(() => client.pendingEvents() === NONE, "coalesced cohort did not drain");
  assertCohortBodies(client, gate.bodies);
}));

await test("automatic transient failures back off without changing failed bytes or admitting a bypass", async () => withFakeTimers(async (timers) => withReplacements(Math, { random: () => NO_JITTER }, async () => {
  const { bodies, transport } = transientTransport();
  const client = sampleClient({
    apiKey: "private-key-value",
    deliveryIntervalMs: INTERVAL_MS,
    deliveryQueueThreshold: 1,
    maxRetries: 0,
    sdkName: "private-host-name",
    transport
  });
  client.log("private-event-id", "2026-06-02T10:00:00Z", { level: "error", message: "private payload text" });
  await waitForCondition(() => client.deliveryHealth().failures === ONE, "automatic failure was not recorded");
  assertFirstFailure(client);

  const retryTimer = await assertBackoffHoldsLaterWork(client, timers, bodies);
  retryTimer.callback();
  fire(await assertSecondFailure(client, timers, bodies));
  await assertRetryAccepted(client, bodies);
})));
