import test from "node:test";
import assert from "node:assert/strict";

import { LogBrewClient, RecordingTransport } from "../index.js";

const timestamp = "2026-06-02T10:00:00Z";
const fatal = { title: "App crashed", level: "fatal", exception: { type: "TypeError", mechanism: { type: "global", handled: false } } };

function createClient(options = {}) {
  const drops = [];
  const client = LogBrewClient.create({
    apiKey: "LOGBREW_API_KEY",
    sdkName: "logbrew-js",
    sdkVersion: "0.1.0",
    onEventDropped: (drop) => drops.push(drop),
    ...options
  });
  return { client, drops };
}

const log = (client, id, message = "queued") => client.log(id, timestamp, { message, level: "info" });
const queuedIds = (client) => JSON.parse(client.previewJson()).events.map((event) => event.id);
const eventBytes = (event) => Buffer.byteLength(JSON.stringify(event), "utf8");

function removableStore(records = []) {
  return {
    records,
    load() { return this.records.map((record) => structuredClone(record)); },
    append(record) { this.records.push(structuredClone(record)); },
    acknowledge(count) { this.records.splice(0, count); },
    remove(indexes) { this.records = this.records.filter((_, index) => !indexes.includes(index)); },
    purge() { this.records.splice(0); },
    close() {}
  };
}

test("a fatal issue at the count limit evicts the oldest non-fatal event", () => {
  const { client, drops } = createClient({ maxQueueSize: 3 });
  log(client, "evt_log_001");
  client.issue("evt_fatal_001", timestamp, fatal);
  log(client, "evt_log_002");

  assert.deepEqual(client.issueWithAdmission("evt_fatal_002", timestamp, fatal), { status: "admitted" });

  assert.deepEqual(queuedIds(client), ["evt_fatal_001", "evt_log_002", "evt_fatal_002"]);
  assert.deepEqual(drops, [{ droppedEvents: 1, eventId: "evt_log_001", eventType: "log", reason: "evicted_for_fatal" }]);
  const health = client.deliveryHealth();
  assert.equal(health.droppedByReason.evicted_for_fatal, 1);
  assert.equal(health.lastDropReason, "evicted_for_fatal");
});

test("a drop callback cannot refill the room an eviction made for a fatal issue", () => {
  const { client } = createClient({
    maxQueueSize: 1,
    onEventDropped: (drop) => drop.reason === "evicted_for_fatal" && log(client, "evt_log_reentry")
  });
  log(client, "evt_log_001");
  assert.deepEqual(client.issueWithAdmission("evt_fatal_001", timestamp, fatal), { status: "admitted" });
  assert.deepEqual(queuedIds(client), ["evt_fatal_001"]);
  assert.equal(client.deliveryHealth().droppedByReason.queue_overflow, 1);
});

test("a fatal issue at the byte limit evicts oldest non-fatal events until it fits", () => {
  const { client: probe } = createClient();
  log(probe, "evt_log_001");
  probe.issue("evt_fatal_001", timestamp, fatal);
  const [logEvent, fatalEvent] = JSON.parse(probe.previewJson()).events;
  const { client, drops } = createClient({ maxQueueBytes: eventBytes(logEvent) * 3 });
  for (const id of ["evt_log_001", "evt_log_002", "evt_log_003"]) {
    log(client, id);
  }
  assert.ok(eventBytes(fatalEvent) > eventBytes(logEvent) && eventBytes(fatalEvent) <= eventBytes(logEvent) * 2);

  client.issue("evt_fatal_001", timestamp, fatal);

  assert.deepEqual(queuedIds(client), ["evt_log_003", "evt_fatal_001"]);
  assert.deepEqual(drops.map(({ eventId, reason }) => [eventId, reason]), [
    ["evt_log_001", "evicted_for_fatal"],
    ["evt_log_002", "evicted_for_fatal"]
  ]);
  assert.equal(client.pendingBytes(), eventBytes(logEvent) + eventBytes(fatalEvent));
});

