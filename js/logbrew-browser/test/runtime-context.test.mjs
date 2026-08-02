import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

import { RecordingTransport } from "@logbrew/sdk";
import { createLogBrewBrowserClient } from "../index.js";

const FIXED_TIMESTAMP = "2026-08-03T01:00:00Z";
const require = createRequire(import.meta.url);

test("browser package requires a typed-context-capable core", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.peerDependencies["@logbrew/sdk"], "^0.1.7");
});

function lowEntropyNavigator() {
  return {
    userAgentData: {
      brands: [
        { brand: "Not_A Brand", version: "99" },
        { brand: "Chromium", version: "126" },
        { brand: "Google Chrome", version: "126" }
      ],
      mobile: false,
      platform: "macOS"
    }
  };
}

function expectedContext() {
  return {
    schemaVersion: 1,
    resource: {
      runtime: { name: "Google Chrome", version: "126" },
      operatingSystem: { name: "macOS" },
      device: { family: "desktop" }
    }
  };
}

async function capturedAttributes(createClient, config = {}) {
  const client = createClient({
    browserNavigator: lowEntropyNavigator(),
    clientKey: "TEST_BROWSER_KEY",
    ...config
  });
  client.log("browser-runtime-context", FIXED_TIMESTAMP, {
    level: "info",
    message: "runtime context"
  });
  const attributes = JSON.parse(client.previewJson()).events[0].attributes;
  await client.shutdown(RecordingTransport.alwaysAccept());
  return attributes;
}

test("browser client adds low-entropy runtime context by default", async () => {
  const attributes = await capturedAttributes(createLogBrewBrowserClient);
  assert.deepEqual(attributes.context, expectedContext());
  assert.deepEqual(Object.keys(attributes.context.resource).sort(), [
    "device",
    "operatingSystem",
    "runtime"
  ]);
});

test("browser client applies default runtime context to every signal type", async () => {
  const client = createLogBrewBrowserClient({
    browserNavigator: lowEntropyNavigator(),
    clientKey: "TEST_BROWSER_KEY"
  });
  client.release("browser-release", FIXED_TIMESTAMP, { version: "1.0.0" });
  client.environment("browser-environment", FIXED_TIMESTAMP, { name: "test" });
  client.issue("browser-issue", FIXED_TIMESTAMP, {
    title: "Browser runtime context issue",
    level: "error",
    message: "runtime context"
  });
  client.log("browser-log", FIXED_TIMESTAMP, {
    level: "info",
    message: "runtime context"
  });
  client.span("browser-span", FIXED_TIMESTAMP, {
    name: "runtime context",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
    status: "ok"
  });
  client.action("browser-action", FIXED_TIMESTAMP, {
    name: "runtime context",
    status: "success"
  });
  client.metric("browser-metric", FIXED_TIMESTAMP, {
    name: "runtime.context",
    kind: "gauge",
    value: 1,
    unit: "1",
    temporality: "instant"
  });

  const preview = JSON.parse(client.previewJson());
  assert.deepEqual(preview.events.map((event) => event.type), [
    "release",
    "environment",
    "issue",
    "log",
    "span",
    "action",
    "metric"
  ]);
  for (const event of preview.events) {
    assert.deepEqual(event.attributes.context, expectedContext());
  }
  await client.shutdown(RecordingTransport.alwaysAccept());
});

