import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

import {
  createTraceparent,
  createLogBrewPinoDestination,
  createLogBrewWinstonTransport,
  installLogBrewConsoleCapture,
  LogBrewClient,
  logAttributesFromConsoleArgs,
  logAttributesFromPinoRecord,
  logAttributesFromWinstonInfo,
  logbrewLevelFromConsoleMethod,
  parseTraceparent,
  RecordingTransport,
  SdkError,
  spanAttributesFromTraceparent,
  TransportError
} from "../index.js";

const SUPPORTED_EVENT_TYPES = ["release", "environment", "issue", "log", "span", "action"];
const EXPECTED_EVENT_COUNT = SUPPORTED_EVENT_TYPES.length;

function parseLastJsonObject(text) {
  const lines = text.trim().split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].startsWith("{")) {
      return JSON.parse(lines.slice(index).join("\n"));
    }
  }
  throw new Error(`no JSON object found in output:\n${text}`);
}

function parseLastJsonLine(text) {
  const lines = text.trim().split("\n").filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].startsWith("{")) {
      return JSON.parse(lines[index]);
    }
  }
  throw new Error(`no JSON line found in output:\n${text}`);
}

function assertEventTypes(payload) {
  assert.deepEqual(payload.events.map((event) => event.type), SUPPORTED_EVENT_TYPES);
}

function assertSuccessSummary(summary) {
  assert.deepEqual(summary, {
    ok: true,
    status: 202,
    attempts: 1,
    events: EXPECTED_EVENT_COUNT
  });
}

function assertCompactSuccessSummary(output) {
  assert.match(
    output,
    new RegExp(`\\{"ok":true,"status":202,"attempts":1,"events":${EXPECTED_EVENT_COUNT}\\}`)
  );
}

function assertOutputIncludesEventTypes(output) {
  for (const eventType of SUPPORTED_EVENT_TYPES) {
    assert.match(output, new RegExp(`"type": "${eventType}"`));
  }
}

function sampleClient() {
  return LogBrewClient.create({
    apiKey: "LOGBREW_API_KEY",
    sdkName: "logbrew-js",
    sdkVersion: "0.1.0",
    maxRetries: 2
  });
}

function enqueueAll(client) {
  client.release("evt_release_001", "2026-06-02T10:00:00Z", {
    version: "1.2.3",
    commit: "abc123def456"
  });
  client.environment("evt_environment_001", "2026-06-02T10:00:01Z", {
    name: "production",
    region: "global"
  });
  client.issue("evt_issue_001", "2026-06-02T10:00:02Z", {
    title: "Checkout timeout",
    level: "error",
    message: "Request timed out after retry budget"
  });
  client.log("evt_log_001", "2026-06-02T10:00:03Z", {
    message: "worker started",
    level: "info",
    logger: "job-runner"
  });
  client.span("evt_span_001", "2026-06-02T10:00:04Z", {
    name: "GET /health",
    traceId: "trace_001",
    spanId: "span_001",
    status: "ok",
    durationMs: 12.5
  });
  client.action("evt_action_001", "2026-06-02T10:00:05Z", {
    name: "deploy",
    status: "success"
  });
}

test("previewJson contains all supported event types", () => {
  const client = sampleClient();
  enqueueAll(client);
  const payload = JSON.parse(client.previewJson());
  assertEventTypes(payload);
});

test("flush success clears the queue", async () => {
  const client = sampleClient();
  enqueueAll(client);
  const transport = RecordingTransport.alwaysAccept();

  const response = await client.flush(transport);

  assert.equal(response.statusCode, 202);
  assert.equal(response.attempts, 1);
  assert.equal(client.pendingEvents(), 0);
  assert.match(transport.lastBody(), /"events"/);
});

test("invalid timestamp fails validation", () => {
  const client = sampleClient();
  assert.throws(
    () => client.log("evt_log_001", "2026-06-02T10:00:03", { message: "worker started", level: "info" }),
    new SdkError("validation_error", "timestamp must include a timezone offset: 2026-06-02T10:00:03")
  );
});

