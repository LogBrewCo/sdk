import test from "node:test";
import assert from "node:assert/strict";

import { LogBrewClient, RecordingTransport, TransportError } from "../index.js";

const timestamp = "2026-06-02T10:00:00Z";

function createClient(options = {}) {
  return LogBrewClient.create({ apiKey: "LOGBREW_API_KEY", sdkName: "logbrew-js", sdkVersion: "0.1.0", maxRetries: 0, ...options });
}

const log = (client, id, message = "queued") => client.log(id, timestamp, { message, level: "info" });
const reportOf = (body) => JSON.parse(body).client_report;
const reports = (transport) => transport.sentBodies.map((body) => withoutId(reportOf(body)));
const reportIds = (transport) => transport.sentBodies.map((body) => reportOf(body)?.report_id);

function withoutId(report) {
  if (report === undefined) {
    return undefined;
  }
  const { report_id: reportId, ...rest } = report;
  assert.match(reportId, /^[0-9a-f]{32}$/u);
  return rest;
}

test("drop counts ride in the next batch and clear after a 2xx", async () => {
  const client = createClient({ maxQueueSize: 1 });
  log(client, "evt_log_001");
  log(client, "evt_log_002");
  log(client, "evt_log_003");
  client.log("evt_log_big", timestamp, { message: "x".repeat(300 * 1024), level: "info" });
  const transport = RecordingTransport.alwaysAccept();

  await client.flush(transport);
  log(client, "evt_log_004");
  await client.flush(transport);

  assert.deepEqual(reports(transport), [{ dropped_events: { queue_overflow: 2, event_too_large: 1 } }, undefined]);
  assert.equal(client.deliveryHealth().droppedByReason.queue_overflow, 2);
});

test("a batch without drops carries no client report", async () => {
  const client = createClient();
  log(client, "evt_log_001");
  const transport = RecordingTransport.alwaysAccept();
  await client.flush(transport);
  assert.deepEqual(Object.keys(JSON.parse(transport.lastBody())), ["sdk", "events"]);
});

for (const [name, failure] of [["a 5xx", { statusCode: 503 }], ["a network error", TransportError.network("offline")]]) {
  test(`drop counts stay pending after ${name} and the resent body reports them once`, async () => {
    const client = createClient({ maxQueueSize: 1 });
    log(client, "evt_log_001");
    log(client, "evt_log_002");
    const transport = new RecordingTransport([failure, { statusCode: 202 }, { statusCode: 202 }]);

    await assert.rejects(client.flush(transport));
    await client.flush(transport);
    log(client, "evt_log_003");
    await client.flush(transport);

    assert.equal(transport.sentBodies[1], transport.sentBodies[0]);
    assert.deepEqual(reports(transport), [{ dropped_events: { queue_overflow: 1 } }, { dropped_events: { queue_overflow: 1 } }, undefined]);
  });
}

test("drops during an in-flight batch stay pending for the next batch", async () => {
  const client = createClient({ maxQueueSize: 1 });
  log(client, "evt_log_001");
  log(client, "evt_log_002");
  const bodies = [];
  let release;
  const transport = {
    send(_apiKey, body) {
      bodies.push(withoutId(reportOf(body)));
      return bodies.length === 1 ? new Promise((resolve) => { release = resolve; }) : { statusCode: 202 };
    }
  };
  const flush = client.flush(transport);
  await new Promise((resolve) => { setImmediate(resolve); });
  log(client, "evt_log_003");
  log(client, "evt_log_004");
  release({ statusCode: 202 });
  await flush;
  log(client, "evt_log_005");
  await client.flush(transport);

  assert.deepEqual(bodies, [{ dropped_events: { queue_overflow: 1 } }, { dropped_events: { queue_overflow: 2 } }]);
});

test("a report resent in a different batch keeps its report ID", async () => {
  const client = createClient({ maxQueueSize: 1 });
  log(client, "evt_log_001");
  log(client, "evt_log_002");
  const transport = new RecordingTransport([TransportError.network("offline"), { statusCode: 202 }, { statusCode: 202 }]);

  await assert.rejects(client.flush(transport));
  client.purgePendingEvents();
  log(client, "evt_log_003");
  await client.flush(transport);
  log(client, "evt_log_004");
  log(client, "evt_log_005");
  await client.flush(transport);
  log(client, "evt_log_006");
  await client.flush(transport);

  const ids = reportIds(transport);
  assert.notEqual(transport.sentBodies[1], transport.sentBodies[0]);
  assert.equal(ids[1], ids[0]);
  assert.deepEqual(reports(transport), [
    { dropped_events: { queue_overflow: 1 } },
    { dropped_events: { queue_overflow: 1 } },
    { dropped_events: { queue_overflow: 1 } },
    undefined
  ]);
  assert.notEqual(ids[2], ids[0]);
});

