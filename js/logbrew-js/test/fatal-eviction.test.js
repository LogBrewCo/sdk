import { createClient as createBaseClient, field, fieldOfEach, memoryEventStore, parseJson, previewEvents, previewIds, removableEventStore } from "./capture-helpers.js";
import { RecordingTransport } from "@logbrew/sdk";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { once } from "node:events";
import test from "node:test";

/**
 * @import { DroppedEvent, Event, IssueAttributes, LogBrewClient, StoredEvent, Transport, TransportResponse } from "@logbrew/sdk"
 * @import { ClientOptions } from "./capture-helpers.js"
 */

/**
 * @typedef {{ readonly client: LogBrewClient, readonly drops: readonly Readonly<DroppedEvent>[] }} ClientWithDrops
 * @typedef {Transport & { readonly release: () => void, readonly sent: (readonly unknown[])[] }} GatedTransport
 */

const TIMESTAMP = "2026-06-02T10:00:00Z";
/** @type {IssueAttributes} */
const FATAL = { exception: { mechanism: { handled: false, type: "global" }, type: "TypeError" }, level: "fatal", title: "App crashed" };
const ACCEPTED = 202;
const UNAVAILABLE = 503;
const FIRST_SEND = 1;
const NO_EVENTS = 0;
const ONE_DROP = 1;
const ONE_SLOT = 1;
const TWO_SLOTS = 2;
const THREE_SLOTS = 3;
const FATAL_MAX_LOG_MULTIPLE = 2;
const BIG_TITLE_LENGTH = 400;
const SECOND_POSITION = 1;
const INSERT_ONLY = 0;

/**
 * @param {ClientOptions} options
 * @returns {ClientWithDrops}
 */
function createClient(options = {}) {
  /** @type {Readonly<DroppedEvent>[]} */
  const drops = [];
  const client = createBaseClient({
    onEventDropped: (drop) => {
      drops.push(drop);
    },
    ...options
  });
  return { client, drops };
}

/**
 * @param {LogBrewClient} client
 * @param {string} id
 * @returns {void}
 */
function log(client, id) {
  client.log(id, TIMESTAMP, { level: "info", message: "queued" });
}

/**
 * @param {LogBrewClient} client
 * @param {readonly string[]} ids
 * @returns {void}
 */
function logEach(client, ids) {
  for (const id of ids) {
    log(client, id);
  }
}

/**
 * @param {unknown} event
 * @returns {number}
 */
function eventBytes(event) {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}

/**
 * @returns {IssueAttributes}
 */
function bigFatal() {
  return { ...FATAL, title: "x".repeat(BIG_TITLE_LENGTH) };
}

/**
 * @returns {readonly unknown[]}
 */
function probeLogThenFatal() {
  const { client: probe } = createClient();
  log(probe, "evt_log_001");
  probe.issue("evt_fatal_001", TIMESTAMP, FATAL);
  return previewEvents(probe);
}

/**
 * @returns {LogBrewClient}
 */
function clientFullOfBigFatal() {
  const { client: probe } = createClient();
  probe.issue("evt_fatal_big", TIMESTAMP, bigFatal());
  log(probe, "evt_log_001");
  const [bigEvent, logEvent] = previewEvents(probe);
  const { client } = createClient({ maxQueueBytes: eventBytes(bigEvent) + eventBytes(logEvent) });
  client.issue("evt_fatal_big", TIMESTAMP, bigFatal());
  log(client, "evt_log_001");
  return client;
}

/**
 * @returns {GatedTransport}
 */
function gatedTransport() {
  /** @type {(readonly unknown[])[]} */
  const sent = [];
  const gate = new EventTarget();
  return {
    release() {
      gate.dispatchEvent(new Event("release"));
    },
    /**
     * @param {string} _apiKey
     * @param {string} body
     * @returns {Promise<TransportResponse>}
     */
    async send(_apiKey, body) {
      const payload = parseJson(body);
      sent.push(fieldOfEach(field(payload, "events"), "id"));
      if (sent.length === FIRST_SEND) {
        await once(gate, "release");
        return { attempts: 1, statusCode: UNAVAILABLE };
      }
      return { attempts: 1, statusCode: ACCEPTED };
    },
    sent
  };
}