test("invalid issue level fails validation", () => {
  const client = sampleClient();
  assert.throws(
    () => client.issue("evt_issue_001", "2026-06-02T10:00:02Z", { title: "Checkout timeout", level: "verbose" }),
    /issue level must be one of: info, warning, error, critical/
  );
});

test("negative span duration fails validation", () => {
  const client = sampleClient();
  assert.throws(
    () => client.span("evt_span_001", "2026-06-02T10:00:04Z", {
      name: "GET /health",
      traceId: "trace_001",
      spanId: "span_001",
      status: "ok",
      durationMs: -1
    }),
    /span durationMs must be non-negative/
  );
});

test("metric helper validates explicit metric attributes", () => {
  const client = sampleClient();
  client.metric("evt_metric_001", "2026-06-02T10:00:06Z", {
    name: "queue.depth",
    kind: "gauge",
    value: -3,
    unit: "{item}",
    temporality: "instant",
    metadata: { service: "checkout" }
  });

  const payload = JSON.parse(client.previewJson());
  assert.deepEqual(payload.events[0], {
    type: "metric",
    id: "evt_metric_001",
    timestamp: "2026-06-02T10:00:06Z",
    attributes: {
      name: "queue.depth",
      kind: "gauge",
      value: -3,
      unit: "{item}",
      temporality: "instant",
      metadata: { service: "checkout" }
    }
  });
});

test("metric helper rejects unsafe values", () => {
  const client = sampleClient();
  assert.throws(
    () => client.metric("evt_metric_001", "2026-06-02T10:00:06Z", {
      name: "checkout.requests",
      kind: "counter",
      value: Number.NaN,
      unit: "{request}",
      temporality: "delta"
    }),
    /metric value must be a finite number/
  );
  assert.throws(
    () => client.metric("evt_metric_001", "2026-06-02T10:00:06Z", {
      name: "checkout.requests",
      kind: "counter",
      value: -1,
      unit: "{request}",
      temporality: "delta"
    }),
    /metric counter value must be non-negative/
  );
  assert.throws(
    () => client.metric("evt_metric_001", "2026-06-02T10:00:06Z", {
      name: "checkout.queue_depth",
      kind: "gauge",
      value: 3,
      unit: "{item}",
      temporality: "delta"
    }),
    /metric temporality for gauge must be one of: instant/
  );
});

test("unauthenticated response surfaces clean error", async () => {
  const client = sampleClient();
  enqueueAll(client);
  const transport = new RecordingTransport([{ statusCode: 401 }]);

  await assert.rejects(client.flush(transport), /transport rejected the API key/);
  assert.equal(client.pendingEvents(), EXPECTED_EVENT_COUNT);
});

test("network failure retries before succeeding", async () => {
  const client = sampleClient();
  enqueueAll(client);
  const transport = new RecordingTransport([
    TransportError.network("temporary outage"),
    { statusCode: 202 }
  ]);

  const response = await client.flush(transport);

  assert.equal(response.attempts, 2);
  assert.equal(transport.sentBodies.length, 2);
});

test("shutdown flushes and prevents future events", async () => {
  const client = sampleClient();
  enqueueAll(client);
  const transport = RecordingTransport.alwaysAccept();

  await client.shutdown(transport);

  assert.throws(
    () => client.action("evt_action_002", "2026-06-02T10:00:06Z", { name: "deploy", status: "success" }),
    /client is already shut down/
  );
});

test("CommonJS entry exposes the public API", () => {
  const require = createRequire(import.meta.url);
  const sdk = require("../index.cjs");
  const client = sdk.LogBrewClient.create({
    apiKey: "LOGBREW_API_KEY",
    sdkName: "logbrew-js-cjs",
    sdkVersion: "0.1.0"
  });

  client.release("evt_release_001", "2026-06-02T10:00:00Z", {
    version: "1.2.3"
  });

  assert.equal(typeof sdk.RecordingTransport.alwaysAccept, "function");
  assert.equal(typeof sdk.installLogBrewConsoleCapture, "function");
  assert.equal(typeof sdk.parseTraceparent, "function");
  assert.match(client.previewJson(), /"type": "release"/);
});

