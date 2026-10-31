import {
  EVENT_QUEUE_FACTORY,
  callNames,
  recordingEventQueue,
  recordingEventStore,
  storedEvent
} from "./delivery-store-helpers.js";
import { RecordingTransport, SdkError } from "@logbrew/sdk";
import { assertFields, bodyEvents, eventIds, pick, previewEvents, sampleClient } from "./delivery-helpers.js";
import assert from "node:assert/strict";
import test from "node:test";

/**
 * @import { RecordingEventQueue } from "./delivery-store-helpers.js"
 * @import { LogBrewClient } from "@logbrew/sdk"
 */

const NONE = 0;
const ONE = 1;
const APPEND_CALL = 1;
const RECORD_ARGUMENT = 1;
const SCHEMA_VERSION = 1;
const NATIVE_FRAME = { architecture: "arm64", imageUuid: "01234567-89ab-cdef-0123-456789abcdef", instructionOffset: "0000000000001234" };

/**
 * @returns {{ readonly client: LogBrewClient, readonly config: unknown, readonly queue: RecordingEventQueue }}
 */
function factoryClient() {
  const queue = recordingEventQueue([storedEvent("log", "evt_factory_recovered_001")]);
  /** @type {{ config: unknown }} */
  const captured = { config: undefined };
  const client = sampleClient({
    /**
     * @param {unknown} config
     * @returns {RecordingEventQueue}
     */
    [EVENT_QUEUE_FACTORY](config) {
      captured.config = config;
      return queue;
    },
    automaticDelivery: false,
    transport: RecordingTransport.alwaysAccept()
  });
  return { client, config: captured.config, queue };
}

/**
 * @param {LogBrewClient} client
 * @param {unknown} config
 * @param {number | undefined} byteCount
 * @returns {void}
 */
function assertHydratedFromFactory(client, config, byteCount) {
  assert.equal(typeof pick(config, "restoreEvent"), "function");
  assert.equal(client.pendingEvents(), ONE);
  assertFields(client.deliveryHealth(), { hydratedBytes: byteCount, hydratedEvents: 1, storage: "persistent" });
}

/**
 * @param {LogBrewClient} client
 * @returns {Promise<void>}
 */
async function flushPurgeAndShutdown(client) {
  await client.flush();
  client.log("evt_factory_purge_001", "2026-06-02T10:00:00Z", { level: "info", message: "purge" });
  assert.equal(client.purgePendingEvents(), ONE);
  client.log("evt_factory_shutdown_001", "2026-06-02T10:00:00Z", { level: "info", message: "shutdown" });
  await client.shutdown();
}

await test("event store recovers native and legacy-context records", async () => {
  const store = recordingEventStore([
    storedEvent("issue", "evt_native_001", { level: "critical", nativeStackFrames: [NATIVE_FRAME], title: "Native crash" }),
    storedEvent("issue", "evt_legacy_001", {
      context: { resource: { service: { name: "mobile-app" } } },
      level: "fatal",
      nativeStackFrames: [NATIVE_FRAME],
      title: "Legacy crash"
    })
  ]);
  const transport = RecordingTransport.alwaysAccept();
  const client = sampleClient({ automaticDelivery: false, eventStore: store, transport });
  const [native, legacy] = previewEvents(client);

  assert.deepEqual(pick(native, "attributes.nativeStackFrames"), [NATIVE_FRAME]);
  assert.deepEqual([pick(legacy, "attributes.level"), pick(legacy, "attributes.context.schemaVersion")], ["critical", SCHEMA_VERSION]);
  await client.flush();
  const [, flushedLegacy] = bodyEvents(transport.lastBody());
  assert.equal(pick(flushedLegacy, "attributes.context.schemaVersion"), SCHEMA_VERSION);
});