/**
 * @param {LogBrewClient} client
 * @returns {Promise<{ readonly flush: Promise<TransportResponse>, readonly transport: GatedTransport }>}
 */
async function holdFirstBatch(client) {
  logEach(client, ["evt_log_001", "evt_log_002", "evt_log_003"]);
  const transport = gatedTransport();
  const flush = client.flush(transport);
  await nextTurn();
  return { flush, transport };
}

/**
 * @param {LogBrewClient} client
 * @param {readonly (readonly unknown[])[]} sent
 * @returns {Promise<void>}
 */
async function assertOnlyHeldBatchSent(client, sent) {
  await client.flush(RecordingTransport.alwaysAccept());
  assert.deepEqual(sent, [["evt_log_001", "evt_log_002"]]);
  assert.equal(client.pendingEvents(), NO_EVENTS);
}

/**
 * @param {unknown} records
 * @returns {readonly unknown[]}
 */
function storedIds(records) {
  return fieldOfEach(fieldOfEach(records, "event"), "id");
}

/**
 * @returns {StoredEvent}
 */
function nativeRecord() {
  /** @type {Event} */
  const external = {
    type: "log",

    id: "evt_native_001",
    timestamp: TIMESTAMP,

    attributes: {
      message: "native",

      level: "info"
    }
  };
  return { event: external, eventBytes: eventBytes(external), serializedEvent: JSON.stringify(external) };
}

await test("a fatal issue at the count limit evicts the oldest non-fatal event", () => {
  const { client, drops } = createClient({ maxQueueSize: THREE_SLOTS });
  log(client, "evt_log_001");
  client.issue("evt_fatal_001", TIMESTAMP, FATAL);
  log(client, "evt_log_002");

  assert.deepEqual(client.issueWithAdmission("evt_fatal_002", TIMESTAMP, FATAL), { status: "admitted" });

  assert.deepEqual(previewIds(client), ["evt_fatal_001", "evt_log_002", "evt_fatal_002"]);
  assert.deepEqual(drops, [{ droppedEvents: 1, eventId: "evt_log_001", eventType: "log", reason: "evicted_for_fatal" }]);
  const health = client.deliveryHealth();
  assert.equal(health.droppedByReason.evicted_for_fatal, ONE_DROP);
  assert.equal(health.lastDropReason, "evicted_for_fatal");
});

await test("a drop callback cannot refill the room an eviction made for a fatal issue", () => {
  const { client } = createClient({
    maxQueueSize: ONE_SLOT,
    onEventDropped: (drop) => {
      if (drop.reason === "evicted_for_fatal") {
        log(client, "evt_log_reentry");
      }
    }
  });
  log(client, "evt_log_001");
  assert.deepEqual(client.issueWithAdmission("evt_fatal_001", TIMESTAMP, FATAL), { status: "admitted" });
  assert.deepEqual(previewIds(client), ["evt_fatal_001"]);
  assert.equal(client.deliveryHealth().droppedByReason.queue_overflow, ONE_DROP);
});

await test("a fatal issue at the byte limit evicts oldest non-fatal events until it fits", () => {
  const [logEvent, fatalEvent] = probeLogThenFatal();
  const { client, drops } = createClient({ maxQueueBytes: eventBytes(logEvent) * THREE_SLOTS });
  logEach(client, ["evt_log_001", "evt_log_002", "evt_log_003"]);
  assert.ok(eventBytes(fatalEvent) > eventBytes(logEvent) && eventBytes(fatalEvent) <= eventBytes(logEvent) * FATAL_MAX_LOG_MULTIPLE);

  client.issue("evt_fatal_001", TIMESTAMP, FATAL);

  assert.deepEqual(previewIds(client), ["evt_log_003", "evt_fatal_001"]);
  assert.deepEqual(drops.map(({ eventId, reason }) => [eventId, reason]), [
    ["evt_log_001", "evicted_for_fatal"],
    ["evt_log_002", "evicted_for_fatal"]
  ]);
  assert.equal(client.pendingBytes(), eventBytes(logEvent) + eventBytes(fatalEvent));
});

