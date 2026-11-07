import { ErrorHandler, Injector } from "@angular/core";
import { LogBrewClient, RecordingTransport } from "@logbrew/sdk";
import assert from "node:assert/strict";
import commonjsAdapter from "./commonjs.cjs";
import { provideLogBrew } from "@logbrew/angular";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";

/**
 * @typedef {{ readonly format: string, readonly provideLogBrew: typeof provideLogBrew }} Adapter
 * @typedef {{ failed: number, flushed: number, sequence: number }} Counts
 * @typedef {{
 *   readonly client: LogBrewClient,
 *   readonly counts: Counts,
 *   readonly handler: ErrorHandler,
 *   readonly transport: RecordingTransport
 * }} TestApp
 */

const timestamp = "2026-10-04T10:00:00.000Z";
const WAIT_MS = 1000;
const NO_DELAY = 0;
const NONE = 0;
const ONE = 1;
const TWO = 2;

/** @type {readonly Adapter[]} */
const adapters = [
  { format: "esm", provideLogBrew },
  { format: "cjs", provideLogBrew: commonjsAdapter.provideLogBrew }
];

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {unknown}
 */
function readField(value, key) {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/**
 * @param {RecordingTransport} transport
 * @returns {unknown[]}
 */
function sentIssueIds(transport) {
  return transport.sentBodies.flatMap((body) => {
    /** @type {unknown} */
    const parsed = JSON.parse(body);
    const events = readField(parsed, "events");
    return Array.isArray(events)
      ? events.filter((event) => readField(event, "type") === "issue").map((event) => readField(event, "id"))
      : [];
  });
}

/**
 * @param {() => boolean} predicate
 * @param {number} [deadline]
 * @returns {Promise<void>}
 */
async function waitFor(predicate, deadline = Date.now() + WAIT_MS) {
  if (predicate()) {
    return;
  }
  if (Date.now() >= deadline) {
    throw new Error("capture completion was not observed");
  }
  await sleep(NO_DELAY);
  await waitFor(predicate, deadline);
}

/**
 * @param {Adapter} adapter
 * @returns {TestApp}
 */
function makeTestApp(adapter) {
  const client = LogBrewClient.create({
    apiKey: "LOGBREW_CLIENT_KEY",
    automaticDelivery: false,
    sdkName: "angular-error-test",
    sdkVersion: "1.0.0"
  });
  const transport = RecordingTransport.alwaysAccept();
  const counts = { failed: NONE, flushed: NONE, sequence: NONE };
  const injector = Injector.create({
    providers: adapter.provideLogBrew({
      client,
      errorEvent: () => {
        counts.sequence += ONE;
        return {
          attributes: { level: "error", message: "component failed", title: "Angular component failed" },
          id: `evt_angular_error_${String(counts.sequence)}`,
          timestamp
        };
      },
      onCaptureError: () => {
        counts.failed += ONE;
      },
      onFlush: () => {
        counts.flushed += ONE;
      },
      transport
    })
  });
  return { client, counts, handler: injector.get(ErrorHandler), transport };
}

/**
 * @param {ErrorHandler} handler
 * @param {() => number} settled
 * @returns {Promise<void>}
 */
async function failTwice(handler, settled) {
  handler.handleError(new Error("first component failed"));
  await waitFor(() => settled() === ONE);
  handler.handleError(new Error("second component failed"));
  await waitFor(() => settled() === TWO);
}

for (const adapter of adapters) {
  void test(`Angular error handler captures 2 errors and keeps the client open in ${adapter.format}`, async () => {
    const { client, counts, handler, transport } = makeTestApp(adapter);
    try {
      await failTwice(handler, () => counts.flushed + counts.failed);
      assert.equal(counts.failed, NONE);
      assert.deepEqual(sentIssueIds(transport), ["evt_angular_error_1", "evt_angular_error_2"]);
      assert.doesNotThrow(() => {
        client.log("evt_angular_log_1", timestamp, { level: "info", message: "application continued" });
      });
    } finally {
      await client.shutdown(transport);
    }
  });
}