test("traceparent helpers parse, create, and continue W3C trace context", () => {
  const traceparent = "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01";
  const context = parseTraceparent(traceparent);

  assert.deepEqual(context, {
    version: "00",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    parentSpanId: "00f067aa0ba902b7",
    traceFlags: "01",
    sampled: true
  });
  assert.equal(
    createTraceparent({
      traceId: context.traceId,
      spanId: "b7ad6b7169203331",
      traceFlags: "00"
    }),
    "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-00"
  );
  assert.deepEqual(
    spanAttributesFromTraceparent(traceparent, {
      name: "GET /checkout",
      spanId: "b7ad6b7169203331",
      status: "ok",
      durationMs: 12.5,
      metadata: { service: "checkout", skipped: { nested: true } }
    }),
    {
      name: "GET /checkout",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "b7ad6b7169203331",
      parentSpanId: "00f067aa0ba902b7",
      status: "ok",
      durationMs: 12.5,
      metadata: { service: "checkout" }
    }
  );
});

test("traceparent helpers reject malformed W3C trace context", () => {
  assert.throws(
    () => parseTraceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01"),
    /traceparent traceId must not be all zeros/
  );
  assert.throws(
    () => parseTraceparent("ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"),
    /traceparent version ff is not allowed/
  );
  assert.throws(
    () => createTraceparent({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "0000000000000000"
    }),
    /spanId must not be all zeros/
  );
  assert.throws(
    () => spanAttributesFromTraceparent("not-a-traceparent", {
      name: "GET /checkout",
      spanId: "b7ad6b7169203331",
      status: "ok"
    }),
    /traceparent must use W3C/
  );
});

test("console argument helper maps safe log attributes", () => {
  const error = new TypeError("database unavailable");
  const attributes = logAttributesFromConsoleArgs("warn", ["cart queued", { orderId: 42 }, error], {
    logger: "console",
    metadata: {
      service: "checkout",
      ignoredObject: { nested: true }
    }
  });

  assert.equal(logbrewLevelFromConsoleMethod("log"), "info");
  assert.equal(logbrewLevelFromConsoleMethod("warn"), "warning");
  assert.equal(attributes.level, "warning");
  assert.equal(attributes.logger, "console");
  assert.equal(attributes.message, 'cart queued {"orderId":42} TypeError: database unavailable');
  assert.deepEqual(attributes.metadata, {
    service: "checkout",
    consoleMethod: "warn",
    argumentCount: 3,
    errorName: "TypeError",
    errorMessage: "database unavailable"
  });
});

