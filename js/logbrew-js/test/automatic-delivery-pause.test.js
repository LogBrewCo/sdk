import { STATUS_ACCEPTED, STATUS_UNAVAILABLE, assertExcludes, assertFields, sampleClient } from "./delivery-helpers.js";
import {
  activeTimer,
  fire,
  hasActiveTimer,
  waitForCondition,
  withFakeTimers,
  withReplacements
} from "./delivery-timer-helpers.js";
import { RecordingTransport } from "@logbrew/sdk";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setImmediate as nextTurn } from "node:timers/promises";
import { recordingEventStore } from "./delivery-store-helpers.js";
import test from "node:test";

/**
 * @import { LogBrewClient } from "@logbrew/sdk"
 * @import { FakeTimer } from "./delivery-timer-helpers.js"
 * @typedef {Readonly<{ errorCode?: string, retryAfterMs?: number, statusCode: number }>} ScriptedResponse
 * @typedef {Readonly<{ expectedDelay: number, random: number, scripted: ScriptedResponse }>} RateLimitCase
 */

const ONE = 1;
const TWO = 2;
const NONE = 0;
const STATUS_FORBIDDEN = 403;

/**
 * @param {unknown} value
 * @returns {value is typeof import("../retry-delay.cjs")}
 */
function isRetryDelayModule(value) {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "pauseProbeDelayMs") === "function";
}

/** @type {unknown} */
const retryDelayModule = createRequire(import.meta.url)("../retry-delay.cjs");
assert.ok(isRetryDelayModule(retryDelayModule));
const { pauseProbeDelayMs } = retryDelayModule;
const OUTAGE_ATTEMPTS = 3;
const FIRST_PROBE_DELAY_MS = 30_000;
const SECOND_PROBE_DELAY_MS = 60_000;

/**
 * @param {LogBrewClient} client
 * @returns {Promise<void>}
 */
async function waitForFirstFailure(client) {
  await waitForCondition(() => client.deliveryHealth().failures === ONE, "rate limit was not recorded");
}

/**
 * @param {LogBrewClient} client
 * @param {RecordingTransport} transport
 * @returns {void}
 */
function assertPausedForAuthentication(client, transport) {
  assert.equal(transport.sentBodies.length, ONE);
  assert.equal(client.pendingEvents(), ONE);
  assertFields(client.deliveryHealth(), {
    consecutiveFailures: 1,
    deliveryState: "paused",
    lastStatusClass: "client_error",
    pausedReason: "authentication",
    retryDelayMs: FIRST_PROBE_DELAY_MS,
    scheduled: true
  });
}

/**
 * @param {LogBrewClient} client
 * @returns {void}
 */
function assertHealthHidesPrivateValues(client) {
  const authenticationHealth = client.deliveryHealth();
  assertExcludes(JSON.stringify(authenticationHealth), ["private-key-value", "private-host-name", "private-event-id", "private payload text"]);
  assert.equal(Object.hasOwn(authenticationHealth, "statusCode"), false);
}

/**
 * @param {LogBrewClient} client
 * @param {RecordingTransport} transport
 * @returns {Promise<void>}
 */
async function assertResumedAfterFlush(client, transport) {
  const response = await client.flush();
  assert.equal(response.statusCode, STATUS_ACCEPTED);
  const [firstBody, secondBody] = transport.sentBodies;
  assert.equal(firstBody, secondBody);
  assert.equal(client.pendingEvents(), NONE);
  assertFields(client.deliveryHealth(), { consecutiveFailures: 0, pausedReason: "none", retryDelayMs: 0 });
}

/**
 * @param {LogBrewClient} client
 * @param {RecordingTransport} transport
 * @returns {Promise<void>}
 */
async function assertHeldDuringWait(client, transport) {
  client.log("evt_during_wait", "2026-06-02T10:00:01Z", { level: "info", message: "queued" });
  await nextTurn();
  assert.equal(transport.sentBodies.length, ONE);
}

/**
 * @param {LogBrewClient} client
 * @param {RecordingTransport} transport
 * @returns {Promise<void>}
 */
async function assertResentSameBatch(client, transport) {
  await waitForCondition(() => client.pendingEvents() === NONE, "rate-limited batch did not resend");
  const [firstBody, secondBody] = transport.sentBodies;
  assert.equal(firstBody, secondBody);
  assert.equal(client.deliveryHealth().consecutiveFailures, NONE);
}

/**
 * @param {RateLimitCase} rateLimit
 * @returns {Promise<void>}
 */
