import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import {
  createIssueAttributesFromError,
  createNetworkMilestoneAttributes,
  createProductActionAttributes,
  createLogBrewOpenTelemetrySpanExporter,
  createLogBrewOpenTelemetrySpanProcessor,
  createSupportTicketDraft,
  createBaggage,
  createTraceparent,
  createTraceContextHeaders,
  createTracestate,
  createTraceparentHeaders,
  createLogBrewPinoDestination,
  createLogBrewWinstonTransport,
  installLogBrewConsoleCapture,
  LogBrewClient,
  logbrewTraceContextFromCurrentOpenTelemetrySpan,
  logbrewTraceContextFromOpenTelemetrySpan,
  logbrewTraceContextFromOpenTelemetrySpanContext,
  logAttributesFromConsoleArgs,
  logAttributesFromPinoRecord,
  logAttributesFromWinstonInfo,
  logbrewLevelFromConsoleMethod,
  parseBaggage,
  parseTraceparent,
  parseTracestate,
  RecordingTransport,
  SdkError,
  spanAttributesFromOpenTelemetryReadableSpan,
  spanAttributesFromTraceparent,
  TransportError
} from "../index.js";

const SUPPORTED_EVENT_TYPES = ["release", "environment", "issue", "log", "span", "action"];
const EXPECTED_EVENT_COUNT = SUPPORTED_EVENT_TYPES.length;
const LOGGER_TRACE = {
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "b7ad6b7169203331",
  parentSpanId: "00f067aa0ba902b7",
  sampled: true
};

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

