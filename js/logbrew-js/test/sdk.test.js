import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import {
  createNetworkMilestoneAttributes,
  createProductActionAttributes,
  createSupportTicketDraft,
  createTraceparent,
  createTraceparentHeaders,
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

function assertEventTypes(payload) {
  assert.deepEqual(payload.events.map((event) => event.type), SUPPORTED_EVENT_TYPES);
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

async function captureRejection(callback) {
  try {
    await callback();
  } catch (error) {
    return error;
  }
  throw new Error("expected callback to reject");
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
    /issue level must be one of: trace, debug, info, warn, warning, error, fatal, critical/
  );
});

test("severity aliases normalize before preview", () => {
  const client = sampleClient();

  client.issue("evt_issue_001", "2026-06-02T10:00:02Z", { title: "Checkout timeout", level: "fatal" });
  client.log("evt_log_001", "2026-06-02T10:00:03Z", { message: "verbose runtime detail", level: "debug" });
  client.log("evt_log_002", "2026-06-02T10:00:04Z", { message: "legacy warning alias", level: "warn" });

  const payload = JSON.parse(client.previewJson());
  assert.deepEqual(
    payload.events.map((event) => event.attributes.level),
    ["critical", "info", "warning"]
  );
});

test("timeline helpers create safe action attributes", () => {
  const action = createProductActionAttributes({
    name: "checkout.submit",
    status: "running",
    sessionId: "sess_123",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    routeTemplate: "https://app.example/checkout/:step?email=user@example.com#pay",
    screen: "Checkout",
    funnel: "checkout",
    step: "submit",
    metadata: { service: "checkout", ignoredObject: { nested: true } }
  }, {
    metadata: { region: "global" }
  });
  const network = createNetworkMilestoneAttributes({
    routeTemplate: "https://api.example/v1/orders/:id?debug=true#trace",
    method: "post",
    statusCode: 503,
    durationMs: 82.5,
    sessionId: "sess_123",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    metadata: { service: "checkout", ignoredArray: ["ignored"] }
  }, {
    metadata: { region: "global" }
  });

  assert.deepEqual(action, {
    name: "checkout.submit",
    status: "running",
    metadata: {
      source: "product.action",
      region: "global",
      service: "checkout",
      routeTemplate: "/checkout/:step",
      sessionId: "sess_123",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      screen: "Checkout",
      funnel: "checkout",
      step: "submit"
    }
  });
  assert.deepEqual(network, {
    name: "network.post /v1/orders/:id",
    status: "failure",
    metadata: {
      source: "network.milestone",
      region: "global",
      service: "checkout",
      routeTemplate: "/v1/orders/:id",
      method: "POST",
      statusCode: 503,
      durationMs: 82.5,
      sessionId: "sess_123",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736"
    }
  });
});