test("a queue of fatal issues rejects the newest fatal without partial eviction", () => {
  const { client, drops } = createClient({ maxQueueSize: 2 });
  client.issue("evt_fatal_001", timestamp, fatal);
  client.issue("evt_fatal_002", timestamp, fatal);
  assert.deepEqual(client.issueWithAdmission("evt_fatal_003", timestamp, fatal), { status: "dropped", reason: "queue_overflow" });

  const { client: probe } = createClient();
  probe.issue("evt_fatal_big", timestamp, { ...fatal, title: "x".repeat(400) });
  log(probe, "evt_log_001");
  const [bigFatal, logEvent] = JSON.parse(probe.previewJson()).events;
  const { client: bytesClient } = createClient({ maxQueueBytes: eventBytes(bigFatal) + eventBytes(logEvent) });
  bytesClient.issue("evt_fatal_big", timestamp, { ...fatal, title: "x".repeat(400) });
  log(bytesClient, "evt_log_001");
  assert.deepEqual(bytesClient.issueWithAdmission("evt_fatal_002", timestamp, { ...fatal, title: "x".repeat(400) }), {
    status: "dropped", reason: "queue_bytes_overflow"
  });

  assert.deepEqual(queuedIds(client), ["evt_fatal_001", "evt_fatal_002"]);
  assert.deepEqual(queuedIds(bytesClient), ["evt_fatal_big", "evt_log_001"]);
  assert.deepEqual(drops.map(({ reason }) => reason), ["queue_overflow"]);
});

test("a non-fatal event at a full queue is still rejected without eviction", () => {
  const { client, drops } = createClient({ maxQueueSize: 1 });
  log(client, "evt_log_001");
  assert.deepEqual(client.issueWithAdmission("evt_error_001", timestamp, { ...fatal, level: "error" }), {
    status: "dropped", reason: "queue_overflow"
  });
  assert.deepEqual(queuedIds(client), ["evt_log_001"]);
  assert.deepEqual(drops.map(({ eventId }) => eventId), ["evt_error_001"]);
});

test("a fatal issue never evicts events in a batch that is being sent or retried", async () => {
  const { client, drops } = createClient({ maxQueueSize: 3, maxBatchEvents: 2, maxRetries: 0 });
  for (const id of ["evt_log_001", "evt_log_002", "evt_log_003"]) {
    log(client, id);
  }
  const sent = [];
  let release;
  const flush = client.flush({
    send(_apiKey, body) {
      sent.push(JSON.parse(body).events.map((event) => event.id));
      return sent.length === 1 ? new Promise((resolve) => { release = resolve; }) : { statusCode: 202 };
    }
  });
  await new Promise((resolve) => setImmediate(resolve));

  client.issue("evt_fatal_001", timestamp, fatal);
  assert.deepEqual(drops.map(({ eventId }) => eventId), ["evt_log_003"]);
  release({ statusCode: 503 });
  await assert.rejects(flush);
  client.issue("evt_fatal_002", timestamp, fatal);

  assert.deepEqual(queuedIds(client), ["evt_log_001", "evt_log_002", "evt_fatal_001"]);
  assert.deepEqual(drops.map(({ eventId, reason }) => [eventId, reason]), [
    ["evt_log_003", "evicted_for_fatal"],
    ["evt_fatal_002", "queue_overflow"]
  ]);
  await client.flush(RecordingTransport.alwaysAccept());
  assert.deepEqual(sent, [["evt_log_001", "evt_log_002"]]);
  assert.equal(client.pendingEvents(), 0);
});

test("eviction removes the durable record so a restart cannot resurrect it", () => {
  const store = removableStore();
  const { client } = createClient({ eventStore: store, maxQueueSize: 3 });
  log(client, "evt_log_001");
  log(client, "evt_log_002");
  const external = { type: "log", id: "evt_native_001", timestamp, attributes: { message: "native", level: "info" } };
  store.records.splice(1, 0, { event: external, eventBytes: eventBytes(external), serializedEvent: JSON.stringify(external) });

  client.issue("evt_fatal_001", timestamp, fatal);

  const expected = ["evt_native_001", "evt_log_002", "evt_fatal_001"];
  assert.deepEqual(queuedIds(client), expected);
  assert.deepEqual(store.records.map(({ event }) => event.id), expected);
  const { client: restarted } = createClient({ eventStore: store, maxQueueSize: 3 });
  assert.deepEqual(queuedIds(restarted), expected);
});

test("a durable store without remove keeps rejecting at a full queue", () => {
  const store = removableStore();
  delete store.remove;
  const { client } = createClient({ eventStore: store, maxQueueSize: 1 });
  log(client, "evt_log_001");
  assert.deepEqual(client.issueWithAdmission("evt_fatal_001", timestamp, fatal), { status: "dropped", reason: "queue_overflow" });
  assert.deepEqual(store.records.map(({ event }) => event.id), ["evt_log_001"]);
});