await test("event queue factory composes restart recovery, health, flush, purge, and shutdown", async () => {
  const { client, config, queue } = factoryClient();
  assertHydratedFromFactory(client, config, queue.records.at(NONE)?.byteCount);

  await flushPurgeAndShutdown(client);

  assert.deepEqual(callNames(queue.calls), ["acknowledge", "append", "acknowledge", "append", "acknowledge", "close"]);
  assert.equal(client.deliveryHealth().lifecycle, "closed");
});

await test("eventStore and event queue factory fail closed when both are supplied", () => {
  assert.throws(
    () => sampleClient({
      [EVENT_QUEUE_FACTORY]() {
        return recordingEventQueue();
      },
      eventStore: recordingEventStore()
    }),
    /eventStore and event queue factory are mutually exclusive/u
  );
});

await test("event store persists a validated event before volatile admission", () => {
  const store = recordingEventStore();
  const client = sampleClient({ eventStore: store });

  client.log("evt_persisted_001", "2026-06-02T10:00:00Z", { level: "info", message: "persist first" });

  assert.equal(client.pendingEvents(), ONE);
  assert.equal(store.records.length, ONE);
  assert.deepEqual(callNames(store.calls), ["load", "append"]);
  const appended = store.calls.at(APPEND_CALL)?.at(RECORD_ARGUMENT);
  assert.equal(pick(appended, "serializedEvent"), JSON.stringify(pick(appended, "event")));
});

await test("event store append failure leaves the volatile queue empty", () => {
  const store = recordingEventStore();
  store.append = () => {
    throw new SdkError("persistence_error", "persistent event admission failed");
  };
  const client = sampleClient({ eventStore: store });

  assert.throws(
    () => {
      client.log("evt_persisted_001", "2026-06-02T10:00:00Z", { level: "info", message: "persist first" });
    },
    new SdkError("persistence_error", "persistent event admission failed")
  );
  assert.equal(client.pendingEvents(), NONE);
});

await test("event store acknowledges an accepted prefix before volatile removal", async () => {
  const store = recordingEventStore();
  const client = sampleClient({ eventStore: store, maxBatchEvents: 1 });
  store.records.push(storedEvent("issue", "evt_native_hang_001", { level: "error", title: "Native application hang" }));
  client.log("evt_after_hang_001", "2026-06-02T10:00:01Z", { level: "info", message: "main thread recovered" });
  const transport = RecordingTransport.alwaysAccept();

  await client.flush(transport);

  assert.deepEqual(transport.sentBodies.map((body) => eventIds(body).at(NONE)), ["evt_native_hang_001", "evt_after_hang_001"]);
  assert.deepEqual(callNames(store.calls), ["load", "append", "load", "acknowledge", "acknowledge"]);
  assert.equal(store.records.length, NONE);
  assert.equal(client.pendingEvents(), NONE);
});

await test("event store acknowledgement failure retains the accepted prefix for replay", async () => {
  const store = recordingEventStore([storedEvent("log", "evt_ack_failure_001")]);
  store.acknowledge = () => {
    throw new SdkError("persistence_error", "persistent acknowledgement failed");
  };
  const client = sampleClient({ eventStore: store });

  await assert.rejects(
    client.flush(RecordingTransport.alwaysAccept()),
    new SdkError("persistence_error", "persistent acknowledgement failed")
  );
  assert.equal(client.pendingEvents(), ONE);
  assert.equal(store.records.length, ONE);
});

await test("event store recovery fails closed for malformed or over-limit records", () => {
  const malformedStore = recordingEventStore([storedEvent("log", "evt_malformed_001", {
    context: { resource: {} },
    level: "info",
    message: "persisted",
    unsupported: "drop-me"
  })]);
  assert.throws(() => sampleClient({ eventStore: malformedStore }), /event store returned an invalid record/u);

  const overLimitStore = recordingEventStore([storedEvent("log", "evt_limit_001"), storedEvent("log", "evt_limit_002")]);
  assert.throws(() => sampleClient({ eventStore: overLimitStore, maxQueueSize: 1 }), /recovered event count exceeds maxQueueSize/u);
});