async function rateLimitTest({ expectedDelay, random, scripted }) {
  await test(`automatic 429 ${JSON.stringify(scripted)} waits ${expectedDelay} ms, then resends the same batch`, async () => withFakeTimers(async (timers) => withReplacements(Math, { random: () => random }, async () => {
    const transport = new RecordingTransport([scripted, { statusCode: STATUS_ACCEPTED }]);
    const client = sampleClient({ deliveryQueueThreshold: 1, transport });

    client.log("evt_rate_limited", "2026-06-02T10:00:00Z", { level: "info", message: "bounded" });
    await waitForFirstFailure(client);

    assertFields(client.deliveryHealth(), { deliveryState: "retrying", pausedReason: "none", retryDelayMs: expectedDelay });
    const retryTimer = activeTimer(timers);
    assert.equal(retryTimer?.delay, expectedDelay);
    await assertHeldDuringWait(client, transport);

    retryTimer.callback();
    await assertResentSameBatch(client, transport);
  })));
}

await test("automatic authentication failure pauses retained work and schedules one probe", async () => withFakeTimers(async (timers) => withReplacements(Math, { random: () => NONE }, async () => {
  const transport = new RecordingTransport([{ statusCode: 401 }]);
  const client = sampleClient({ apiKey: "private-key-value", deliveryQueueThreshold: 1, sdkName: "private-host-name", transport });

  client.log("private-event-id", "2026-06-02T10:00:00Z", { level: "error", message: "private payload text" });
  await waitForCondition(() => client.deliveryHealth().failures === ONE, "authentication failure was not recorded");

  assertPausedForAuthentication(client, transport);
  client.log("private-later-id", "2026-06-02T10:00:01Z", { level: "info", message: "private later text" });
  await nextTurn();
  assert.equal(transport.sentBodies.length, ONE);
  assert.deepEqual(timers.map((timer) => timer.delay), [FIRST_PROBE_DELAY_MS]);
  assertHealthHidesPrivateValues(client);
})));

await test("automatic usage_limit_exceeded probes on its own schedule, not Retry-After, and an explicit flush cancels the probe", async () => withFakeTimers(async (timers) => withReplacements(Math, { random: () => NONE }, async () => {
  const transport = new RecordingTransport([
    { errorCode: "usage_limit_exceeded", retryAfterMs: 120_000, statusCode: 429 },
    { statusCode: 202 }
  ]);
  const client = sampleClient({ deliveryQueueThreshold: 1, transport });

  client.log("evt_rate_limit_auto", "2026-06-02T10:00:00Z", { level: "warning", message: "bounded" });
  await waitForFirstFailure(client);

  assertFields(client.deliveryHealth(), { pausedReason: "rate_limit", retryDelayMs: FIRST_PROBE_DELAY_MS, scheduled: true });
  assert.equal(transport.sentBodies.length, ONE);
  assert.equal(activeTimer(timers)?.delay, FIRST_PROBE_DELAY_MS);
  await assertResumedAfterFlush(client, transport);
  assert.equal(hasActiveTimer(timers), false);
})));

await test("automatic 429 without Retry-After or a code pauses and schedules a probe", async () => withFakeTimers(async () => {
  const transport = new RecordingTransport([{ statusCode: 429 }]);
  const client = sampleClient({ deliveryQueueThreshold: 1, transport });

  client.log("evt_plain_429", "2026-06-02T10:00:00Z", { level: "info", message: "bounded" });
  await waitForFirstFailure(client);

  assertFields(client.deliveryHealth(), { pausedReason: "rate_limit", scheduled: true });
}));

await rateLimitTest({
  expectedDelay: 30_000,
  random: 0,
  scripted: {
    statusCode: 429,

    retryAfterMs: 30_000
  }
});
await rateLimitTest({
  expectedDelay: 33_000,
  random: 0.999999,
  scripted: {
    statusCode: 429,

    retryAfterMs: 30_000
  }
});
await rateLimitTest({
  expectedDelay: 1000,
  random: 0,
  scripted: {
    statusCode: 429,

    retryAfterMs: 0
  }
});
await rateLimitTest({
  expectedDelay: 3_600_000,
  random: 0.999999,
  scripted: {
    statusCode: 429,

    retryAfterMs: 86_400_000
  }
});
await rateLimitTest({
  expectedDelay: 1000,
  random: 0,
  scripted: {
    statusCode: 429,

    errorCode: "rate_limited"
  }
});

/**
 * @param {LogBrewClient} client
 * @param {readonly Readonly<FakeTimer>[]} timers
 * @param {number} delayMs
 * @returns {void}
 */
function assertProbeScheduled(client, timers, delayMs) {
  assertFields(client.deliveryHealth(), { deliveryState: "paused", pausedReason: "non_retryable", retryDelayMs: delayMs, scheduled: true });
  assert.equal(activeTimer(timers)?.delay, delayMs);
}

/**
 * @param {readonly Readonly<FakeTimer>[]} timers
 * @param {() => boolean} predicate
 * @param {string} message
 * @returns {Promise<void>}
 */
