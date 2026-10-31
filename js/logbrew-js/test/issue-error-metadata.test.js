import {
  LOGGER_TRACE,
  firstAttributes,
  pick,
  sampleClient,
  uncheckedIssue,
  uncheckedIssueAttributes
} from "./issue-helpers.js";
import assert from "node:assert/strict";
import { createIssueAttributesFromError } from "@logbrew/sdk";
import test from "node:test";

const APP_DEBUG_ID = "11111111-2222-4333-8444-555555555555";
const REGISTRY_KEY = Symbol.for("logbrew.release-artifact.debug-ids");
const APP_FRAME = {
  column: 34,
  debugId: APP_DEBUG_ID,
  filename: "https://cdn.example/assets/app.js",
  function: "checkout",
  line: 12
};
const VENDOR_FRAME = {
  column: 2,
  filename: "https://cdn.example/assets/vendor.js",
  function: "ignored",
  line: 1
};
const MECHANISM = { handled: true, type: "javascript.error" };
const EXPECTED_ATTRIBUTES = {
  exception: { mechanism: MECHANISM, type: "TypeError" },
  exceptionChain: {
    entries: [{
      id: 0,
      mechanism: MECHANISM,
      messageState: "redacted",
      relationship: "reported",
      stackFrames: [APP_FRAME, VENDOR_FRAME],
      stackFramesState: "captured",
      type: "TypeError"
    }],
    truncated: false
  },
  level: "error",
  message: "Checkout exploded",
  metadata: {
    environment: "production",
    errorFrameColumn: 34,
    errorFrameFile: "https://cdn.example/assets/app.js",
    errorFrameLine: 12,
    errorMessage: "Checkout exploded",
    errorName: "TypeError",
    issueGroupingKey: "javascript.error:TypeError:https://cdn.example/assets/app.js",
    issueGroupingSource: "error_type_and_frame",
    parentSpanId: LOGGER_TRACE.parentSpanId,
    release: "web@2026.07.03",
    releaseArtifactCodeFile: "https://cdn.example/assets/app.js",
    releaseArtifactDebugId: APP_DEBUG_ID,
    releaseArtifactType: "sourcemap",
    routeTemplate: "/checkout",
    runtime: "browser",
    sampled: true,
    service: "checkout-web",
    source: "javascript.error",
    spanId: LOGGER_TRACE.spanId,
    traceId: LOGGER_TRACE.traceId
  },
  stackFrames: [APP_FRAME, VENDOR_FRAME],
  title: "TypeError"
};

/**
 * @returns {TypeError}
 */
function checkoutError() {
  const error = new TypeError("Checkout exploded");
  error.stack = [
    "TypeError: Checkout exploded",
    "    at checkout (https://cdn.example/assets/app.js?debug=true#section:12:34)",
    "    at ignored (https://cdn.example/assets/vendor.js?debug=true#section:1:2)"
  ].join("\n");
  return error;
}

/**
 * @param {Readonly<Record<string, string>>} registry
 * @param {() => void} run
 * @returns {void}
 */
function withDebugIdRegistry(registry, run) {
  const hadRegistry = Object.hasOwn(globalThis, REGISTRY_KEY);
  /** @type {unknown} */
  const previousRegistry = Reflect.get(globalThis, REGISTRY_KEY);
  try {
    Reflect.set(globalThis, REGISTRY_KEY, registry);
    run();
  } finally {
    if (hadRegistry) {
      Reflect.set(globalThis, REGISTRY_KEY, previousRegistry);
    } else {
      Reflect.deleteProperty(globalThis, REGISTRY_KEY);
    }
  }
}

/**
 * @param {unknown} error
 * @returns {void}
 */
function assertRegistryDebugIds(error) {
  withDebugIdRegistry({
    "vendor/app.js": "22222222-3333-4444-8555-666666666666",

    "assets/app.js": APP_DEBUG_ID
  }, () => {
    const automatic = createIssueAttributesFromError(error, {
      environment: "production",
      release: "web@2026.07.03",
      runtime: "browser",
      service: "checkout-web"
    });
    assert.equal(pick(automatic, "stackFrames.0.debugId"), APP_DEBUG_ID);
    assert.equal(pick(automatic, "metadata.releaseArtifactDebugId"), APP_DEBUG_ID);
  });
}

