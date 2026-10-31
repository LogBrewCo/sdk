import { CLIENT_IDENTITY, field, isRecord, memoryEventStore, parseJson } from "./capture-helpers.js";
import { LogBrewClient } from "@logbrew/sdk";
import assert from "node:assert/strict";

/**
 * @import { ClientOptions, MemoryEventStore } from "./capture-helpers.js"
 * @import { RecordingTransport } from "@logbrew/sdk"
 * @typedef {MemoryEventStore & {
 *   loadClientReport: () => unknown,
 *   saveClientReport: (state: unknown) => void,
 *   readonly saves: unknown[]
 * }} ReportStore
 */

const timestamp = "2026-06-02T10:00:00Z";
const REPORT_ID = /^[0-9a-f]{32}$/u;
const ACCEPTED = Object.freeze({ attempts: 1, statusCode: 202 });
const ONE = 1;
const TWO = 2;
const KIBIBYTE = 1024;
const OVERSIZED_KIB = 300;
const OVERSIZED_MESSAGE = "x".repeat(OVERSIZED_KIB * KIBIBYTE);

/**
 * @param {ClientOptions & Readonly<Record<symbol, unknown>>} [options]
 * @returns {LogBrewClient}
 */
function createClient(options = {}) {
  return LogBrewClient.create({ ...CLIENT_IDENTITY, maxRetries: 0, ...options });
}

/**
 * @param {LogBrewClient} client
 * @param {string} id
 * @param {string} [message]
 * @returns {void}
 */
function log(client, id, message = "queued") {
  client.log(id, timestamp, { level: "info", message });
}

/**
 * @param {LogBrewClient} client
 * @param {readonly string[]} ids
 * @returns {void}
 */
function logAll(client, ids) {
  for (const id of ids) {
    log(client, id);
  }
}

/**
 * @param {LogBrewClient} client
 * @returns {void}
 */
function logOversized(client) {
  client.log("evt_log_big", timestamp, { level: "info", message: OVERSIZED_MESSAGE });
}

/**
 * @param {number} maxQueueSize
 * @returns {LogBrewClient}
 */
function overflowingClient(maxQueueSize) {
  const client = createClient({ maxQueueSize });
  logAll(client, ["evt_log_001", "evt_log_002"]);
  return client;
}

/**
 * @param {string} body
 * @returns {unknown}
 */
function reportOf(body) {
  return field(parseJson(body), "client_report");
}

/**
 * @param {unknown} report
 * @returns {unknown}
 */
function withoutId(report) {
  if (report === undefined) {
    return undefined;
  }
  assert.ok(isRecord(report));
  const { report_id: reportId, ...rest } = report;
  assert.match(String(reportId), REPORT_ID);
  return rest;
}

/**
 * @param {RecordingTransport} transport
 * @returns {readonly unknown[]}
 */
function reports(transport) {
  return transport.sentBodies.map((body) => withoutId(reportOf(body)));
}

/**
 * @param {RecordingTransport} transport
 * @returns {readonly unknown[]}
 */
function reportIds(transport) {
  return transport.sentBodies.map((body) => field(reportOf(body), "report_id"));
}

/**
 * @param {RecordingTransport} transport
 * @returns {unknown}
 */
function lastReport(transport) {
  const body = transport.lastBody();
  assert.ok(typeof body === "string");
  return withoutId(reportOf(body));
}

/**
 * @param {number} count
 * @returns {{ readonly dropped_events: Readonly<Record<string, number>> }}
 */
function overflow(count) {
  return { dropped_events: { queue_overflow: count } };
}

/**
 * @param {unknown} saved
 * @returns {ReportStore}
 */
function reportStore(saved) {
  /** @type {unknown[]} */
  const saves = [];
  return {
    ...memoryEventStore(),
    loadClientReport() {
      return saved;
    },
    saveClientReport(state) {
      saves.push(structuredClone(state));
    },
    saves
  };
}

export {
  ACCEPTED,
  ONE,
  TWO,
  createClient,
  lastReport,
  log,
  logAll,
  logOversized,
  overflow,
  overflowingClient,
  reportIds,
  reportOf,
  reportStore,
  reports,
  withoutId
};