await test("a queue of fatal issues rejects the newest fatal without partial eviction", () => {
  const { client, drops } = createClient({ maxQueueSize: TWO_SLOTS });
  client.issue("evt_fatal_001", TIMESTAMP, FATAL);
  client.issue("evt_fatal_002", TIMESTAMP, FATAL);
  assert.deepEqual(client.issueWithAdmission("evt_fatal_003", TIMESTAMP, FATAL), { reason: "queue_overflow", status: "dropped" });

  const bytesClient = clientFullOfBigFatal();
  assert.deepEqual(bytesClient.issueWithAdmission("evt_fatal_002", TIMESTAMP, bigFatal()), {
    reason: "queue_bytes_overflow", status: "dropped"
  });

  assert.deepEqual(previewIds(client), ["evt_fatal_001", "evt_fatal_002"]);
  assert.deepEqual(previewIds(bytesClient), ["evt_fatal_big", "evt_log_001"]);
  assert.deepEqual(drops.map(({ reason }) => reason), ["queue_overflow"]);
});

await test("a non-fatal event at a full queue is still rejected without eviction", () => {
  const { client, drops } = createClient({ maxQueueSize: ONE_SLOT });
  log(client, "evt_log_001");
  assert.deepEqual(client.issueWithAdmission("evt_error_001", TIMESTAMP, { ...FATAL, level: "error" }), {
    reason: "queue_overflow", status: "dropped"
  });
  assert.deepEqual(previewIds(client), ["evt_log_001"]);
  assert.deepEqual(drops.map(({ eventId }) => eventId), ["evt_error_001"]);
});

await test("a fatal issue never evicts events in a batch that is being sent or retried", async () => {
  const { client, drops } = createClient({ maxBatchEvents: TWO_SLOTS, maxQueueSize: THREE_SLOTS, maxRetries: 0 });
  const { flush, transport } = await holdFirstBatch(client);

  client.issue("evt_fatal_001", TIMESTAMP, FATAL);
  assert.deepEqual(drops.map(({ eventId }) => eventId), ["evt_log_003"]);
  transport.release();
  await assert.rejects(flush);
  client.issue("evt_fatal_002", TIMESTAMP, FATAL);

  assert.deepEqual(previewIds(client), ["evt_log_001", "evt_log_002", "evt_fatal_001"]);
  assert.deepEqual(drops.map(({ eventId, reason }) => [eventId, reason]), [
    ["evt_log_003", "evicted_for_fatal"],
    ["evt_fatal_002", "queue_overflow"]
  ]);
  await assertOnlyHeldBatchSent(client, transport.sent);
});

await test("eviction removes the durable record so a restart cannot resurrect it", () => {
  const store = removableEventStore();
  const { client } = createClient({ eventStore: store, maxQueueSize: THREE_SLOTS });
  logEach(client, ["evt_log_001", "evt_log_002"]);
  store.records.splice(SECOND_POSITION, INSERT_ONLY, nativeRecord());

  client.issue("evt_fatal_001", TIMESTAMP, FATAL);

  const expected = ["evt_native_001", "evt_log_002", "evt_fatal_001"];
  assert.deepEqual(previewIds(client), expected);
  assert.deepEqual(storedIds(store.records), expected);
  const { client: restarted } = createClient({ eventStore: store, maxQueueSize: THREE_SLOTS });
  assert.deepEqual(previewIds(restarted), expected);
});

await test("a durable store without remove keeps rejecting at a full queue", () => {
  const store = memoryEventStore();
  const { client } = createClient({ eventStore: store, maxQueueSize: ONE_SLOT });
  log(client, "evt_log_001");
  assert.deepEqual(client.issueWithAdmission("evt_fatal_001", TIMESTAMP, FATAL), { reason: "queue_overflow", status: "dropped" });
  assert.deepEqual(storedIds(store.records), ["evt_log_001"]);
});