await test("createIssueAttributesFromError attaches privacy-bounded release artifact metadata", () => {
  const error = checkoutError();
  const attributes = uncheckedIssueAttributes(error, {
    debugIdMap: { "https://cdn.example/assets/app.js": APP_DEBUG_ID },
    environment: "production",
    metadata: { ignoredObject: { nested: true }, routeTemplate: "/checkout" },
    release: "web@2026.07.03",
    runtime: "browser",
    service: "checkout-web",
    trace: LOGGER_TRACE
  });
  assert.deepEqual(attributes, EXPECTED_ATTRIBUTES);

  const serialized = JSON.stringify(attributes);
  assert.doesNotMatch(serialized, /debug=true|section|ignoredObject|nested/u);
  assert.doesNotMatch(serialized, /errorStack/u);
  assertRegistryDebugIds(error);

  const client = sampleClient();
  uncheckedIssue(client, ["evt_multi_frame", "2026-07-17T12:00:00Z", attributes]);
  assert.deepEqual(pick(firstAttributes(client), "stackFrames"), pick(attributes, "stackFrames"));
});

await test("createIssueAttributesFromError omits non-UUID release artifact Debug IDs", () => {
  const error = new Error("Invalid Debug ID");
  error.stack = "Error: Invalid Debug ID\n    at checkout (app:///assets/app.js:12:34)";

  const attributes = createIssueAttributesFromError(error, {
    debugIdMap: { "app:///assets/app.js": "not-a-debug-id" }
  });

  assert.equal(pick(attributes, "stackFrames.0.debugId"), undefined);
  assert.equal(pick(attributes, "metadata.releaseArtifactDebugId"), undefined);
});

await test("createIssueAttributesFromError omits local paths and stack text by default", () => {
  const error = new Error("Local build failed");
  error.stack = [
    "Error: Local build failed",
    "    at compile (/home/example/project/dist/app.js:4:5)"
  ].join("\n");

  const attributes = createIssueAttributesFromError(error, {
    debugIdMap: { "/home/example/project/dist/app.js": "22222222-3333-4444-8555-666666666666" },
    metadata: { flow: "build" }
  });

  assert.equal(pick(attributes, "metadata.errorFrameFile"), "app.js");
  assert.equal(pick(attributes, "metadata.issueGroupingKey"), "javascript.error:Error:app.js");
  assert.equal(pick(attributes, "metadata.releaseArtifactCodeFile"), "app.js");
  assert.equal(pick(attributes, "metadata.releaseArtifactDebugId"), "22222222-3333-4444-8555-666666666666");

  const serialized = JSON.stringify(attributes);
  assert.doesNotMatch(serialized, /\/home\/example|example\/project|errorStack/u);
});

await test("createIssueAttributesFromError includes stack only when explicitly requested", () => {
  const error = new Error("Stack allowed");
  error.stack = "Error: Stack allowed\n    at allowed (app:///assets/app.js:1:2)";

  const attributes = createIssueAttributesFromError(error, { includeErrorStack: true });

  assert.equal(pick(attributes, "metadata.errorStack"), error.stack);
});

await test("createIssueAttributesFromError supports explicit privacy-bounded grouping fingerprint", () => {
  const error = new Error("payment failed for user dev@example.test order 12345");
  error.stack = [
    "Error: payment failed for user dev@example.test order 12345",
    "    at submit (https://cdn.example/assets/checkout.js?email=dev@example.test#retry:8:9)"
  ].join("\n");

  const attributes = uncheckedIssueAttributes(error, {
    fingerprint: "checkout-payment-submit",
    metadata: { ignoredObject: { nested: true } },
    source: "browser.error"
  });

  assert.equal(pick(attributes, "metadata.issueFingerprint"), "checkout-payment-submit");
  assert.equal(pick(attributes, "metadata.issueGroupingKey"), "browser.error:Error:https://cdn.example/assets/checkout.js");
  assert.equal(pick(attributes, "metadata.issueGroupingSource"), "explicit_fingerprint");
  assert.equal(pick(attributes, "metadata.ignoredObject"), undefined);

  const serializedGroupingMetadata = JSON.stringify({
    issueFingerprint: pick(attributes, "metadata.issueFingerprint"),
    issueGroupingKey: pick(attributes, "metadata.issueGroupingKey"),
    issueGroupingSource: pick(attributes, "metadata.issueGroupingSource")
  });
  assert.doesNotMatch(serializedGroupingMetadata, /dev@example|12345|email=|retry|ignoredObject|nested/u);
});