test("timeline helpers reject unsafe milestone values", () => {
  const cases = [
    [() => createProductActionAttributes({ name: "checkout.submit", status: "done" }), /product action status must be one of: queued, running, success, failure/],
    [() => createNetworkMilestoneAttributes({ routeTemplate: "/orders/:id", method: "GET /bad" }), /network milestone method must be a valid HTTP method/],
    [() => createNetworkMilestoneAttributes({ routeTemplate: "/orders/:id", durationMs: -1 }), /network milestone durationMs must be a non-negative number/],
    [() => createNetworkMilestoneAttributes({ routeTemplate: "/orders/:id", statusCode: 99 }), /network milestone statusCode must be an integer from 100 to 599/]
  ];
  for (const [run, pattern] of cases) {
    assert.throws(run, pattern);
  }
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

test("span events serialize bounded primitive metadata", () => {
  const client = sampleClient();
  client.span("evt_span_001", "2026-06-02T10:00:04Z", {
    name: "postgresql SELECT orders.select_by_id",
    traceId: "trace_001",
    spanId: "span_001",
    status: "error",
    durationMs: 33,
    events: [
      {
        name: "db.pool.wait",
        timestamp: "2026-06-02T10:00:04Z",
        metadata: {
          attempt: 1,
          ignoredObject: { nested: true },
          phase: "before_query",
          retryable: false
        }
      },
      {
        name: "exception",
        metadata: {
          exceptionEscaped: true,
          exceptionMessage: ["should not serialize"],
          exceptionType: "TypeError"
        }
      }
    ],
    metadata: { service: "checkout" }
  });

  const payload = JSON.parse(client.previewJson());
  assert.deepEqual(payload.events[0].attributes.events, [
    {
      name: "db.pool.wait",
      timestamp: "2026-06-02T10:00:04Z",
      metadata: {
        attempt: 1,
        phase: "before_query",
        retryable: false
      }
    },
    {
      name: "exception",
      metadata: {
        exceptionEscaped: true,
        exceptionType: "TypeError"
      }
    }
  ]);
});

test("too many span events fail validation", () => {
  const client = sampleClient();
  assert.throws(
    () => client.span("evt_span_many_events", "2026-06-02T10:00:04Z", {
      name: "GET /health",
      traceId: "trace_001",
      spanId: "span_001",
      status: "ok",
      events: Array.from({ length: 9 }, (_, index) => ({ name: `step.${index}` }))
    }),
    /span events must contain at most 8 entries/
  );
});

test("traceparent span helper preserves safe span events", () => {
  const span = spanAttributesFromTraceparent(
    "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    {
      name: "GET /orders/:id",
      spanId: "b7ad6b7169203331",
      status: "ok",
      events: [
        {
          name: "cache.lookup",
          metadata: {
            hit: false,
            ignored: { nested: true },
            system: "redis"
          }
        }
      ]
    }
  );

  assert.deepEqual(span.events, [
    {
      name: "cache.lookup",
      metadata: {
        hit: false,
        system: "redis"
      }
    }
  ]);
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

test("rate-limited response surfaces retry-after without retrying", async () => {
  const client = sampleClient();
  enqueueAll(client);
  const transport = new RecordingTransport([{ statusCode: 429, retryAfterMs: 120_000 }]);

  const error = await captureRejection(() => client.flush(transport));

  assert.equal(error instanceof SdkError, true);
  assert.equal(error.code, "rate_limited");
  assert.equal(error.retryAfterMs, 120_000);
  assert.equal(error.message, "transport rate limited the batch");
  assert.equal(client.pendingEvents(), EXPECTED_EVENT_COUNT);
  assert.equal(transport.sentBodies.length, 1);
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

test("bounded queue reports overflow without mutating queued events", () => {
  const dropped = [];
  const client = LogBrewClient.create({
    apiKey: "LOGBREW_API_KEY",
    sdkName: "logbrew-js",
    sdkVersion: "0.1.0",
    maxQueueSize: 2,
    onEventDropped(drop) {
      dropped.push(drop);
    }
  });

  client.log("evt_queue_001", "2026-06-02T10:00:00Z", { message: "first", level: "info" });
  client.log("evt_queue_002", "2026-06-02T10:00:01Z", { message: "second", level: "warning" });
  client.log("evt_queue_003", "2026-06-02T10:00:02Z", { message: "third", level: "error" });

  const payload = JSON.parse(client.previewJson());
  assert.deepEqual(payload.events.map((event) => event.id), ["evt_queue_001", "evt_queue_002"]);
  assert.equal(client.pendingEvents(), 2);
  assert.equal(client.droppedEvents(), 1);
  assert.deepEqual(dropped, [{
    droppedEvents: 1,
    eventId: "evt_queue_003",
    eventType: "log",
    reason: "queue_overflow"
  }]);
});

test("invalid queue bound fails client configuration", () => {
  assert.throws(
    () => LogBrewClient.create({
      apiKey: "LOGBREW_API_KEY",
      sdkName: "logbrew-js",
      sdkVersion: "0.1.0",
      maxQueueSize: 0
    }),
    /maxQueueSize must be a positive integer/
  );
});

test("SDK error ignores unsafe optional retry-after details", () => {
  const nullDetails = new SdkError("transport_error", "transport failed", null);
  const negativeDelay = new SdkError("rate_limited", "transport rate limited the batch", { retryAfterMs: -1 });

  assert.equal(nullDetails.retryAfterMs, undefined);
  assert.equal(negativeDelay.retryAfterMs, undefined);
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
  assert.equal(typeof sdk.createProductActionAttributes, "function");
  assert.equal(typeof sdk.createNetworkMilestoneAttributes, "function");
  assert.equal(typeof sdk.createSupportTicketDraft, "function");
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
    createTraceparentHeaders({
      traceId: context.traceId,
      spanId: "b7ad6b7169203331",
      traceFlags: "00"
    }),
    {
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-00"
    }
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

test("support ticket draft creates planned payload and redacts diagnostics", () => {
  const draft = createSupportTicketDraft({
    source: "sdk",
    category: "ingest_failure",
    title: "Telemetry flush failed",
    description: "Flush returned usage_limit_exceeded",
    projectId: "proj_123",
    environment: "production",
    runtime: "node@22",
    framework: "express",
    sdkPackage: "@logbrew/sdk",
    sdkVersion: "0.1.3",
    release: "checkout@1.2.3",
    traceId: "4BF92F3577B34DA6A3CE929D0E0E4736",
    eventId: "evt_checkout_flush",
    diagnostics: {
      attemptCount: 2,
      retryable: false,
      apiKey: ["lbw", "ingest", "hidden"].join("_"),
      endpoint: "https://api.example/ingest?debug=true#frag",
      localPath: "/Users/example/app/.env",
      error: new Error("contains hidden message"),
      headers: {
        authorization: ["Bearer", "hidden"].join(" "),
        cookie: "sid=hidden",
        accept: "application/json"
      },
      events: [
        { id: "evt_checkout_flush", type: "span" },
        { token: "hidden" }
      ],
      callback: () => "ignored"
    }
  });

  assert.deepEqual(draft, {
    source: "sdk",
    category: "ingest_failure",
    title: "Telemetry flush failed",
    description: "Flush returned usage_limit_exceeded",
    project_id: "proj_123",
    environment: "production",
    runtime: "node@22",
    framework: "express",
    sdk_package: "@logbrew/sdk",
    sdk_version: "0.1.3",
    release: "checkout@1.2.3",
    trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
    event_id: "evt_checkout_flush",
    diagnostics: {
      attemptCount: 2,
      retryable: false,
      apiKey: "[redacted]",
      endpoint: "[redacted-url]/ingest",
      localPath: "[redacted-path]",
      error: { name: "Error" },
      headers: {
        authorization: "[redacted]",
        cookie: "[redacted]",
        accept: "application/json"
      },
      events: [
        { id: "evt_checkout_flush", type: "span" },
        { token: "[redacted]" }
      ]
    }
  });
  const serialized = JSON.stringify(draft);
  assert.equal(serialized.includes("hidden"), false);
  assert.equal(serialized.includes("api.example"), false);
  assert.equal(serialized.includes("/Users/example"), false);
  assert.equal(serialized.includes("traceparent"), false);
});

test("support ticket draft rejects invalid route-owned values", () => {
  assert.throws(
    () => createSupportTicketDraft({
      source: "daemon",
      category: "ingest_failure",
      title: "Telemetry failed",
      description: "Flush failed"
    }),
    /support ticket source must be one of: cli, sdk, website, docs, mobile/
  );
  assert.throws(
    () => createSupportTicketDraft({
      source: "sdk",
      category: "ingest_failure",
      title: "Telemetry failed",
      description: "Flush failed",
      traceId: "00000000000000000000000000000000"
    }),
    /traceId must not be all zeros/
  );
  assert.throws(
    () => createSupportTicketDraft({
      source: "sdk",
      category: "ingest_failure",
      title: "Telemetry failed",
      description: "Flush failed",
      diagnostics: ["not", "an", "object"]
    }),
    /support ticket diagnostics must be an object/
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
  assert.equal(logbrewLevelFromConsoleMethod("debug"), "info");
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
    level: 60,
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
  assert.deepEqual(body.events.map((event) => event.attributes.level), ["info", "critical"]);
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
