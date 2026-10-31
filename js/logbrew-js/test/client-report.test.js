import {
  ACCEPTED,
  ONE,
  TWO,
  createClient,
  log,
  logAll,
  logOversized,
  overflow,
  overflowingClient,
  reportIds,
  reportOf,
  reports,
  withoutId
} from "./client-report-helpers.js";
import { RecordingTransport, TransportError } from "@logbrew/sdk";
import { isRecord, parseJson } from "./capture-helpers.js";
import assert from "node:assert/strict";
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import test from "node:test";

/**
 * @import { LogBrewClient, Transport, TransportResponse } from "@logbrew/sdk"
 */

const UNAVAILABLE = Object.freeze({ attempts: 1, statusCode: 503 });
const FIRST = 0;
const SECOND = 1;
const THIRD = 2;
const SMALL_MESSAGE_LENGTH = 200;

/**
 * @param {Readonly<Promise<unknown>>} released
 * @returns {Promise<TransportResponse>}
 */
async function acceptAfter(released) {
  await released;
  return ACCEPTED;
}

/**
 * @param {(report: unknown) => number} record
 * @param {Readonly<Promise<unknown>>} released
 * @returns {Transport}
 */
function heldTransport(record, released) {
  return {
    async send(_apiKey, body) {
      return record(withoutId(reportOf(body))) === ONE ? acceptAfter(released) : ACCEPTED;
    }
  };
}

/**
 * @param {string} name
 * @param {() => TransportError | Readonly<{ statusCode: number }>} failure
 * @returns {Promise<void>}
 */
async function retryKeepsPendingReport(name, failure) {
  await test(`drop counts stay pending after ${name} and the resent body reports them once`, async () => {
    const client = overflowingClient(ONE);
    const transport = new RecordingTransport([failure(), ACCEPTED, ACCEPTED]);

    await assert.rejects(client.flush(transport));
    await client.flush(transport);
    log(client, "evt_log_003");
    await client.flush(transport);

    assert.equal(transport.sentBodies[SECOND], transport.sentBodies[FIRST]);
    assert.deepEqual(reports(transport), [overflow(ONE), overflow(ONE), undefined]);
  });
}

/**
 * @param {LogBrewClient} client
 * @param {RecordingTransport} transport
 * @returns {Promise<void>}
 */
async function flushThreeBatches(client, transport) {
  log(client, "evt_log_003");
  await client.flush(transport);
  logAll(client, ["evt_log_004", "evt_log_005"]);
  await client.flush(transport);
  log(client, "evt_log_006");
  await client.flush(transport);
}

await test("drop counts ride in the next batch and clear after a 2xx", async () => {
  const client = createClient({ maxQueueSize: 1 });
  logAll(client, ["evt_log_001", "evt_log_002", "evt_log_003"]);
  logOversized(client);
  const transport = RecordingTransport.alwaysAccept();

  await client.flush(transport);
  log(client, "evt_log_004");
  await client.flush(transport);

  assert.deepEqual(reports(transport), [{ dropped_events: { event_too_large: 1, queue_overflow: 2 } }, undefined]);
  assert.equal(client.deliveryHealth().droppedByReason.queue_overflow, TWO);
});

await test("a batch without drops carries no client report", async () => {
  const client = createClient();
  log(client, "evt_log_001");
  const transport = RecordingTransport.alwaysAccept();
  await client.flush(transport);
  const body = parseJson(String(transport.lastBody()));
  assert.ok(isRecord(body));
  assert.deepEqual(Object.keys(body), ["sdk", "events"]);
});

await retryKeepsPendingReport("a 5xx", () => UNAVAILABLE);
await retryKeepsPendingReport("a network error", () => TransportError.network("offline"));

/**
 * @returns {{ readonly bodies: readonly unknown[], readonly release: AbortController, readonly transport: Transport }}
 */
function heldRecorder() {
  /** @type {unknown[]} */
  const bodies = [];
  const release = new AbortController();
  const transport = heldTransport((report) => bodies.push(report), once(release.signal, "abort"));
  return { bodies, release, transport };
}

/**
 * @param {LogBrewClient} client
 * @returns {Promise<readonly unknown[]>}
 */
async function reportsAroundHeldFlush(client) {
  const { bodies, release, transport } = heldRecorder();
  const flush = client.flush(transport);
  await setImmediate();
  logAll(client, ["evt_log_003", "evt_log_004"]);
  release.abort();
  await flush;
  log(client, "evt_log_005");
  await client.flush(transport);
  return bodies;
}

await test("drops during an in-flight batch stay pending for the next batch", async () => {
  const client = overflowingClient(ONE);
  assert.deepEqual(await reportsAroundHeldFlush(client), [overflow(ONE), overflow(TWO)]);
});

await test("a report resent in a different batch keeps its report ID", async () => {
  const client = overflowingClient(ONE);
  const transport = new RecordingTransport([TransportError.network("offline"), ACCEPTED, ACCEPTED]);

  await assert.rejects(client.flush(transport));
  client.purgePendingEvents();
  await flushThreeBatches(client, transport);

  const ids = reportIds(transport);
  assert.notEqual(transport.sentBodies[SECOND], transport.sentBodies[FIRST]);
  assert.equal(ids[SECOND], ids[FIRST]);
  assert.deepEqual(reports(transport), [overflow(ONE), overflow(ONE), overflow(ONE), undefined]);
  assert.notEqual(ids[THIRD], ids[FIRST]);
});

/**
 * @returns {number}
 */
function oneEventBatchBytes() {
  const probe = createClient();
  log(probe, "evt_log_001", "m".repeat(SMALL_MESSAGE_LENGTH));
  return Buffer.byteLength(probe.previewJson().replaceAll(/\s/gu, ""), "utf8");
}

await test("a client report never pushes a batch over maxBatchBytes", async () => {
  const exactBytes = oneEventBatchBytes();
  const client = createClient({ maxBatchBytes: exactBytes });
  log(client, "evt_log_001", "m".repeat(SMALL_MESSAGE_LENGTH));
  log(client, "evt_log_big", "x".repeat(exactBytes));
  const transport = RecordingTransport.alwaysAccept();

  await client.flush(transport);
  log(client, "evt_log_002", "short");
  await client.flush(transport);

  assert.ok(transport.sentBodies.every((body) => Buffer.byteLength(body, "utf8") <= exactBytes));
  assert.deepEqual(reports(transport), [undefined, { dropped_events: { event_too_large: 1 } }]);
});