test("console capture preserves output and uninstalls cleanly", async () => {
  const client = sampleClient();
  const transport = RecordingTransport.alwaysAccept();
  const calls = [];
  const targetConsole = {
    info(...args) {
      calls.push(["info", args]);
    },
    warn(...args) {
      calls.push(["warn", args]);
    },
    error(...args) {
      calls.push(["error", args]);
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

  targetConsole.info("not captured");
  targetConsole.warn("cart queued", 42);
  targetConsole.error("checkout failed", new Error("boom"));
  await handle.flush();
  handle.uninstall();
  targetConsole.warn("after uninstall");

  assert.deepEqual(calls.map(([level]) => level), ["info", "warn", "error", "warn"]);
  assert.equal(client.pendingEvents(), 0);
  assert.equal(transport.sentBodies.length, 1);

  const body = JSON.parse(transport.lastBody());
  assert.deepEqual(
    body.events.map((event) => event.id),
    ["test_console_1", "test_console_2"]
  );
  assert.deepEqual(
    body.events.map((event) => event.attributes.level),
    ["warning", "error"]
  );
  assert.equal(body.events[0].attributes.logger, "console");
  assert.equal(body.events[0].attributes.metadata.service, "checkout");
  assert.equal(body.events[1].attributes.metadata.errorName, "Error");
  assert.equal(body.events[1].attributes.metadata.errorMessage, "boom");
  assert.equal(body.events[1].attributes.metadata.errorStack, undefined);
});

test("Pino record helper maps safe log attributes", () => {
  const attributes = logAttributesFromPinoRecord({
    level: 40,
    time: "2026-06-02T10:00:06.000Z",
    msg: "checkout slow",
    pid: 123,
    [["host", "name"].join("")]: "host.local",
    service: "checkout",
    orderId: 42,
    ignoredObject: { nested: true },
    err: {
      type: "TypeError",
      message: "database unavailable",
      stack: "hidden stack"
    }
  }, {
    logger: "pino",
    metadata: {
      region: "global",
      ignoredObject: { nested: true }
    }
  });

  assert.equal(attributes.level, "warning");
  assert.equal(attributes.logger, "pino");
  assert.equal(attributes.message, "checkout slow");
  assert.deepEqual(attributes.metadata, {
    region: "global",
    pinoLevel: "warn",
    "context.service": "checkout",
    "context.orderId": 42,
    pinoLevelNumber: 40,
    errorName: "TypeError",
    errorMessage: "database unavailable"
  });
});

test("Pino destination queues records and flushes safely", async () => {
  const client = sampleClient();
  const transport = RecordingTransport.alwaysAccept();
  const errors = [];
  const destination = createLogBrewPinoDestination({
    client,
    eventIdPrefix: "test_pino",
    logger: "pino",
    metadata: { service: "checkout" },
    transport,
    onError(error) {
      errors.push(error);
    }
  });

  destination.write(`${JSON.stringify({
    level: 30,
    time: 1780394406000,
    msg: "cart ready",
    orderId: 42
  })}\n`);
  destination.write(`${JSON.stringify({
    level: 50,
    time: "2026-06-02T10:00:06.000Z",
    msg: "checkout failed",
    err: {
      type: "Error",
      message: "boom",
      stack: "hidden stack"
    }
  })}\n`);
  destination.write("not json\n");

  assert.equal(errors.length, 1);
  assert.equal(client.pendingEvents(), 2);
  await destination.flush();
  assert.equal(client.pendingEvents(), 0);
  assert.equal(transport.sentBodies.length, 1);

  const body = JSON.parse(transport.lastBody());
  assert.deepEqual(body.events.map((event) => event.id), ["test_pino_1", "test_pino_2"]);
  assert.deepEqual(body.events.map((event) => event.attributes.level), ["info", "error"]);
  assert.equal(body.events[0].timestamp, "2026-06-02T10:00:06.000Z");
  assert.equal(body.events[0].attributes.metadata["context.orderId"], 42);
  assert.equal(body.events[1].attributes.metadata.errorName, "Error");
  assert.equal(body.events[1].attributes.metadata.errorStack, undefined);
});

test("Winston info helper maps safe log attributes", () => {
  const attributes = logAttributesFromWinstonInfo({
    level: "warn",
    timestamp: "2026-06-02T10:00:06.000Z",
    message: "checkout slow",
    service: "checkout",
    orderId: 42,
    ignoredObject: { nested: true },
    err: {
      name: "TypeError",
      message: "database unavailable",
      stack: "hidden stack"
    }
  }, {
    logger: "winston",
    metadata: {
      region: "global",
      ignoredObject: { nested: true }
    }
  });

  assert.equal(attributes.level, "warning");
  assert.equal(attributes.logger, "winston");
  assert.equal(attributes.message, "checkout slow");
  assert.deepEqual(attributes.metadata, {
    region: "global",
    winstonLevel: "warn",
    "context.service": "checkout",
    "context.orderId": 42,
    errorName: "TypeError",
    errorMessage: "database unavailable"
  });

  const plainErrorAttributes = logAttributesFromWinstonInfo({
    level: "error",
    message: "payment failed",
    stack: "Error: payment failed\n    at checkout.js:1:1"
  });
  assert.equal(plainErrorAttributes.metadata.errorName, "Error");
  assert.equal(plainErrorAttributes.metadata.errorMessage, "payment failed");
  assert.equal(plainErrorAttributes.metadata.errorStack, undefined);
});

test("Winston transport queues info objects and flushes safely", async () => {
  const client = sampleClient();
  const transport = RecordingTransport.alwaysAccept();
  const errors = [];
  const winstonTransport = createLogBrewWinstonTransport({
    client,
    eventIdPrefix: "test_winston",
    logger: "winston",
    metadata: { service: "checkout" },
    transport,
    onError(error) {
      errors.push(error);
    }
  });

  winstonTransport.write({
    level: "info",
    timestamp: new Date("2026-06-02T10:00:06.000Z"),
    message: "cart ready",
    orderId: 42
  });
  winstonTransport.write({
    level: "error",
    timestamp: "2026-06-02T10:00:07.000Z",
    message: "checkout failed",
    stack: "TypeError: payment failed\n    at checkout.js:1:1"
  });
  winstonTransport.write("not an info object");

  assert.equal(errors.length, 1);
  assert.equal(client.pendingEvents(), 2);
  await winstonTransport.flush();
  assert.equal(client.pendingEvents(), 0);
  assert.equal(transport.sentBodies.length, 1);

  const body = JSON.parse(transport.lastBody());
  assert.deepEqual(body.events.map((event) => event.id), ["test_winston_1", "test_winston_2"]);
  assert.deepEqual(body.events.map((event) => event.attributes.level), ["info", "error"]);
  assert.equal(body.events[0].timestamp, "2026-06-02T10:00:06.000Z");
  assert.equal(body.events[0].attributes.metadata["context.orderId"], 42);
  assert.equal(body.events[1].attributes.metadata.errorName, "TypeError");
  assert.equal(body.events[1].attributes.metadata.errorMessage, "payment failed");
  assert.equal(body.events[1].attributes.metadata.errorStack, undefined);
});

test("repo checkout launcher list prints repo commands", () => {
  const result = spawnSync(process.execPath, ["examples/index.mjs", "--list"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assert.deepEqual(result.stdout.trim().split("\n"), [
    "readme-example -> cd js/logbrew-js && node examples/index.mjs readme-example",
    "readme-example:esm -> cd js/logbrew-js && node examples/index.mjs readme-example:esm",
    "readme-example:cjs -> cd js/logbrew-js && node examples/index.mjs readme-example:cjs",
    "real-user-smoke -> cd js/logbrew-js && node examples/index.mjs real-user-smoke",
    "real-user-smoke:esm -> cd js/logbrew-js && node examples/index.mjs real-user-smoke:esm",
    "real-user-smoke:cjs -> cd js/logbrew-js && node examples/index.mjs real-user-smoke:cjs",
    "default (real-user-smoke) -> cd js/logbrew-js && node examples/index.mjs"
  ]);
});

test("repo checkout launcher help prints repo helper and launcher commands", () => {
  const result = spawnSync(process.execPath, ["examples/index.mjs", "--help"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Usage: node examples\/index\.mjs \[--list\] \[example\]/m);
  assert.match(result.stdout, /Run the repo-checkout LogBrew SDK JavaScript examples before install\./);
  assert.match(result.stdout, /default \(real-user-smoke\) -> cd js\/logbrew-js && node examples\/index\.mjs/);
  assert.match(
    result.stdout,
    /readme-example -> cd js\/logbrew-js\/examples && npm run readme-example \| cd js\/logbrew-js\/examples && pnpm run readme-example/
  );
  assert.match(
    result.stdout,
    /real-user-smoke:cjs -> cd js\/logbrew-js\/examples && npm run real-user-smoke:cjs \| cd js\/logbrew-js\/examples && pnpm run real-user-smoke:cjs/
  );
});

test("repo checkout CommonJS README example runs directly", () => {
  const result = spawnSync(process.execPath, ["examples/readme-example.cjs"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assertEventTypes(payload);
  assertSuccessSummary(JSON.parse(result.stderr));
});

test("repo checkout ESM README example runs directly", () => {
  const result = spawnSync(process.execPath, ["examples/readme-example.mjs"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assertEventTypes(payload);
  assertSuccessSummary(JSON.parse(result.stderr));
});

test("repo checkout launcher runs the ESM README example", () => {
  const result = spawnSync(process.execPath, ["examples/index.mjs", "readme-example"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assertEventTypes(payload);
  assertSuccessSummary(JSON.parse(result.stderr));
});

test("repo checkout raw ESM smoke example runs directly", () => {
  const result = spawnSync(process.execPath, ["examples/real-user-smoke.mjs"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.sdk.name, "smoke-app");
  assertEventTypes(payload);
  assertSuccessSummary(JSON.parse(result.stderr));
});

test("repo checkout launcher runs the CommonJS smoke example", () => {
  const result = spawnSync(process.execPath, ["examples/index.mjs", "real-user-smoke:cjs"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assertEventTypes(payload);
  assertSuccessSummary(JSON.parse(result.stderr));
});

test("repo checkout launcher default runs the ESM smoke example", () => {
  const result = spawnSync(process.execPath, ["examples/index.mjs"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.sdk.name, "smoke-app");
  assertEventTypes(payload);
  assertSuccessSummary(JSON.parse(result.stderr));
});

test("repo checkout npm helper discovery lists available scripts", () => {
  const result = spawnSync("npm", ["run"], {
    cwd: new URL("../examples", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Scripts available in .* via `npm run-script`:/);
  assert.match(result.stdout, /\bhelp\b\s*\n\s+node \.\/index\.mjs --help/);
  assert.match(result.stdout, /\blist\b\s*\n\s+node \.\/index\.mjs --list/);
  assert.match(result.stdout, /\breadme-example\b\s*\n\s+node \.\/index\.mjs readme-example/);
  assert.match(result.stdout, /\breal-user-smoke\b\s*\n\s+node \.\/index\.mjs real-user-smoke/);
});

test("repo checkout npm helper list prints launcher commands", () => {
  const result = spawnSync("npm", ["run", "list"], {
    cwd: new URL("../examples", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /> node \.\/index\.mjs --list/);
  assert.match(result.stdout, /readme-example -> cd js\/logbrew-js && node examples\/index\.mjs readme-example/);
  assert.match(result.stdout, /real-user-smoke:cjs -> cd js\/logbrew-js && node examples\/index\.mjs real-user-smoke:cjs/);
  assert.match(result.stdout, /default \(real-user-smoke\) -> cd js\/logbrew-js && node examples\/index\.mjs/);
});

test("repo checkout npm helper help prints helper and launcher commands", () => {
  const result = spawnSync("npm", ["run", "help"], {
    cwd: new URL("../examples", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /> node \.\/index\.mjs --help/);
  assert.match(result.stdout, /^Usage: node examples\/index\.mjs \[--list\] \[example\]/m);
  assert.match(result.stdout, /Run the repo-checkout LogBrew SDK JavaScript examples before install\./);
  assert.match(
    result.stdout,
    /readme-example -> cd js\/logbrew-js\/examples && npm run readme-example \| cd js\/logbrew-js\/examples && pnpm run readme-example/
  );
  assert.match(
    result.stdout,
    /real-user-smoke:cjs -> cd js\/logbrew-js\/examples && npm run real-user-smoke:cjs \| cd js\/logbrew-js\/examples && pnpm run real-user-smoke:cjs/
  );
});

test("repo checkout npm helper runs the ESM README example", () => {
  const result = spawnSync("npm", ["run", "readme-example"], {
    cwd: new URL("../examples", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  const payload = parseLastJsonObject(result.stdout);
  assertEventTypes(payload);
  assertSuccessSummary(parseLastJsonLine(result.stderr));
});

test("repo checkout npm helper runs the ESM smoke example", () => {
  const result = spawnSync("npm", ["run", "real-user-smoke"], {
    cwd: new URL("../examples", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  const payload = parseLastJsonObject(result.stdout);
  assert.equal(payload.sdk.name, "smoke-app");
  assertEventTypes(payload);
  assertSuccessSummary(parseLastJsonLine(result.stderr));
});

test("repo checkout npm helper runs the CommonJS README example", () => {
  const result = spawnSync("npm", ["run", "readme-example:cjs"], {
    cwd: new URL("../examples", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  const payload = parseLastJsonObject(result.stdout);
  assertEventTypes(payload);
  assertSuccessSummary(parseLastJsonLine(result.stderr));
});

test("repo checkout npm helper runs the CommonJS smoke example", () => {
  const result = spawnSync("npm", ["run", "real-user-smoke:cjs"], {
    cwd: new URL("../examples", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  const payload = parseLastJsonObject(result.stdout);
  assert.equal(payload.sdk.name, "smoke-app-cjs");
  assertEventTypes(payload);
  assertSuccessSummary(parseLastJsonLine(result.stderr));
});

test("repo checkout pnpm helper runs the CommonJS smoke example", () => {
  const result = spawnSync("pnpm", ["run", "real-user-smoke:cjs"], {
    cwd: new URL("../examples/", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /"name": "smoke-app-cjs"/);
  assertOutputIncludesEventTypes(result.stdout);
  assertCompactSuccessSummary(`${result.stdout}${result.stderr}`);
});

test("repo checkout pnpm helper discovery lists available scripts", () => {
  const result = spawnSync("pnpm", ["run"], {
    cwd: new URL("../examples/", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Commands available via "pnpm run":/);
  assert.match(result.stdout, /\bhelp\b\s*\n\s+node \.\/index\.mjs --help/);
  assert.match(result.stdout, /\blist\b\s*\n\s+node \.\/index\.mjs --list/);
  assert.match(result.stdout, /\breadme-example\b\s*\n\s+node \.\/index\.mjs readme-example/);
  assert.match(result.stdout, /\breal-user-smoke\b\s*\n\s+node \.\/index\.mjs real-user-smoke/);
});

test("repo checkout pnpm helper list prints launcher commands", () => {
  const result = spawnSync("pnpm", ["run", "list"], {
    cwd: new URL("../examples/", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /readme-example -> cd js\/logbrew-js && node examples\/index\.mjs readme-example/);
  assert.match(result.stdout, /real-user-smoke:cjs -> cd js\/logbrew-js && node examples\/index\.mjs real-user-smoke:cjs/);
  assert.match(result.stdout, /default \(real-user-smoke\) -> cd js\/logbrew-js && node examples\/index\.mjs/);
});

test("repo checkout pnpm helper help prints helper and launcher commands", () => {
  const result = spawnSync("pnpm", ["run", "help"], {
    cwd: new URL("../examples/", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Usage: node examples\/index\.mjs \[--list\] \[example\]/m);
  assert.match(result.stdout, /Run the repo-checkout LogBrew SDK JavaScript examples before install\./);
  assert.match(
    result.stdout,
    /readme-example -> cd js\/logbrew-js\/examples && npm run readme-example \| cd js\/logbrew-js\/examples && pnpm run readme-example/
  );
  assert.match(
    result.stdout,
    /real-user-smoke:cjs -> cd js\/logbrew-js\/examples && npm run real-user-smoke:cjs \| cd js\/logbrew-js\/examples && pnpm run real-user-smoke:cjs/
  );
});

test("repo checkout pnpm helper runs the CommonJS README example", () => {
  const result = spawnSync("pnpm", ["run", "readme-example:cjs"], {
    cwd: new URL("../examples/", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /"name": "logbrew-js"/);
  assertOutputIncludesEventTypes(result.stdout);
  assertCompactSuccessSummary(`${result.stdout}${result.stderr}`);
});

test("repo checkout pnpm helper runs the ESM README example", () => {
  const result = spawnSync("pnpm", ["run", "readme-example"], {
    cwd: new URL("../examples/", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /"name": "logbrew-js"/);
  assertOutputIncludesEventTypes(result.stdout);
  assertCompactSuccessSummary(`${result.stdout}${result.stderr}`);
});

test("repo checkout pnpm helper runs the ESM smoke example", () => {
  const result = spawnSync("pnpm", ["run", "real-user-smoke"], {
    cwd: new URL("../examples/", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /"name": "smoke-app"/);
  assertOutputIncludesEventTypes(result.stdout);
  assertCompactSuccessSummary(`${result.stdout}${result.stderr}`);
});
