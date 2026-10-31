import { RecordingTransport, installLogBrewConsoleCapture, logAttributesFromConsoleArgs, logbrewLevelFromConsoleMethod } from "@logbrew/sdk";
import { callUnchecked, eventValues, lastPayload, metadataValue, pick, sampleClient } from "./tracing-helpers.js";
import assert from "node:assert/strict";
import test from "node:test";

/**
 * @import { ConsoleCaptureHandle, LogBrewClient } from "@logbrew/sdk"
 */

/**
 * @typedef {(...args: readonly unknown[]) => void} ConsoleMethod
 * @typedef {{ readonly error: ConsoleMethod, readonly info: ConsoleMethod, readonly warn: ConsoleMethod }} ConsoleTarget
 * @typedef {readonly [string, readonly unknown[]]} ConsoleCall
 * @typedef {{ readonly calls: readonly ConsoleCall[], readonly client: LogBrewClient, readonly handle: Readonly<ConsoleCaptureHandle>, readonly targetConsole: ConsoleTarget, readonly transport: RecordingTransport }} CaptureScenario
 */

const NO_EVENTS = 0;
const ONE_BODY = 1;
const QUEUED_ITEMS = 42;

/**
 * @returns {CaptureScenario}
 */
function captureScenario() {
  const client = sampleClient();
  const transport = RecordingTransport.alwaysAccept();
  /** @type {ConsoleCall[]} */
  const calls = [];
  /** @type {ConsoleTarget} */
  const targetConsole = {
    error(...args) {
      calls.push(["error", args]);
    },
    info(...args) {
      calls.push(["info", args]);
    },
    warn(...args) {
      calls.push(["warn", args]);
    }
  };
  const handle = installLogBrewConsoleCapture({
    client,
    console: targetConsole,
    eventIdPrefix: "test_console",
    levels: ["warn", "error"],
    logger: "console",
    metadata: { service: "checkout" },
    timestamp: () => "2026-06-02T10:00:07Z",
    transport
  });
  return { calls, client, handle, targetConsole, transport };
}

/**
 * @param {CaptureScenario} scenario
 * @returns {Promise<void>}
 */
async function writeThroughCapture({ handle, targetConsole }) {
  targetConsole.info("not captured");
  targetConsole.warn("cart queued", QUEUED_ITEMS);
  targetConsole.error("checkout failed", new Error("boom"));
  await handle.flush();
  handle.uninstall();
  targetConsole.warn("after uninstall");
}

/**
 * @param {RecordingTransport} transport
 * @returns {void}
 */
function assertCapturedBody(transport) {
  const body = lastPayload(transport);
  assert.deepEqual(eventValues(body, "id"), ["test_console_1", "test_console_2"]);
  assert.deepEqual(eventValues(body, "attributes.level"), ["warning", "error"]);
  assert.equal(pick(body, "events.0.attributes.logger"), "console");
  assert.equal(pick(body, "events.0.attributes.metadata.service"), "checkout");
  const errorEvent = pick(body, "events.1");
  assert.equal(metadataValue(errorEvent, "errorName"), "Error");
  assert.equal(metadataValue(errorEvent, "errorMessage"), "boom");
  assert.equal(metadataValue(errorEvent, "errorStack"), undefined);
}

await test("console argument helper maps safe log attributes", () => {
  const attributes = callUnchecked(logAttributesFromConsoleArgs, [
    "warn",
    ["cart queued", { orderId: 42 }, new TypeError("database unavailable")],
    {
      logger: "console",
      metadata: {
        ignoredObject: { nested: true },
        service: "checkout"
      }
    }
  ]);

  assert.equal(logbrewLevelFromConsoleMethod("log"), "info");
  assert.equal(logbrewLevelFromConsoleMethod("debug"), "info");
  assert.equal(logbrewLevelFromConsoleMethod("warn"), "warning");
  assert.equal(pick(attributes, "level"), "warning");
  assert.equal(pick(attributes, "logger"), "console");
  assert.equal(pick(attributes, "message"), 'cart queued {"orderId":42} TypeError: database unavailable');
  assert.deepEqual(pick(attributes, "metadata"), {
    argumentCount: 3,
    consoleMethod: "warn",
    errorMessage: "database unavailable",
    errorName: "TypeError",
    service: "checkout"
  });
});

await test("console capture preserves output and uninstalls cleanly", async () => {
  const scenario = captureScenario();
  await writeThroughCapture(scenario);

  assert.deepEqual(scenario.calls.map(([level]) => level), ["info", "warn", "error", "warn"]);
  assert.equal(scenario.client.pendingEvents(), NO_EVENTS);
  assert.equal(scenario.transport.sentBodies.length, ONE_BODY);
  assertCapturedBody(scenario.transport);
});
