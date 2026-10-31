import {
  ONE,
  TWO,
  createClient,
  lastReport,
  log,
  logAll,
  logOversized,
  overflow,
  reportOf,
  reportStore,
  reports,
  withoutId
} from "./client-report-helpers.js";
import { field, isRecord } from "./capture-helpers.js";
import { RecordingTransport } from "@logbrew/sdk";
import assert from "node:assert/strict";
import test from "node:test";

/**
 * @import { LogBrewClient } from "@logbrew/sdk"
 */

const FIRST = 0;
const SECOND = 1;
const LAST = -1;
const THREE = 3;
const CLAMPED_COUNT = 1_000_000_000;
const EXTRA_REASONS = 15;
const MAX_REASONS = 16;
const REASON_DIGITS = 2;
const BURST_SIZE = 50;
const BURST_OVERFLOW = 49;
const CLIENT_REPORT_STORE = Symbol.for("@logbrew/sdk.clientReportStore");

/**
 * @returns {Record<string, number>}
 */
function manyReasons() {
  /** @type {Record<string, number>} */
  const extra = {};
  for (const index of Array.from({ length: EXTRA_REASONS }, (_value, position) => position)) {
    extra[`reason_${String(index).padStart(REASON_DIGITS, "0")}`] = ONE;
  }
  return { queue_overflow: CLAMPED_COUNT, ...extra };
}

/**
 * @param {number} count
 * @returns {readonly string[]}
 */
function logIds(count) {
  return Array.from({ length: count }, (_value, index) => `evt_log_${String(index)}`);
}

/**
 * @param {unknown} dropped
 * @returns {void}
 */
function assertCappedReasons(dropped) {
  assert.ok(isRecord(dropped));
  assert.equal(Object.keys(dropped).length, MAX_REASONS);
  assert.equal(dropped["queue_overflow"], CLAMPED_COUNT);
  assert.equal(dropped["event_too_large"], undefined);
}

await test("client reports cap reasons at 16 and clamp counts", async () => {
  const store = reportStore({ pending: null, unreported: manyReasons() });
  const client = createClient({ [CLIENT_REPORT_STORE]: store, maxQueueSize: 1 });
  logAll(client, ["evt_log_001", "evt_log_002"]);
  logOversized(client);
  const transport = RecordingTransport.alwaysAccept();

  await client.flush(transport);

  assertCappedReasons(field(reports(transport)[FIRST], "dropped_events"));
});

/**
 * @param {LogBrewClient} client
 * @returns {Promise<readonly unknown[]>}
 */
async function reportsAcrossShutdown(client) {
  log(client, "evt_log_001");
  const transport = RecordingTransport.alwaysAccept();
  await client.flush(transport);
  log(client, "evt_log_002");
  await client.shutdown(transport);
  return transport.sentBodies.map((body) => reportOf(body));
}

await test("a store restores a pending report first, then unreported counts under a new ID", async () => {
  const pending = { dropped_events: { queue_overflow: TWO }, report_id: "5f0c6a1e9b2d4c7a8e3f1b6d0a9c2e4f" };
  const store = reportStore({ pending, unreported: { Bad: 1, event_too_large: 3, queue_overflow: 0 } });
  const sent = await reportsAcrossShutdown(createClient({ eventStore: store }));
  assert.deepEqual(sent[FIRST], pending);
  assert.deepEqual(withoutId(sent[SECOND]), { dropped_events: { event_too_large: THREE } });
  assert.deepEqual(store.saves.at(LAST), { pending: null, unreported: {} });
});

await test("drops are saved at once per reason and at most once a second in a burst", () => {
  const store = reportStore(undefined);
  const client = createClient({ eventStore: store, maxQueueSize: 1 });
  logAll(client, logIds(BURST_SIZE));
  logOversized(client);

  assert.deepEqual(store.saves, [
    { pending: null, unreported: { queue_overflow: ONE } },
    { pending: null, unreported: { event_too_large: ONE, queue_overflow: BURST_OVERFLOW } }
  ]);
});

await test("a failing client report store never blocks capture", async () => {
  const store = reportStore(undefined);
  store.loadClientReport = () => {
    throw new Error("unreadable");
  };
  store.saveClientReport = () => {
    throw new Error("disk full");
  };
  const client = createClient({ eventStore: store, maxQueueSize: 1 });
  logAll(client, ["evt_log_001", "evt_log_002"]);
  const transport = RecordingTransport.alwaysAccept();

  await client.flush(transport);

  assert.deepEqual(lastReport(transport), overflow(ONE));
});