test("a client report never pushes a batch over maxBatchBytes", async () => {
  const probe = createClient();
  log(probe, "evt_log_001", "m".repeat(200));
  const exactBytes = Buffer.byteLength(probe.previewJson().replace(/\s/g, ""), "utf8");
  const client = createClient({ maxBatchBytes: exactBytes });
  log(client, "evt_log_001", "m".repeat(200));
  log(client, "evt_log_big", "x".repeat(exactBytes));
  const transport = RecordingTransport.alwaysAccept();

  await client.flush(transport);
  log(client, "evt_log_002", "short");
  await client.flush(transport);

  assert.ok(transport.sentBodies.every((body) => Buffer.byteLength(body, "utf8") <= exactBytes));
  assert.deepEqual(reports(transport), [undefined, { dropped_events: { event_too_large: 1 } }]);
});

test("client reports cap reasons at 16 and clamp counts", async () => {
  const client = createClient({ maxQueueSize: 1 });
  log(client, "evt_log_001");
  client.unreportedDropsByReason.queue_overflow = 1_000_000_000;
  for (let index = 0; index < 20; index += 1) {
    client.unreportedDropsByReason[`reason_${String(index).padStart(2, "0")}`] = 1;
  }
  log(client, "evt_log_002");
  const transport = RecordingTransport.alwaysAccept();

  await client.flush(transport);

  const dropped = reports(transport)[0].dropped_events;
  assert.equal(Object.keys(dropped).length, 16);
  assert.equal(dropped.queue_overflow, 1_000_000_000);
});

function reportStore(saved) {
  const saves = [];
  return {
    saves,
    records: [],
    load() { return this.records; },
    append(record) { this.records.push(record); },
    acknowledge(count) { this.records.splice(0, count); },
    purge() { this.records.splice(0); },
    close() {},
    loadClientReport() { return saved; },
    saveClientReport(state) { saves.push(structuredClone(state)); }
  };
}

test("a store restores a pending report first, then unreported counts under a new ID", async () => {
  const pending = { report_id: "5f0c6a1e9b2d4c7a8e3f1b6d0a9c2e4f", dropped_events: { queue_overflow: 2 } };
  const store = reportStore({ pending, unreported: { event_too_large: 3, Bad: 1, queue_overflow: 0 } });
  const client = createClient({ eventStore: store });
  log(client, "evt_log_001");
  const transport = RecordingTransport.alwaysAccept();

  await client.flush(transport);
  log(client, "evt_log_002");
  await client.shutdown(transport);

  const sent = transport.sentBodies.map(reportOf);
  assert.deepEqual(sent[0], pending);
  assert.deepEqual(withoutId(sent[1]), { dropped_events: { event_too_large: 3 } });
  assert.deepEqual(store.saves.at(-1), { pending: null, unreported: {} });
});

test("drops are saved at once per reason and at most once a second in a burst", () => {
  const store = reportStore(undefined);
  const client = createClient({ eventStore: store, maxQueueSize: 1 });
  for (let index = 0; index < 50; index += 1) {
    log(client, `evt_log_${index}`);
  }
  client.log("evt_log_big", timestamp, { message: "x".repeat(300 * 1024), level: "info" });

  assert.deepEqual(store.saves, [
    { pending: null, unreported: { queue_overflow: 1 } },
    { pending: null, unreported: { queue_overflow: 49, event_too_large: 1 } }
  ]);
});

test("a failing client report store never blocks capture", async () => {
  const store = reportStore(undefined);
  store.loadClientReport = () => { throw new Error("unreadable"); };
  store.saveClientReport = () => { throw new Error("disk full"); };
  const client = createClient({ eventStore: store, maxQueueSize: 1 });
  log(client, "evt_log_001");
  log(client, "evt_log_002");
  const transport = RecordingTransport.alwaysAccept();

  await client.flush(transport);

  assert.deepEqual(withoutId(reportOf(transport.lastBody())), { dropped_events: { queue_overflow: 1 } });
});
