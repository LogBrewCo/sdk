import { STATUS_ACCEPTED, assertExcludes, assertFields, sampleClient } from "./delivery-helpers.js";
import {
  activeTimer,
  hasActiveTimer,
  waitForCondition,
  withFakeTimers,
  withReplacements
} from "./delivery-timer-helpers.js";
import { RecordingTransport } from "@logbrew/sdk";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";

/**
 * @import { LogBrewClient } from "@logbrew/sdk"
 * @typedef {Readonly<{ errorCode?: string, retryAfterMs?: number, statusCode: number }>} ScriptedResponse
 * @typedef {Readonly<{ expectedDelay: number, random: number, scripted: ScriptedResponse }>} RateLimitCase
 */

const ONE = 1;
const NONE = 0;

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
    retryDelayMs: 0,
    scheduled: false
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

await test("automatic authentication failure pauses retained work without a retry loop", async () => withFakeTimers(async (timers) => {
  const transport = new RecordingTransport([{ statusCode: 401 }]);
  const client = sampleClient({ apiKey: "private-key-value", deliveryQueueThreshold: 1, sdkName: "private-host-name", transport });

  client.log("private-event-id", "2026-06-02T10:00:00Z", { level: "error", message: "private payload text" });
  await waitForCondition(() => client.deliveryHealth().failures === ONE, "authentication failure was not recorded");

  assertPausedForAuthentication(client, transport);
  client.log("private-later-id", "2026-06-02T10:00:01Z", { level: "info", message: "private later text" });
  await nextTurn();
  assert.equal(transport.sentBodies.length, ONE);
  assert.equal(hasActiveTimer(timers), false);
  assertHealthHidesPrivateValues(client);
}));

await test("automatic usage_limit_exceeded pauses until an explicit successful flush, even with Retry-After", async () => withFakeTimers(async (timers) => {
  const transport = new RecordingTransport([
    { errorCode: "usage_limit_exceeded", retryAfterMs: 120_000, statusCode: 429 },
    { statusCode: 202 }
  ]);
  const client = sampleClient({ deliveryQueueThreshold: 1, transport });

  client.log("evt_rate_limit_auto", "2026-06-02T10:00:00Z", { level: "warning", message: "bounded" });
  await waitForFirstFailure(client);

  assertFields(client.deliveryHealth(), { pausedReason: "rate_limit", retryDelayMs: 0, scheduled: false });
  assert.equal(transport.sentBodies.length, ONE);
  assert.equal(hasActiveTimer(timers), false);
  await assertResumedAfterFlush(client, transport);
}));

await test("automatic 429 without Retry-After or a code pauses like before", async () => withFakeTimers(async () => {
  const transport = new RecordingTransport([{ statusCode: 429 }]);
  const client = sampleClient({ deliveryQueueThreshold: 1, transport });

  client.log("evt_plain_429", "2026-06-02T10:00:00Z", { level: "info", message: "bounded" });
  await waitForFirstFailure(client);

  assertFields(client.deliveryHealth(), { pausedReason: "rate_limit", scheduled: false });
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