async function fireProbe(timers, predicate, message) {
  fire(activeTimer(timers));
  await waitForCondition(predicate, message);
}

/**
 * @param {LogBrewClient} client
 * @param {RecordingTransport} transport
 * @returns {void}
 */
function assertResumedWithSameBatch(client, transport) {
  const [firstBody, firstProbe, secondProbe] = transport.sentBodies;
  assert.equal(firstProbe, firstBody);
  assert.equal(secondProbe, firstBody);
  assertFields(client.deliveryHealth(), { consecutiveFailures: 0, deliveryState: "accepted", pausedReason: "none", retryDelayMs: 0 });
}

await test("an automatic 403 pause probes the same batch on its own and resumes", async () => withFakeTimers(async (timers) => withReplacements(Math, { random: () => NONE }, async () => {
  const transport = new RecordingTransport([{ statusCode: STATUS_FORBIDDEN }, { statusCode: STATUS_FORBIDDEN }]);
  const client = sampleClient({ deliveryQueueThreshold: 1, transport });

  client.log("evt_forbidden", "2026-06-02T10:00:00Z", { level: "info", message: "bounded" });
  await waitForFirstFailure(client);
  assertProbeScheduled(client, timers, FIRST_PROBE_DELAY_MS);
  await assertHeldDuringWait(client, transport);

  await fireProbe(timers, () => client.deliveryHealth().failures === TWO, "first probe was not sent");
  assertProbeScheduled(client, timers, SECOND_PROBE_DELAY_MS);

  await fireProbe(timers, () => client.pendingEvents() === NONE, "second probe did not drain the queue");
  assertResumedWithSameBatch(client, transport);
})));

await test("an automatic 503 outage that uses up the retries sends again on its own and drains the queue", async () => withFakeTimers(async (timers) => {
  const unavailable = { statusCode: STATUS_UNAVAILABLE };
  const transport = new RecordingTransport([unavailable, unavailable, unavailable]);
  const client = sampleClient({ deliveryQueueThreshold: 1, maxRetries: 2, transport });

  client.log("evt_outage", "2026-06-02T10:00:00Z", { level: "info", message: "bounded" });
  await waitForFirstFailure(client);
  assert.equal(transport.sentBodies.length, OUTAGE_ATTEMPTS);
  assertFields(client.deliveryHealth(), { deliveryState: "retrying", pausedReason: "none" });

  fire(activeTimer(timers));
  await waitForCondition(() => client.pendingEvents() === NONE, "outage batch did not resend");
  assert.equal(transport.sentBodies.length, OUTAGE_ATTEMPTS + ONE);
}));

await test("a failed event store acknowledgement pauses until explicit recovery, without a probe", async () => withFakeTimers(async (timers) => {
  const transport = new RecordingTransport();
  const eventStore = Object.assign(recordingEventStore(), {
    acknowledge() {
      throw new Error("store unavailable");
    }
  });
  const client = sampleClient({ deliveryQueueThreshold: 1, eventStore, transport });

  client.log("evt_store", "2026-06-02T10:00:00Z", { level: "info", message: "bounded" });
  await waitForFirstFailure(client);
  assertFields(client.deliveryHealth(), { deliveryState: "paused", pausedReason: "non_retryable", retryDelayMs: 0, scheduled: false });
  assert.equal(hasActiveTimer(timers), false);
  assert.equal(transport.sentBodies.length, ONE);
}));

/**
 * @param {Readonly<{ expectedMs: number, failures: number, jitter: number, maxRetryDelayMs: number }>} probe
 * @returns {void}
 */
function assertProbeDelay({ expectedMs, failures, jitter, maxRetryDelayMs }) {
  assert.equal(pauseProbeDelayMs(maxRetryDelayMs, failures, jitter), expectedMs);
}

await test("pause probes back off from 60 seconds to 5 minutes", () => {
  assertProbeDelay({ expectedMs: 60_000, failures: 1, jitter: 1, maxRetryDelayMs: 60_000 });
  assertProbeDelay({ expectedMs: 30_000, failures: 1, jitter: 0, maxRetryDelayMs: 60_000 });
  assertProbeDelay({ expectedMs: 240_000, failures: 3, jitter: 1, maxRetryDelayMs: 60_000 });
  assertProbeDelay({ expectedMs: 300_000, failures: 9, jitter: 1, maxRetryDelayMs: 60_000 });
  assertProbeDelay({ expectedMs: 300_000, failures: Number.MAX_SAFE_INTEGER, jitter: 1, maxRetryDelayMs: 60_000 });
  assertProbeDelay({ expectedMs: 600_000, failures: 4, jitter: 1, maxRetryDelayMs: 600_000 });
});