test("browser defaults never read legacy or high-entropy navigator fields", async () => {
  const marker = "must-not-enter-browser-telemetry";
  let userAgentReads = 0;
  let highEntropyCalls = 0;
  let highEntropyReads = 0;
  const userAgentData = {
    brands: [{ brand: "Chromium", version: "126" }],
    mobile: true,
    platform: "Android",
    getHighEntropyValues() {
      highEntropyCalls += 1;
      return Promise.resolve({ model: marker });
    }
  };
  const readHighEntropyMarker = () => {
    highEntropyReads += 1;
    return marker;
  };
  for (const key of ["architecture", "bitness", "fullVersionList", "model", "platformVersion"]) {
    Object.defineProperty(userAgentData, key, {
      get: readHighEntropyMarker
    });
  }
  const browserNavigator = { language: marker, userAgentData };
  Object.defineProperty(browserNavigator, "userAgent", {
    get() {
      userAgentReads += 1;
      return marker;
    }
  });

  const attributes = await capturedAttributes(createLogBrewBrowserClient, { browserNavigator });
  assert.deepEqual(attributes.context, {
    schemaVersion: 1,
    resource: {
      runtime: { name: "Chromium", version: "126" },
      operatingSystem: { name: "Android" },
      device: { family: "mobile" }
    }
  });
  assert.equal(userAgentReads, 0);
  assert.equal(highEntropyCalls, 0);
  assert.equal(highEntropyReads, 0);
  assert.equal(JSON.stringify(attributes).includes(marker), false);
});

test("unsupported client hints fall back to generic browser runtime", async () => {
  const attributes = await capturedAttributes(createLogBrewBrowserClient, { browserNavigator: {} });
  assert.deepEqual(attributes.context, {
    schemaVersion: 1,
    resource: { runtime: { name: "browser" } }
  });
});

test("explicit context overrides named browser defaults and extends device classification", async () => {
  const callerContext = Object.freeze({
    schemaVersion: 1,
    resource: Object.freeze({
      service: Object.freeze({ name: "checkout-web", version: "1.4.0" }),
      runtime: Object.freeze({ name: "WebView", version: "4.5" }),
      operatingSystem: Object.freeze({ name: "TestOS", version: "4.5" }),
      device: Object.freeze({ model: "simulator" }),
      application: Object.freeze({ name: "checkout", version: "1.4.0" })
    }),
    tags: Object.freeze({ plan: "team" })
  });
  const attributes = await capturedAttributes(createLogBrewBrowserClient, { context: callerContext });

  assert.deepEqual(attributes.context, {
    schemaVersion: 1,
    resource: {
      service: { name: "checkout-web", version: "1.4.0" },
      runtime: { name: "WebView", version: "4.5" },
      operatingSystem: { name: "TestOS", version: "4.5" },
      device: { family: "desktop", model: "simulator" },
      application: { name: "checkout", version: "1.4.0" }
    },
    tags: { plan: "team" }
  });
  assert.equal(callerContext.resource.device.family, undefined);
});

test("browser runtime context can be disabled without changing explicit context", async () => {
  const explicit = await capturedAttributes(createLogBrewBrowserClient, {
    captureRuntimeContext: false,
    context: { schemaVersion: 1, tags: { plan: "team" } }
  });
  const absent = await capturedAttributes(createLogBrewBrowserClient, {
    captureRuntimeContext: false
  });

  assert.deepEqual(explicit.context, { schemaVersion: 1, tags: { plan: "team" } });
  assert.equal(absent.context, undefined);
});

test("browser runtime controls do not hide invalid explicit configuration", () => {
  assert.throws(
    () => createLogBrewBrowserClient({
      browserNavigator: lowEntropyNavigator(),
      captureRuntimeContext: "yes",
      clientKey: "TEST_BROWSER_KEY"
    }),
    /captureRuntimeContext must be a boolean/
  );
  assert.throws(
    () => createLogBrewBrowserClient({
      browserNavigator: lowEntropyNavigator(),
      clientKey: "TEST_BROWSER_KEY",
      context: { resource: { runtime: { name: "browser" } } }
    }),
    /schemaVersion must be 1/
  );
});

test("CommonJS and ESM browser clients expose the same default runtime context", async () => {
  const commonJs = require("../index.cjs");
  const esm = await capturedAttributes(createLogBrewBrowserClient);
  const cjs = await capturedAttributes(commonJs.createLogBrewBrowserClient);

  assert.deepEqual(cjs.context, esm.context);
  assert.deepEqual(cjs.context, expectedContext());
});
