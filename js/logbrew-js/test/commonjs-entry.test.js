import { field, invokeUnchecked } from "./batch-helpers.js";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const SCHEMA_VERSION = 1;

/**
 * @param {unknown} value
 * @returns {string}
 */
function requireText(value) {
  if (typeof value !== "string") {
    throw new TypeError("expected preview JSON text");
  }
  return value;
}

/**
 * @param {unknown} sdk
 * @returns {void}
 */
function assertCommonJsExports(sdk) {
  assert.equal(typeof field(field(sdk, "RecordingTransport"), "alwaysAccept"), "function");
  assert.equal(typeof field(sdk, "createProductActionAttributes"), "function");
  assert.equal(field(sdk, "PRODUCT_ANALYTICS_SCHEMA_VERSION"), SCHEMA_VERSION);
  assert.deepEqual(field(sdk, "PRODUCT_ANALYTICS_KINDS"), ["page_view", "screen_view", "interaction"]);
  assert.equal(typeof field(sdk, "createNetworkMilestoneAttributes"), "function");
  assert.equal(typeof field(sdk, "createSupportTicketDraft"), "function");
  assert.equal(typeof field(sdk, "installLogBrewConsoleCapture"), "function");
  assert.equal(typeof field(sdk, "createLogBrewOpenTelemetrySpanExporter"), "function");
  assert.equal(typeof field(sdk, "logbrewTraceContextFromCurrentOpenTelemetrySpan"), "function");
  assert.equal(typeof field(sdk, "parseTraceparent"), "function");
}

await test("CommonJS entry exposes the public API", () => {
  const requireFromTest = createRequire(import.meta.url);
  /** @type {unknown} */
  const sdk = requireFromTest("@logbrew/sdk");
  const client = invokeUnchecked(field(sdk, "LogBrewClient"), "create", [{
    apiKey: "LOGBREW_API_KEY",
    sdkName: "logbrew-js-cjs",
    sdkVersion: "0.1.0"
  }]);

  invokeUnchecked(client, "release", ["evt_release_001", "2026-06-02T10:00:00Z", {
    version: "1.2.3"
  }]);

  assertCommonJsExports(sdk);
  assert.match(requireText(invokeUnchecked(client, "previewJson", [])), /"type": "release"/u);
});
