import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import test from "node:test";

import { LogBrewClient, RecordingTransport, SdkError } from "@logbrew/sdk";
import { installLogBrewPinoInstrumentation } from "../index.js";

const pinoEndChannel = channel("tracing:pino_asJson:end");
const trace = {
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "b7ad6b7169203331",
  parentSpanId: "00f067aa0ba902b7",
  sampled: true
};

test("Pino instrumentation captures finalized records without replacing logger output", async () => {
  const client = sampleClient();
  const transport = RecordingTransport.alwaysAccept();
  const output = `${JSON.stringify({
    level: 40,
    time: "2026-06-02T10:00:06.000Z",
    msg: "checkout slow",
    pid: 123,
    hostname: "host.local",
    service: "checkout",
    orderId: 42,
    authorization: "Bearer hidden",
    cookie: "session=hidden",
    requestBody: "hidden payload",
    requestUrl: "/checkout/42?token=hidden",
    request: { headers: { authorization: "Bearer hidden" } },
    err: {
      type: "TypeError",
      message: "database unavailable",
      stack: "hidden stack"
    }
  })}\n`;
  const errors = [];
  const instrumentation = installLogBrewPinoInstrumentation({
    client,
    metadata: { framework: "fastify" },
    onError(error) {
      errors.push(error);
    },
    traceProvider: () => trace,
    transport
  });

  try {
    publishPino(output, 40);
    assert.equal(client.pendingEvents(), 1);
    assert.equal(output.includes("Bearer hidden"), true, "the app-owned Pino output must remain untouched");

    const event = JSON.parse(client.previewJson()).events[0];
    assert.equal(event.type, "log");
    assert.equal(event.timestamp, "2026-06-02T10:00:06.000Z");
    assert.match(event.id, /^evt_node_pino_warn_[0-9a-f]{32}$/u);
    assert.equal(event.attributes.message, "checkout slow");
    assert.equal(event.attributes.level, "warning");
    assert.equal(event.attributes.logger, "pino");
    assert.deepEqual(event.attributes.metadata, {
      framework: "fastify",
      pinoLevel: "warn",
      "context.service": "checkout",
      "context.orderId": 42,
      pinoLevelNumber: 40,
      errorName: "TypeError",
      errorMessage: "database unavailable",
      traceId: trace.traceId,
      spanId: trace.spanId,
      parentSpanId: trace.parentSpanId,
      sampled: true
    });
    assert.equal(errors.length, 0);

    const response = await instrumentation.flush();
    assert.equal(response?.statusCode, 202);
    assert.equal(client.pendingEvents(), 0);
  } finally {
    instrumentation.uninstall();
  }

  publishPino(`${JSON.stringify({ level: 50, msg: "after uninstall" })}\n`, 50);
  assert.equal(client.pendingEvents(), 0);
});

test("Pino instrumentation normalizes custom keys and supports record filtering", () => {
  const client = sampleClient();
  const loggerPrototype = {
    [Symbol("pino.messageKey")]: "messageText",
    [Symbol("pino.errorKey")]: "failure"
  };
  const logger = Object.create(loggerPrototype);
  const instrumentation = installLogBrewPinoInstrumentation({
    client,
    shouldCapture(record) {
      return record.component !== "ignored";
    },
    timestamp: () => "2026-06-02T10:00:07.000Z"
  });

  try {
    publishPino(`${JSON.stringify({ levelName: "error", messageText: "ignored", component: "ignored" })}\n`, 50, logger);
    publishPino(`${JSON.stringify({
      levelName: "error",
      messageText: "checkout failed",
      component: "checkout",
      time: 1e300,
      failure: { type: "RangeError", message: "out of range", stack: "hidden stack" }
    })}\n`, 50, logger);

    assert.equal(client.pendingEvents(), 1);
    const attributes = JSON.parse(client.previewJson()).events[0].attributes;
    assert.equal(JSON.parse(client.previewJson()).events[0].timestamp, "2026-06-02T10:00:07.000Z");
    assert.equal(attributes.message, "checkout failed");
    assert.equal(attributes.level, "error");
    assert.equal(attributes.metadata.errorName, "RangeError");
    assert.equal(attributes.metadata.errorMessage, "out of range");
    assert.equal(attributes.metadata.errorStack, undefined);
    assert.equal(attributes.metadata["context.messageText"], undefined);
    assert.equal(attributes.metadata["context.failure"], undefined);
  } finally {
    instrumentation.uninstall();
  }
});

test("Pino instrumentation rejects invalid configuration before claiming the channel", () => {
  const client = sampleClient();
  for (const config of [
    { client, eventIdPrefix: "" },
    { client, includeErrorStack: "yes" },
    { client, logger: "" },
    { client, metadata: "service" },
    { client, onError: "callback" },
    { client, shouldCapture: "filter" },
    { client, timestamp: "now" },
    { client, traceProvider: "trace" }
  ]) {
    assert.throws(
      () => installLogBrewPinoInstrumentation(config),
      (error) => error instanceof SdkError && error.code === "configuration_error"
    );
  }

  const instrumentation = installLogBrewPinoInstrumentation({ client });
  instrumentation.uninstall();
});

test("Pino instrumentation enforces one process-wide owner", () => {
  const ownerKey = Symbol.for("@logbrew/node.pinoInstrumentation");
  const existingOwner = { installed: true };
  let unexpectedInstrumentation;
  Object.defineProperty(globalThis, ownerKey, {
    configurable: true,
    value: existingOwner
  });

  try {
    assert.throws(
      () => {
        unexpectedInstrumentation = installLogBrewPinoInstrumentation({ client: sampleClient() });
      },
      (error) => error instanceof SdkError && error.code === "configuration_error"
    );
    assert.equal(globalThis[ownerKey], existingOwner);
  } finally {
    unexpectedInstrumentation?.uninstall();
    if (globalThis[ownerKey] === existingOwner) {
      delete globalThis[ownerKey];
    }
  }

  const instrumentation = installLogBrewPinoInstrumentation({ client: sampleClient() });
  assert.equal(globalThis[ownerKey]?.installed, true);
  instrumentation.uninstall();
  assert.equal(globalThis[ownerKey], undefined);
});

test("Pino instrumentation is single-owner and never breaks application logging", () => {
  const client = sampleClient();
  let errors = 0;
  const instrumentation = installLogBrewPinoInstrumentation({
    client,
    onError() {
      errors += 1;
      throw new Error("callback failure");
    },
    traceProvider() {
      throw new Error("trace failure");
    }
  });

  try {
    assert.throws(
      () => installLogBrewPinoInstrumentation({ client }),
      (error) => error instanceof SdkError && error.code === "configuration_error"
    );
    assert.doesNotThrow(() => publishPino("not json\n", 30));
    assert.doesNotThrow(() => publishPino(`${JSON.stringify({ level: 30, msg: "still captured" })}\n`, 30));
    assert.equal(client.pendingEvents(), 1);
    assert.equal(errors, 2);
  } finally {
    instrumentation.uninstall();
  }
});

function publishPino(result, level, instance = {}) {
  pinoEndChannel.publish({
    instance,
    arguments: [{}, "", level, Date.now()],
    result
  });
}

function sampleClient() {
  return LogBrewClient.create({
    apiKey: "LOGBREW_API_KEY",
    automaticDelivery: false,
    sdkName: "pino-instrumentation-test",
    sdkVersion: "0.1.0"
  });
}
