import { bodyEvents, firstPreviewEvent, previewEventIds, sampleClient } from "./batch-helpers.js";
import { RecordingTransport } from "@logbrew/sdk";
import assert from "node:assert/strict";
import test from "node:test";

/**
 * @import { DroppedEvent, LogAttributes } from "@logbrew/sdk"
 * @import { ClientOverrides } from "./batch-helpers.js"
 * @typedef {"maxBatchBytes" | "maxBatchEvents" | "maxQueueBytes"} PositiveBound
 * @typedef {{ readonly dropped: readonly Readonly<DroppedEvent>[], readonly overrides: ClientOverrides }} DropRecorder
 */

const NO_EVENTS = 0;
const ONE = 1;
const TWO = 2;
const NEGATIVE = -1;
const FRACTIONAL = 1.5;
const SDK = { language: "javascript", name: "logbrew-js", version: "0.1.0" };
/** @type {LogAttributes} */
const COFFEE_ATTRIBUTES = { level: "info", message: "coffee ☕" };
const FIRST_EVENT = {
  attributes: COFFEE_ATTRIBUTES,
  id: "evt_utf8_001",
  timestamp: "2026-06-02T10:00:00Z",
  type: "log"
};
const SINGLE_BATCH_BYTES = Buffer.byteLength(JSON.stringify({ events: [FIRST_EVENT], sdk: SDK }), "utf8");
/** @type {readonly (readonly [PositiveBound, number])[]} */
const POSITIVE_BOUND_CASES = [
  ["maxQueueBytes", NO_EVENTS],
  ["maxBatchEvents", FRACTIONAL],
  ["maxBatchBytes", NEGATIVE]
];

/**
 * @returns {DropRecorder}
 */
function dropRecorder() {
  /** @type {Readonly<DroppedEvent>[]} */
  const dropped = [];
  return {
    dropped,
    overrides: {
      onEventDropped(drop) {
        dropped.push(drop);
      }
    }
  };
}

/**
 * @returns {number}
 */
function sameSizeEventBytes() {
  const probe = sampleClient();
  probe.log("evt_bytes_001", "2026-06-02T10:00:00Z", { level: "info", message: "same-size" });
  return Buffer.byteLength(JSON.stringify(firstPreviewEvent(probe)), "utf8");
}

/**
 * @returns {Promise<void>}
 */
async function assertSplitsOnBatchBytes() {
  const client = sampleClient({ maxBatchBytes: SINGLE_BATCH_BYTES, sdkName: SDK.name, sdkVersion: SDK.version });
  client.log(FIRST_EVENT.id, FIRST_EVENT.timestamp, FIRST_EVENT.attributes);
  client.log("evt_utf8_002", "2026-06-02T10:00:01Z", FIRST_EVENT.attributes);
  const transport = RecordingTransport.alwaysAccept();

  const response = await client.flush(transport);

  assert.equal(response.batches, TWO);
  assert.equal(transport.sentBodies.length, TWO);
  for (const body of transport.sentBodies) {
    assert.ok(Buffer.byteLength(body, "utf8") <= SINGLE_BATCH_BYTES);
    assert.equal(bodyEvents(body).length, ONE);
  }
}

/**
 * @returns {void}
 */
function assertOversizedEventDropped() {
  const { dropped, overrides } = dropRecorder();
  const oversizeClient = sampleClient({
    ...overrides,
    maxBatchBytes: SINGLE_BATCH_BYTES,
    sdkName: SDK.name,
    sdkVersion: SDK.version
  });
  oversizeClient.log("evt_oversize", "2026-06-02T10:00:02Z", {
    level: "error",
    message: "x".repeat(SINGLE_BATCH_BYTES)
  });
  assert.equal(oversizeClient.pendingEvents(), NO_EVENTS);
  assert.equal(oversizeClient.pendingBytes(), NO_EVENTS);
  assert.equal(oversizeClient.droppedEvents(), ONE);
  const [drop] = dropped;
  assert.equal(drop?.reason, "event_too_large");
}

await test("queue byte bound preserves earlier events and reports content-free pressure", () => {
  const eventBytes = sameSizeEventBytes();
  const { dropped, overrides } = dropRecorder();
  const client = sampleClient({ ...overrides, maxQueueBytes: eventBytes });

  client.log("evt_bytes_001", "2026-06-02T10:00:00Z", { level: "info", message: "same-size" });
  client.log("evt_bytes_002", "2026-06-02T10:00:01Z", { level: "info", message: "same-size" });

  assert.equal(client.pendingEvents(), ONE);
  assert.equal(client.pendingBytes(), eventBytes);
  assert.equal(client.droppedEvents(), ONE);
  assert.deepEqual(dropped, [{
    droppedEvents: 1,
    eventId: "evt_bytes_002",
    eventType: "log",
    reason: "queue_bytes_overflow"
  }]);
});

await test("flush splits on exact UTF-8 batch bytes and reports an oversized event", async () => {
  await assertSplitsOnBatchBytes();
  assertOversizedEventDropped();
});

await test("bounded queue reports overflow without mutating queued events", () => {
  const { dropped, overrides } = dropRecorder();
  const client = sampleClient({ ...overrides, maxQueueSize: TWO });

  client.log("evt_queue_001", "2026-06-02T10:00:00Z", { level: "info", message: "first" });
  client.log("evt_queue_002", "2026-06-02T10:00:01Z", { level: "warning", message: "second" });
  client.log("evt_queue_003", "2026-06-02T10:00:02Z", { level: "error", message: "third" });

  assert.deepEqual(previewEventIds(client), ["evt_queue_001", "evt_queue_002"]);
  assert.equal(client.pendingEvents(), TWO);
  assert.equal(client.droppedEvents(), ONE);
  assert.deepEqual(dropped, [{
    droppedEvents: 1,
    eventId: "evt_queue_003",
    eventType: "log",
    reason: "queue_overflow"
  }]);
});

await test("invalid queue bound fails client configuration", () => {
  assert.throws(
    () => sampleClient({ maxQueueSize: NO_EVENTS }),
    /maxQueueSize must be a positive integer/u
  );
  for (const [name, value] of POSITIVE_BOUND_CASES) {
    assert.throws(
      () => sampleClient({ [name]: value }),
      new RegExp(`${name} must be a positive integer`, "u")
    );
  }
  for (const maxRetries of [NEGATIVE, FRACTIONAL, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => sampleClient({ maxRetries }),
      /maxRetries must be a non-negative integer/u
    );
  }
});
