import { bodyEventIds, deliverUnchecked, field, heldTransport, previewEventIds, sampleClient } from "./batch-helpers.js";
import { RecordingTransport } from "@logbrew/sdk";
import assert from "node:assert/strict";
import test from "node:test";

/**
 * @import { LogBrewClient, TransportResponse } from "@logbrew/sdk"
 * @import { HeldTransport } from "./batch-helpers.js"
 */

const ACCEPTED = 202;
const SERVICE_UNAVAILABLE = 503;
const SERVER_ERROR = 500;
const NO_EVENTS = 0;
const ONE = 1;
const TWO = 2;
const THREE = 3;
const FOUR = 4;
const NO_RETRIES = 0;
const PARTIAL_EVENT_COUNT = 5;
const REPEATED_IDS = ["evt_batch_0", "evt_batch_1", "evt_batch_0", "evt_batch_2", "evt_batch_3", "evt_batch_4", "evt_batch_5"];
const PARTIAL_IDS = Array.from({ length: PARTIAL_EVENT_COUNT }, (_entry, index) => `evt_partial_${index}`);

/**
 * @param {LogBrewClient} client
 * @param {readonly string[]} ids
 * @returns {void}
 */
function queueLogs(client, ids) {
  for (const [index, id] of ids.entries()) {
    client.log(id, `2026-06-02T10:00:0${index}Z`, { level: "info", message: "queued" });
  }
}

/**
 * @param {LogBrewClient} client
 * @param {HeldTransport} held
 * @param {unknown} firstResponse
 * @returns {void}
 */
function assertSnapshotAcknowledged(client, held, firstResponse) {
  const [firstBody] = held.sentBodies;
  assert.equal(field(firstResponse, "batches"), ONE);
  assert.deepEqual(bodyEventIds(firstBody), ["evt_before_flush"]);
  assert.equal(client.pendingEvents(), ONE);
  assert.deepEqual(previewEventIds(client), ["evt_during_flush"]);
}

/**
 * @param {LogBrewClient} client
 * @returns {Promise<void>}
 */
async function assertRetryDeliversDuringFlushEvent(client) {
  const retryTransport = RecordingTransport.alwaysAccept();
  await client.flush(retryTransport);
  assert.deepEqual(bodyEventIds(retryTransport.lastBody()), ["evt_during_flush"]);
  assert.equal(client.pendingEvents(), NO_EVENTS);
}

/**
 * @param {LogBrewClient} client
 * @param {HeldTransport} held
 * @returns {Promise<readonly Promise<unknown>[]>}
 */
async function flushTwiceWhileHeld(client, held) {
  const firstFlush = deliverUnchecked(client, "flush", held.transport);
  await held.started;
  const secondFlush = deliverUnchecked(client, "flush", held.transport);
  await Promise.resolve();
  assert.equal(held.sentBodies.length, ONE);
  return [firstFlush, secondFlush];
}

/**
 * @param {LogBrewClient} client
 * @param {readonly string[]} sentBodies
 * @returns {void}
 */
function assertSerializedFlushes(client, sentBodies) {
  const [firstBody, secondBody] = sentBodies;
  assert.equal(sentBodies.length, TWO);
  assert.deepEqual(bodyEventIds(firstBody), ["evt_first_flush"]);
  assert.deepEqual(bodyEventIds(secondBody), ["evt_second_flush"]);
  assert.equal(client.pendingEvents(), NO_EVENTS);
}

/**
 * @param {Readonly<TransportResponse>} response
 * @returns {void}
 */
function assertSplitResponse(response) {
  assert.equal(response.statusCode, ACCEPTED);
  assert.equal(response.attempts, FOUR);
  assert.equal(response.batches, THREE);
}

await test("flush acknowledges only its snapshot and keeps events captured during transport I/O", async () => {
  const client = sampleClient();
  const held = heldTransport();
  client.log("evt_before_flush", "2026-06-02T10:00:00Z", { level: "info", message: "before" });

  const flushPromise = deliverUnchecked(client, "flush", held.transport);
  await held.started;
  client.log("evt_during_flush", "2026-06-02T10:00:01Z", { level: "warning", message: "during" });
  held.release({ statusCode: ACCEPTED });

  assertSnapshotAcknowledged(client, held, await flushPromise);
  await assertRetryDeliversDuringFlushEvent(client);
});

await test("concurrent flush calls serialize without duplicating a queue prefix", async () => {
  const client = sampleClient();
  const held = heldTransport();
  client.log("evt_first_flush", "2026-06-02T10:00:00Z", { level: "info", message: "first" });

  const flushes = await flushTwiceWhileHeld(client, held);
  client.log("evt_second_flush", "2026-06-02T10:00:01Z", { level: "info", message: "second" });
  held.release({ statusCode: ACCEPTED });
  await Promise.all(flushes);

  assertSerializedFlushes(client, held.sentBodies);
});

await test("flush splits repeated ids and event counts while retrying a stable batch body", async () => {
  const client = sampleClient({
    maxBatchEvents: THREE,
    maxRetries: ONE
  });
  queueLogs(client, REPEATED_IDS);
  const transport = new RecordingTransport([
    { statusCode: SERVICE_UNAVAILABLE },
    { statusCode: ACCEPTED },
    { statusCode: ACCEPTED },
    { statusCode: ACCEPTED }
  ]);

  const response = await client.flush(transport);

  assertSplitResponse(response);
  assert.equal(transport.sentBodies.length, FOUR);
  const [firstBody, retriedBody] = transport.sentBodies;
  assert.equal(firstBody, retriedBody);
  assert.deepEqual(
    transport.sentBodies.map((body) => bodyEventIds(body)),
    [
      ["evt_batch_0", "evt_batch_1"],
      ["evt_batch_0", "evt_batch_1"],
      ["evt_batch_0", "evt_batch_2", "evt_batch_3"],
      ["evt_batch_4", "evt_batch_5"]
    ]
  );
  assert.equal(client.pendingEvents(), NO_EVENTS);
});

await test("partial batch success removes only acknowledged events", async () => {
  const client = sampleClient({
    maxBatchEvents: TWO,
    maxRetries: NO_RETRIES
  });
  queueLogs(client, PARTIAL_IDS);
  const firstTransport = new RecordingTransport([{ statusCode: ACCEPTED }, { statusCode: SERVER_ERROR }]);

  await assert.rejects(client.flush(firstTransport), /unexpected transport status 500/u);
  assert.deepEqual(previewEventIds(client), ["evt_partial_2", "evt_partial_3", "evt_partial_4"]);

  const retryTransport = RecordingTransport.alwaysAccept();
  const response = await client.flush(retryTransport);
  assert.equal(response.batches, TWO);
  assert.deepEqual(
    retryTransport.sentBodies.map((body) => bodyEventIds(body)),
    [["evt_partial_2", "evt_partial_3"], ["evt_partial_4"]]
  );
  assert.equal(client.pendingEvents(), NO_EVENTS);
});
