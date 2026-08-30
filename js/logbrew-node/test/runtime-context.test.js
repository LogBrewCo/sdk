import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { arch, release, type } from "node:os";
import test from "node:test";

import { RecordingTransport } from "@logbrew/sdk";
import nodeSdk, { createLogBrewNodeClient } from "../index.js";

const FIXED_TIMESTAMP = "2026-08-02T10:00:00Z";
const require = createRequire(import.meta.url);

async function capturedAttributes(createClient, config = {}) {
  const client = createClient({
    apiKey: "TEST_API_KEY",
    automaticDelivery: false,
    ...config
  });
  client.log("runtime-context", FIXED_TIMESTAMP, {
    level: "info",
    message: "runtime context"
  });
  const attributes = JSON.parse(client.previewJson()).events[0].attributes;
  await client.shutdown(RecordingTransport.alwaysAccept());
  return attributes;
}

function expectedDefaultContext() {
  return {
    schemaVersion: 1,
    resource: {
      runtime: { name: "node", version: process.versions.node },
      operatingSystem: { name: type(), version: release() },
      device: { architecture: arch() }
    }
  };
}

test("Node client adds only bounded non-unique runtime context by default", async () => {
  const markerName = "LOGBREW_RUNTIME_CONTEXT_PRIVATE_MARKER";
  const markerValue = "must-not-enter-telemetry";
  process.env[markerName] = markerValue;
  let attributes;
  try {
    attributes = await capturedAttributes(createLogBrewNodeClient);
  } finally {
    delete process.env[markerName];
  }

  assert.deepEqual(attributes.context, expectedDefaultContext());
  const serialized = JSON.stringify(attributes);
  assert.equal(serialized.includes(markerName), false);
  assert.equal(serialized.includes(markerValue), false);
  assert.deepEqual(Object.keys(attributes.context.resource).sort(), [
    "device",
    "operatingSystem",
    "runtime"
  ]);
});

test("Node client applies default runtime context to every signal type", async () => {
  const client = createLogBrewNodeClient({
    apiKey: "TEST_API_KEY",
    automaticDelivery: false
  });
  client.release("runtime-release", FIXED_TIMESTAMP, { version: "1.0.0" });
  client.environment("runtime-environment", FIXED_TIMESTAMP, { name: "test" });
  client.issue("runtime-issue", FIXED_TIMESTAMP, {
    title: "Runtime context issue",
    level: "error",
    message: "runtime context"
  });
  client.log("runtime-log", FIXED_TIMESTAMP, {
    level: "info",
    message: "runtime context"
  });
  client.span("runtime-span", FIXED_TIMESTAMP, {
    name: "runtime context",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
    status: "ok"
  });
  client.action("runtime-action", FIXED_TIMESTAMP, {
    name: "runtime context",
    status: "success"
  });
  client.metric("runtime-metric", FIXED_TIMESTAMP, {
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
    assert.deepEqual(event.attributes.context, expectedDefaultContext());
  }
  await client.shutdown(RecordingTransport.alwaysAccept());
});

test("explicit context replaces named defaults and extends device classification", async () => {
  const callerContext = Object.freeze({
    schemaVersion: 1,
    resource: Object.freeze({
      service: Object.freeze({ name: "checkout-api", version: "1.4.0" }),
      runtime: Object.freeze({ name: "bun", version: "1.2.3" }),
      operatingSystem: Object.freeze({ name: "TestOS", version: "4.5" }),
      device: Object.freeze({ model: "container" }),
      application: Object.freeze({ name: "checkout", version: "1.4.0" })
    }),
    tags: Object.freeze({ plan: "team" })
  });

  const attributes = await capturedAttributes(createLogBrewNodeClient, { context: callerContext });

  assert.deepEqual(attributes.context, {
    schemaVersion: 1,
    resource: {
      service: { name: "checkout-api", version: "1.4.0" },
      runtime: { name: "bun", version: "1.2.3" },
      operatingSystem: { name: "TestOS", version: "4.5" },
      device: { model: "container", architecture: arch() },
      application: { name: "checkout", version: "1.4.0" }
    },
    tags: { plan: "team" }
  });
  assert.equal(callerContext.resource.device.architecture, undefined);
});

test("runtime context can be disabled without changing explicit caller context", async () => {
  const explicit = await capturedAttributes(createLogBrewNodeClient, {
    captureRuntimeContext: false,
    context: { schemaVersion: 1, tags: { plan: "team" } }
  });
  const absent = await capturedAttributes(createLogBrewNodeClient, {
    captureRuntimeContext: false
  });

  assert.deepEqual(explicit.context, { schemaVersion: 1, tags: { plan: "team" } });
  assert.equal(absent.context, undefined);
});

test("runtime context controls do not hide invalid explicit configuration", () => {
  assert.throws(
    () => createLogBrewNodeClient({
      apiKey: "TEST_API_KEY",
      automaticDelivery: false,
      captureRuntimeContext: "yes"
    }),
    /captureRuntimeContext must be a boolean/
  );
  assert.throws(
    () => createLogBrewNodeClient({
      apiKey: "TEST_API_KEY",
      automaticDelivery: false,
      context: { resource: { runtime: { name: "node" } } }
    }),
    /schemaVersion must be 1/
  );
});

test("CommonJS and ESM clients expose the same default runtime context", async () => {
  const commonJs = require("../index.cjs");
  const esm = await capturedAttributes(createLogBrewNodeClient);
  const cjs = await capturedAttributes(commonJs.createLogBrewNodeClient);

  assert.deepEqual(cjs.context, esm.context);
  assert.deepEqual(cjs.context, expectedDefaultContext());
  assert.equal(nodeSdk, commonJs.default);
});