function sampleOpenTelemetryReadableSpan(overrides = {}) {
  return {
    name: "GET /orders/:id",
    kind: 2,
    spanContext: () => ({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "b7ad6b7169203331",
      traceFlags: 1
    }),
    parentSpanContext: {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: 1
    },
    startTime: [1780000000, 100000000],
    endTime: [1780000000, 225000000],
    duration: [0, 125000000],
    status: { code: 1 },
    attributes: {
      "db.statement": "select * from users where api_key = 'redacted'",
      "http.request.method": "GET",
      "http.response.status_code": 200,
      "http.route": "/orders/:id",
      "url.full": "https://api.example/orders/42?api_key=redacted#frag"
    },
    events: [
      {
        name: "exception",
        time: [1780000000, 160000000],
        attributes: {
          "exception.escaped": false,
          "exception.message": "contains private payload",
          "exception.stacktrace": "private stack",
          "exception.type": "TypeError"
        }
      },
      {
        name: "cache.lookup",
        time: [1780000000, 180000000],
        attributes: {
          "cache.hit": false,
          "cache.key": "private-cache-key"
        }
      }
    ],
    links: [
      {
        context: {
          traceId: "11111111111111111111111111111111",
          spanId: "2222222222222222",
          traceFlags: 1
        },
        attributes: {
          "http.url": "https://api.example/internal?api_key=redacted",
          "messaging.operation.name": "process"
        }
      }
    ],
    resource: {
      attributes: {
        "deployment.environment.name": "production",
        "host.name": "private-host",
        "service.name": "checkout"
      }
    },
    instrumentationScope: {
      name: "@opentelemetry/instrumentation-http",
      version: "1.2.3"
    },
    droppedAttributesCount: 1,
    droppedEventsCount: 2,
    droppedLinksCount: 3,
    ended: true,
    ...overrides
  };
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

test("createIssueAttributesFromError attaches privacy-bounded release artifact metadata", () => {
  const error = new TypeError("Checkout exploded");
  error.stack = [
    "TypeError: Checkout exploded",
    "    at checkout (https://cdn.example/assets/app.js?debug=true#section:12:34)",
    "    at ignored (https://cdn.example/assets/vendor.js?debug=true#section:1:2)"
  ].join("\n");

  const attributes = createIssueAttributesFromError(error, {
    debugIdMap: {
      "https://cdn.example/assets/app.js": "11111111-2222-4333-8444-555555555555"
    },
    environment: "production",
    metadata: { routeTemplate: "/checkout", ignoredObject: { nested: true } },
    release: "web@2026.07.03",
    runtime: "browser",
    service: "checkout-web",
    trace: LOGGER_TRACE
  });

  assert.deepEqual(attributes, {
    title: "TypeError",
    level: "error",
    message: "Checkout exploded",
    stackFrames: [
      {
        filename: "https://cdn.example/assets/app.js",
        line: 12,
        column: 34,
        debugId: "11111111-2222-4333-8444-555555555555"
      },
      {
        filename: "https://cdn.example/assets/vendor.js",
        line: 1,
        column: 2
      }
    ],
    metadata: {
      source: "javascript.error",
      routeTemplate: "/checkout",
      errorName: "TypeError",
      errorMessage: "Checkout exploded",
      errorFrameFile: "https://cdn.example/assets/app.js",
      errorFrameLine: 12,
      errorFrameColumn: 34,
      issueGroupingKey: "javascript.error:TypeError:https://cdn.example/assets/app.js",
      issueGroupingSource: "error_type_and_frame",
      release: "web@2026.07.03",
      environment: "production",
      service: "checkout-web",
      runtime: "browser",
      traceId: LOGGER_TRACE.traceId,
      spanId: LOGGER_TRACE.spanId,
      parentSpanId: LOGGER_TRACE.parentSpanId,
      sampled: true,
      releaseArtifactType: "sourcemap",
      releaseArtifactCodeFile: "https://cdn.example/assets/app.js",
      releaseArtifactDebugId: "11111111-2222-4333-8444-555555555555"
    }
  });

  const serialized = JSON.stringify(attributes);
  assert.doesNotMatch(serialized, /debug=true|section|ignoredObject|nested/u);
  assert.doesNotMatch(serialized, /errorStack/u);

  const client = sampleClient();
  client.issue("evt_multi_frame", "2026-07-17T12:00:00Z", attributes);
  const queued = JSON.parse(client.previewJson()).events[0].attributes;
  assert.deepEqual(queued.stackFrames, attributes.stackFrames);
});

test("createIssueAttributesFromError bounds and sanitizes structured stack frames", () => {
  const error = new Error("Bounded stack");
  error.stack = [
    "Error: Bounded stack",
    ...Array.from(
      { length: 40 },
      (_, index) => `    at frame${index} (C:\\workspace\\app\\src\\frame-${index}.js?debug=value#fragment:${index + 1}:2)`
    )
  ].join("\n");

  const attributes = createIssueAttributesFromError(error);

  assert.equal(attributes.stackFrames.length, 32);
  assert.deepEqual(attributes.stackFrames[0], {
    filename: "frame-0.js",
    line: 1,
    column: 2
  });
  assert.deepEqual(attributes.stackFrames[31], {
    filename: "frame-31.js",
    line: 32,
    column: 2
  });
  assert.equal(attributes.metadata.errorFrameFile, "frame-0.js");
  assert.doesNotMatch(JSON.stringify(attributes), /C:\\workspace|debug=value|fragment|frame-32/u);
});

test("createIssueAttributesFromError omits non-UUID release artifact Debug IDs", () => {
  const error = new Error("Invalid Debug ID");
  error.stack = "Error: Invalid Debug ID\n    at checkout (app:///assets/app.js:12:34)";

  const attributes = createIssueAttributesFromError(error, {
    debugIdMap: { "app:///assets/app.js": "not-a-debug-id" }
  });

  assert.equal(attributes.stackFrames[0].debugId, undefined);
  assert.equal(attributes.metadata.releaseArtifactDebugId, undefined);
});

test("issue stack frames reject non-string filenames", () => {
  const client = sampleClient();

  assert.throws(
    () => client.issue("evt_invalid_stack", "2026-07-17T12:00:00Z", {
      title: "Invalid stack",
      level: "error",
      stackFrames: [{ filename: { local: true }, line: 1, column: 2 }]
    }),
    (error) => error instanceof SdkError && error.code === "validation_error"
  );
});

test("createIssueAttributesFromError supports explicit privacy-bounded grouping fingerprint", () => {
  const error = new Error("payment failed for user dev@example.test order 12345");
  error.stack = [
    "Error: payment failed for user dev@example.test order 12345",
    "    at submit (https://cdn.example/assets/checkout.js?email=dev@example.test#retry:8:9)"
  ].join("\n");

  const attributes = createIssueAttributesFromError(error, {
    fingerprint: "checkout-payment-submit",
    metadata: {
      ignoredObject: { nested: true }
    },
    source: "browser.error"
  });

  assert.equal(attributes.metadata.issueFingerprint, "checkout-payment-submit");
  assert.equal(attributes.metadata.issueGroupingKey, "browser.error:Error:https://cdn.example/assets/checkout.js");
  assert.equal(attributes.metadata.issueGroupingSource, "explicit_fingerprint");
  assert.equal(attributes.metadata.ignoredObject, undefined);

  const serializedGroupingMetadata = JSON.stringify({
    issueFingerprint: attributes.metadata.issueFingerprint,
    issueGroupingKey: attributes.metadata.issueGroupingKey,
    issueGroupingSource: attributes.metadata.issueGroupingSource
  });
  assert.doesNotMatch(serializedGroupingMetadata, /dev@example|12345|email=|retry|ignoredObject|nested/u);
});

test("createIssueAttributesFromError summarizes cause chains without cause messages or stacks", () => {
  const low = new TypeError("low wrapped detail for dynamic-user-marker");
  low.stack = "TypeError: low wrapped detail\n    at low (/tmp/local/low.js:1:2)";
  const mid = new RangeError("middle checkout numeric-marker-12345");
  mid.cause = low;
  mid.stack = "RangeError: middle checkout numeric-marker-12345\n    at mid (/tmp/local/mid.js:3:4)";
  const side = new SyntaxError("side opaque-marker-abc123");
  const error = new AggregateError([mid, side], "top checkout failed", {
    cause: new URIError("wrapped callback dynamic-user-marker")
  });

  const attributes = createIssueAttributesFromError(error);

  assert.equal(attributes.metadata.errorCauseCount, 4);
  assert.equal(attributes.metadata.errorCauseTypes, "URIError,RangeError,TypeError,SyntaxError");
  assert.equal(attributes.metadata.errorCauseSources, "cause,errors[0],cause,errors[1]");
  assert.equal(attributes.metadata.errorExceptionGroup, true);
  assert.equal(attributes.metadata.errorCauseTruncated, undefined);

  const serializedCauseMetadata = JSON.stringify({
    errorCauseCount: attributes.metadata.errorCauseCount,
    errorCauseTypes: attributes.metadata.errorCauseTypes,
    errorCauseSources: attributes.metadata.errorCauseSources,
    errorExceptionGroup: attributes.metadata.errorExceptionGroup
  });
  assert.doesNotMatch(serializedCauseMetadata, /wrapped detail|dynamic-user-marker|12345|abc123|local|stack/u);
});

test("createIssueAttributesFromError caps cause chain summaries", () => {
  class Cause0 extends Error {}
  class Cause1 extends Error {}
  class Cause2 extends Error {}
  class Cause3 extends Error {}
  class Cause4 extends Error {}
  class Cause5 extends Error {}
  class Cause6 extends Error {}

  const causeTypes = [Cause0, Cause1, Cause2, Cause3, Cause4, Cause5, Cause6];
  const error = new Error("root");
  let cursor = error;
  for (let index = 0; index < 7; index += 1) {
    const CauseType = causeTypes[index];
    const next = new CauseType(`cause ${index}`);
    cursor.cause = next;
    cursor = next;
  }

  const attributes = createIssueAttributesFromError(error);

  assert.equal(attributes.metadata.errorCauseCount, 5);
  assert.equal(attributes.metadata.errorCauseTypes, "Cause0,Cause1,Cause2,Cause3,Cause4");
  assert.equal(attributes.metadata.errorCauseSources, "cause,cause,cause,cause,cause");
  assert.equal(attributes.metadata.errorCauseTruncated, true);
});

test("createIssueAttributesFromError avoids arbitrary non-error cause names", () => {
  const error = new Error("root");
  error.cause = {
    name: "dynamicUserMarker123",
    message: "nested detail should not copy"
  };

  const attributes = createIssueAttributesFromError(error);

  assert.equal(attributes.metadata.errorCauseCount, 1);
  assert.equal(attributes.metadata.errorCauseTypes, "Object");
  assert.equal(attributes.metadata.errorCauseSources, "cause");
  assert.doesNotMatch(JSON.stringify(attributes.metadata), /dynamicUserMarker123|nested detail/u);
});

test("createIssueAttributesFromError omits local paths and stack text by default", () => {
  const error = new Error("Local build failed");
  error.stack = [
    "Error: Local build failed",
    "    at compile (/Users/example/private/project/dist/app.js:4:5)"
  ].join("\n");

  const attributes = createIssueAttributesFromError(error, {
    debugIdMap: {
      "/Users/example/private/project/dist/app.js": "22222222-3333-4444-8555-666666666666"
    },
    metadata: { flow: "build" }
  });

  assert.equal(attributes.metadata.errorFrameFile, "app.js");
  assert.equal(attributes.metadata.issueGroupingKey, "javascript.error:Error:app.js");
  assert.equal(attributes.metadata.releaseArtifactCodeFile, "app.js");
  assert.equal(attributes.metadata.releaseArtifactDebugId, "22222222-3333-4444-8555-666666666666");

  const serialized = JSON.stringify(attributes);
  assert.doesNotMatch(serialized, /\/Users\/example|private\/project|errorStack/u);
});

test("createIssueAttributesFromError includes stack only when explicitly requested", () => {
  const error = new Error("Stack allowed");
  error.stack = "Error: Stack allowed\n    at allowed (app:///assets/app.js:1:2)";

  const attributes = createIssueAttributesFromError(error, {
    includeErrorStack: true
  });

  assert.equal(attributes.metadata.errorStack, error.stack);
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

test("span links serialize bounded primitive metadata", () => {
  const client = sampleClient();
  client.span("evt_span_with_link", "2026-06-02T10:00:04Z", {
    name: "queue publish email.welcome",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "b7ad6b7169203331",
    status: "ok",
    links: [
      {
        traceId: "11111111111111111111111111111111",
        spanId: "2222222222222222",
        sampled: true,
        metadata: {
          ignoredNested: { nope: true },
          relation: "batch_item",
          shard: 3
        }
      }
    ]
  });

  const payload = JSON.parse(client.previewJson());
  assert.deepEqual(payload.events[0].attributes.links, [
    {
      traceId: "11111111111111111111111111111111",
      spanId: "2222222222222222",
      sampled: true,
      metadata: {
        relation: "batch_item",
        shard: 3
      }
    }
  ]);
});

test("too many span links fail validation", () => {
  const client = sampleClient();
  assert.throws(
    () => client.span("evt_span_many_links", "2026-06-02T10:00:04Z", {
      name: "queue publish email.welcome",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "b7ad6b7169203331",
      status: "ok",
      links: Array.from({ length: 9 }, (_, index) => ({
        traceId: `${String(index + 1).padStart(32, "0")}`,
        spanId: "2222222222222222"
      }))
    }),
    /span links must contain at most 8 entries/
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

test("traceparent span helper preserves safe span links", () => {
  const span = spanAttributesFromTraceparent(
    "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    {
      name: "queue publish email.welcome",
      spanId: "b7ad6b7169203331",
      status: "ok",
      links: [
        {
          traceId: "11111111111111111111111111111111",
          spanId: "2222222222222222",
          sampled: false,
          metadata: {
            ignoredNested: { nope: true },
            relation: "batch_item"
          }
        }
      ]
    }
  );

  assert.deepEqual(span.links, [
    {
      traceId: "11111111111111111111111111111111",
      spanId: "2222222222222222",
      sampled: false,
      metadata: {
        relation: "batch_item"
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
  assert.equal(typeof sdk.createLogBrewOpenTelemetrySpanExporter, "function");
  assert.equal(typeof sdk.logbrewTraceContextFromCurrentOpenTelemetrySpan, "function");
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

test("trace context helpers create explicit tracestate and baggage carriers", () => {
  assert.deepEqual(
    parseTracestate("rojo=00f067aa0ba902b7, congo=t61rcWkgMzE"),
    [
      { key: "rojo", value: "00f067aa0ba902b7" },
      { key: "congo", value: "t61rcWkgMzE" }
    ]
  );
  assert.equal(
    createTracestate([
      { key: "rojo", value: "00f067aa0ba902b7" },
      { key: "congo", value: "t61rcWkgMzE" }
    ]),
    "rojo=00f067aa0ba902b7,congo=t61rcWkgMzE"
  );
  assert.deepEqual(
    parseBaggage("release=checkout%401.2.3, region = eu-west ; sampled=true"),
    [
      { key: "release", value: "checkout@1.2.3" },
      { key: "region", value: "eu-west", properties: ["sampled=true"] }
    ]
  );
  assert.equal(
    createBaggage([
      { key: "release", value: "checkout@1.2.3" },
      { key: "region", value: "eu-west", properties: ["sampled=true"] }
    ]),
    "release=checkout%401.2.3,region=eu-west;sampled=true"
  );
  assert.deepEqual(
    createTraceContextHeaders({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "b7ad6b7169203331",
      traceFlags: "01",
      tracestate: [{ key: "rojo", value: "00f067aa0ba902b7" }],
      baggage: [{ key: "release", value: "checkout@1.2.3" }]
    }),
    {
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01",
      tracestate: "rojo=00f067aa0ba902b7",
      baggage: "release=checkout%401.2.3"
    }
  );
});

test("trace context helpers reject oversized or malformed carriers", () => {
  assert.throws(
    () => createTracestate([{ key: "Vendor", value: "opaque" }]),
    /tracestate key must be lowercase/
  );
  assert.throws(
    () => createTracestate(Array.from({ length: 33 }, (_, index) => ({
      key: `v${index}`,
      value: "opaque"
    }))),
    /tracestate must contain at most 32 entries/
  );
  assert.throws(
    () => createBaggage([{ key: "bad key", value: "value" }]),
    /baggage key must use RFC header-name characters/
  );
  assert.throws(
    () => createBaggage(Array.from({ length: 65 }, (_, index) => ({
      key: `k${index}`,
      value: "v"
    }))),
    /baggage must contain at most 64 entries/
  );
});

test("OpenTelemetry span context helper creates a LogBrew child trace", () => {
  const trace = logbrewTraceContextFromOpenTelemetrySpanContext(
    {
      traceId: "4BF92F3577B34DA6A3CE929D0E0E4736",
      spanId: "00F067AA0BA902B7",
      traceFlags: 1,
      traceState: { raw: "not-copied" }
    },
    { spanId: "b7ad6b7169203331" }
  );

  assert.deepEqual(trace, {
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "b7ad6b7169203331",
    parentSpanId: "00f067aa0ba902b7",
    sampled: true
  });
});

test("OpenTelemetry span helper duck-types span objects and validates child span ids", () => {
  const trace = logbrewTraceContextFromOpenTelemetrySpan(
    {
      spanContext: () => ({
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        traceFlags: 0
      })
    },
    { spanIdFactory: () => "b7ad6b7169203331" }
  );

  assert.deepEqual(trace, {
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "b7ad6b7169203331",
    parentSpanId: "00f067aa0ba902b7",
    sampled: false
  });
  assert.throws(
    () => logbrewTraceContextFromOpenTelemetrySpanContext(
      {
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        traceFlags: 1
      },
      { spanIdFactory: () => "0000000000000000" }
    ),
    /spanId must not be all zeros/
  );
  assert.throws(
    () => logbrewTraceContextFromOpenTelemetrySpan(
      {
        spanContext: () => ({
          traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
          spanId: "00f067aa0ba902b7",
          traceFlags: 1
        })
      },
      { spanId: "bad" }
    ),
    /spanId must be 16/
  );
});

test("OpenTelemetry current span helper uses explicit API seam and returns null for invalid contexts", () => {
  const trace = logbrewTraceContextFromCurrentOpenTelemetrySpan({
    openTelemetryApi: {
      trace: {
        getActiveSpan: () => ({
          spanContext: () => ({
            traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
            spanId: "00f067aa0ba902b7",
            traceFlags: 1
          })
        })
      }
    },
    spanId: "b7ad6b7169203331"
  });

  assert.deepEqual(trace, {
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "b7ad6b7169203331",
    parentSpanId: "00f067aa0ba902b7",
    sampled: true
  });
  assert.equal(
    logbrewTraceContextFromCurrentOpenTelemetrySpan({
      openTelemetryApi: { trace: { getActiveSpan: () => undefined } },
      spanId: "b7ad6b7169203331"
    }),
    null
  );
  assert.equal(
    logbrewTraceContextFromOpenTelemetrySpanContext({
      traceId: "00000000000000000000000000000000",
      spanId: "00f067aa0ba902b7",
      traceFlags: 1
    }),
    null
  );
});

test("OpenTelemetry ReadableSpan helper creates privacy-bounded LogBrew span attributes", () => {
  const span = spanAttributesFromOpenTelemetryReadableSpan(sampleOpenTelemetryReadableSpan(), {
    attributeKeys: ["messaging.operation.name"],
    eventAttributeKeys: ["cache.hit"],
    linkAttributeKeys: ["messaging.operation.name"],
    metadata: { release: "checkout@1.2.3" }
  });

  assert.deepEqual(span, {
    name: "GET /orders/:id",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "b7ad6b7169203331",
    parentSpanId: "00f067aa0ba902b7",
    status: "ok",
    durationMs: 125,
    events: [
      {
        name: "exception",
        timestamp: "2026-05-28T20:26:40.160Z",
        metadata: {
          "exception.escaped": false,
          "exception.type": "TypeError"
        }
      },
      {
        name: "cache.lookup",
        timestamp: "2026-05-28T20:26:40.180Z",
        metadata: {
          "cache.hit": false
        }
      }
    ],
    links: [
      {
        traceId: "11111111111111111111111111111111",
        spanId: "2222222222222222",
        sampled: true,
        metadata: {
          "messaging.operation.name": "process"
        }
      }
    ],
    metadata: {
      source: "opentelemetry.readable_span",
      release: "checkout@1.2.3",
      "deployment.environment.name": "production",
      "service.name": "checkout",
      "otel.kind": "client",
      "otel.scope.name": "@opentelemetry/instrumentation-http",
      "otel.scope.version": "1.2.3",
      "otel.dropped_attributes_count": 1,
      "otel.dropped_events_count": 2,
      "otel.dropped_links_count": 3,
      "otel.exception_event_count": 1,
      "otel.exception_types": "TypeError",
      "http.request.method": "GET",
      "http.response.status_code": 200,
      "http.route": "/orders/:id"
    }
  });
});

test("OpenTelemetry span processor queues bounded spans and flushes without owning OTel setup", async () => {
  const dropped = [];
  const errors = [];
  const client = LogBrewClient.create({
    apiKey: "LOGBREW_API_KEY",
    sdkName: "logbrew-js",
    sdkVersion: "0.1.0",
    maxQueueSize: 1,
    onEventDropped: (event) => dropped.push(event)
  });
  const transport = RecordingTransport.alwaysAccept();
  const processor = createLogBrewOpenTelemetrySpanProcessor({
    client,
    eventIdPrefix: "otel",
    onError: (error) => errors.push(error),
    timestamp: () => "2026-06-02T10:00:04Z",
    transport
  });

  processor.onStart({}, {});
  processor.onEnd(sampleOpenTelemetryReadableSpan());
  processor.onEnd(sampleOpenTelemetryReadableSpan({
    spanContext: () => ({
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      spanId: "bbbbbbbbbbbbbbbb",
      traceFlags: 1
    })
  }));
  processor.onEnd(sampleOpenTelemetryReadableSpan({
    spanContext: () => ({
      traceId: "cccccccccccccccccccccccccccccccc",
      spanId: "dddddddddddddddd",
      traceFlags: 0
    })
  }));

  assert.equal(client.pendingEvents(), 1);
  assert.equal(client.droppedEvents(), 1);
  assert.equal(dropped[0].eventId, "otel_2");
  assert.deepEqual(errors, []);

  await processor.forceFlush();

  assert.equal(client.pendingEvents(), 0);
  const payload = JSON.parse(transport.lastBody());
  assert.equal(payload.events[0].id, "otel_1");
  assert.equal(payload.events[0].timestamp, "2026-05-28T20:26:40.100Z");
  assert.equal(payload.events[0].attributes.metadata.source, "opentelemetry.readable_span");

  await processor.shutdown();
  processor.onEnd(sampleOpenTelemetryReadableSpan());
  assert.equal(client.pendingEvents(), 0);
});

test("OpenTelemetry span processor can emit a trace summary on flush", async () => {
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  const rootSpanId = "00f067aa0ba902b7";
  const childSpanId = "b7ad6b7169203331";
  const client = sampleClient();
  const transport = RecordingTransport.alwaysAccept();
  const processor = createLogBrewOpenTelemetrySpanProcessor({
    client,
    eventIdPrefix: "otel",
    includeTraceSummary: true,
    transport
  });

  processor.onEnd(sampleOpenTelemetryReadableSpan({
    name: "SELECT orders.by_id",
    kind: 0,
    spanContext: () => ({
      traceId,
      spanId: childSpanId,
      traceFlags: 1
    }),
    parentSpanContext: {
      traceId,
      spanId: rootSpanId,
      traceFlags: 1
    },
    startTime: [1780000000, 150000000],
    endTime: [1780000000, 220000000],
    duration: [0, 70000000],
    status: { code: 2 },
    attributes: {
      "db.statement": "select * from users where api_key = 'redacted'",
      "db.system": "postgresql"
    }
  }));
  processor.onEnd(sampleOpenTelemetryReadableSpan({
    name: "GET /orders/:id",
    kind: 1,
    spanContext: () => ({
      traceId,
      spanId: rootSpanId,
      traceFlags: 1
    }),
    parentSpanContext: undefined,
    parentSpanId: undefined,
    startTime: [1780000000, 100000000],
    endTime: [1780000000, 400000000],
    duration: [0, 300000000],
    status: { code: 1 },
    attributes: {
      "http.request.method": "GET",
      "http.response.status_code": 200,
      "http.route": "/orders/:id",
      "url.full": "https://api.example/orders/42?api_key=redacted#frag"
    }
  }));

  await processor.forceFlush();

  const payload = JSON.parse(transport.lastBody());
  assert.equal(payload.events.length, 3);
  const summary = payload.events.find((event) => event.id === "otel_trace_1");
  assert.ok(summary);
  assert.equal(summary.type, "span");
  assert.equal(summary.timestamp, "2026-05-28T20:26:40.100Z");
  assert.deepEqual(summary.attributes, {
    name: "opentelemetry.trace:GET /orders/:id",
    traceId,
    spanId: summary.attributes.spanId,
    status: "error",
    durationMs: 300,
    metadata: {
      source: "opentelemetry.trace_summary",
      "deployment.environment.name": "production",
      "service.name": "checkout",
      "db.system": "postgresql",
      "http.request.method": "GET",
      "http.response.status_code": 200,
      "http.route": "/orders/:id",
      "otel.trace.span_count": 2,
      "otel.trace.error_span_count": 1,
      "otel.trace.exception_event_count": 2,
      "otel.trace.exception_types": "TypeError",
      "otel.trace.root_span_id": rootSpanId,
      "otel.trace.root_name": "GET /orders/:id",
      "otel.trace.root_kind": "server",
      "otel.trace.summary_kind": "rooted"
    }
  });
  assert.match(summary.attributes.spanId, /^[0-9a-f]{16}$/);
  const serializedSummary = JSON.stringify(summary);
  assert.equal(serializedSummary.includes("api_key=redacted"), false);
  assert.equal(serializedSummary.includes("db.statement"), false);
  assert.equal(serializedSummary.includes("url.full"), false);
});

test("OpenTelemetry trace summary records escaped exception event summaries", async () => {
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  const client = sampleClient();
  const transport = RecordingTransport.alwaysAccept();
  const processor = createLogBrewOpenTelemetrySpanProcessor({
    client,
    eventIdPrefix: "otel_exception",
    includeTraceSummary: true,
    transport
  });

  processor.onEnd(sampleOpenTelemetryReadableSpan({
    name: "POST /checkout/:id",
    kind: 1,
    spanContext: () => ({
      traceId,
      spanId: "aaaaaaaaaaaaaaaa",
      traceFlags: 1
    }),
    parentSpanContext: undefined,
    parentSpanId: undefined,
    status: { code: 0 },
    events: [
      ...Array.from({ length: 9 }, (_, index) => ({
        name: `cache.lookup.${index}`,
        time: [1780000000, 100000000 + index],
        attributes: {
          "cache.hit": index % 2 === 0
        }
      })),
      {
        name: "exception",
        time: [1780000000, 170000000],
        attributes: {
          "exception.escaped": true,
          "exception.message": "dynamic-user-marker checkout payload",
          "exception.stacktrace": "opaque stack marker",
          "exception.type": "CheckoutError"
        }
      },
      {
        name: "exception",
        time: [1780000000, 180000000],
        attributes: {
          "exception.escaped": false,
          "exception.message": "ignored nested marker",
          "exception.type": "RetryError"
        }
      }
    ]
  }));

  await processor.forceFlush();

  const payload = JSON.parse(transport.lastBody());
  const span = payload.events.find((event) => event.id === "otel_exception_1");
  const summary = payload.events.find((event) => event.id === "otel_exception_trace_1");
  assert.ok(span);
  assert.ok(summary);
  assert.equal(span.attributes.status, "error");
  assert.equal(span.attributes.metadata["otel.exception_event_count"], 2);
  assert.equal(span.attributes.metadata["otel.exception_escaped_count"], 1);
  assert.equal(span.attributes.metadata["otel.exception_types"], "CheckoutError,RetryError");
  assert.equal(summary.attributes.status, "error");
  assert.equal(summary.attributes.metadata["otel.trace.exception_event_count"], 2);
  assert.equal(summary.attributes.metadata["otel.trace.exception_escaped_count"], 1);
  assert.equal(summary.attributes.metadata["otel.trace.exception_types"], "CheckoutError,RetryError");
  const serializedPayload = JSON.stringify(payload);
  assert.equal(serializedPayload.includes("dynamic-user-marker"), false);
  assert.equal(serializedPayload.includes("opaque stack marker"), false);
  assert.equal(serializedPayload.includes("ignored nested marker"), false);
});

test("OpenTelemetry span processor coalesces concurrent forceFlush calls", async () => {
  const client = LogBrewClient.create({
    apiKey: "LOGBREW_API_KEY",
    sdkName: "logbrew-js",
    sdkVersion: "0.1.0"
  });
  const sends = [];
  const resolvers = [];
  const transport = {
    send(_apiKey, body) {
      sends.push(body);
      return new Promise((resolve) => {
        resolvers.push(() => resolve({ statusCode: 202 }));
      });
    }
  };
  const processor = createLogBrewOpenTelemetrySpanProcessor({
    client,
    transport
  });

  processor.onEnd(sampleOpenTelemetryReadableSpan());
  const firstFlush = processor.forceFlush();
  const secondFlush = processor.forceFlush();

  try {
    assert.equal(sends.length, 1);
  } finally {
    for (const resolve of resolvers) {
      resolve();
    }
    await Promise.allSettled([firstFlush, secondFlush]);
  }
  assert.equal(client.pendingEvents(), 0);
  assert.equal(sends.length, 1);
});

test("OpenTelemetry span exporter exports batches through standard exporter callbacks", async () => {
  const errors = [];
  const client = sampleClient();
  const transport = RecordingTransport.alwaysAccept();
  const exporter = createLogBrewOpenTelemetrySpanExporter({
    client,
    eventIdPrefix: "otel_export",
    includeTraceSummary: true,
    linkAttributeKeys: ["messaging.operation.name"],
    onError: (error) => errors.push(error),
    transport
  });

  const result = await new Promise((resolve) => {
    exporter.export([
      sampleOpenTelemetryReadableSpan(),
      sampleOpenTelemetryReadableSpan({
        spanContext: () => ({
          traceId: "cccccccccccccccccccccccccccccccc",
          spanId: "dddddddddddddddd",
          traceFlags: 0
        })
      })
    ], resolve);
  });

  assert.deepEqual(result, { code: 0 });
  assert.deepEqual(errors, []);
  assert.equal(client.pendingEvents(), 0);

  const payload = JSON.parse(transport.lastBody());
  assert.equal(payload.events.length, 2);
  assert.deepEqual(payload.events.map((event) => event.id), ["otel_export_1", "otel_export_trace_1"]);
  assert.equal(payload.events[0].attributes.metadata.source, "opentelemetry.readable_span");
  assert.equal(payload.events[1].attributes.metadata.source, "opentelemetry.trace_summary");
  assert.equal(payload.events[0].attributes.links[0].metadata["messaging.operation.name"], "process");
  assert.equal(JSON.stringify(payload).includes("api_key=redacted"), false);
  assert.equal(JSON.stringify(payload).includes("db.statement"), false);

  await exporter.shutdown();
  const closedResult = await new Promise((resolve) => {
    exporter.export([sampleOpenTelemetryReadableSpan()], resolve);
  });
  assert.equal(closedResult.code, 1);
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

test("Pino record helper adds explicit trace correlation metadata", () => {
  const attributes = logAttributesFromPinoRecord({
    level: 30,
    msg: "checkout trace",
    orderId: 42
  }, {
    logger: "pino",
    metadata: {
      service: "checkout",
      traceId: "caller-supplied"
    },
    trace: LOGGER_TRACE
  });

  assert.equal(attributes.level, "info");
  assert.equal(attributes.logger, "pino");
  assert.equal(attributes.metadata.service, "checkout");
  assert.equal(attributes.metadata.traceId, LOGGER_TRACE.traceId);
  assert.equal(attributes.metadata.spanId, LOGGER_TRACE.spanId);
  assert.equal(attributes.metadata.parentSpanId, LOGGER_TRACE.parentSpanId);
  assert.equal(attributes.metadata.sampled, true);
  assert.equal(attributes.metadata["context.orderId"], 42);
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

test("Winston info helper adds explicit trace correlation metadata", () => {
  const attributes = logAttributesFromWinstonInfo({
    level: "info",
    message: "checkout trace",
    orderId: 42
  }, {
    logger: "winston",
    metadata: {
      service: "checkout",
      traceId: "caller-supplied"
    },
    trace: LOGGER_TRACE
  });

  assert.equal(attributes.level, "info");
  assert.equal(attributes.logger, "winston");
  assert.equal(attributes.metadata.service, "checkout");
  assert.equal(attributes.metadata.traceId, LOGGER_TRACE.traceId);
  assert.equal(attributes.metadata.spanId, LOGGER_TRACE.spanId);
  assert.equal(attributes.metadata.parentSpanId, LOGGER_TRACE.parentSpanId);
  assert.equal(attributes.metadata.sampled, true);
  assert.equal(attributes.metadata["context.orderId"], 42);
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
