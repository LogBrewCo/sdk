# @logbrew/sdk

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

Public JavaScript SDK for creating LogBrew event batches, validating them locally, and flushing them through a transport.

## Install

```bash
npm install @logbrew/sdk
pnpm add @logbrew/sdk
```

The package supports both ESM `import` and CommonJS `require`.
The shipped package also includes `.d.ts` and `.d.cts` declarations so ESM and CommonJS TypeScript consumers can install it directly without a separate build step.
The package ships copyable examples under `node_modules/@logbrew/sdk/examples/`. Use the fake `LOGBREW_API_KEY` placeholder in docs, keep the real key in your app configuration, and call `previewJson()` when you want to inspect queued JSON before sending. Type declarations document payload shapes such as `ReleaseAttributes`, `SpanAttributes`, `MetricAttributes`, transport responses, SDK errors, lifecycle helpers, W3C trace helpers, support-ticket draft helpers, product timeline helpers, console capture, Pino destination, and Winston transport APIs.

After install, discover and run the packaged examples:

```bash
node node_modules/@logbrew/sdk/examples/index.mjs --list
node node_modules/@logbrew/sdk/examples/index.mjs agent-timeline
npm --prefix node_modules/@logbrew/sdk/examples run agent-timeline
```

For Vite apps, add the build-time release-artifact plugin to `vite.config.js`. It enables hidden source maps when your config has not chosen a source-map mode, injects matching Debug IDs after the build, strips embedded source text and local source prefixes, and writes a privacy-bounded manifest next to your output:

```js
import { createLogBrewViteReleaseArtifactsPlugin } from "@logbrew/sdk/vite-release-artifacts";

export default {
  plugins: [
    createLogBrewViteReleaseArtifactsPlugin({
      release: "web@1.2.3",
      environment: "production",
      service: "checkout-web",
      minifiedPathPrefix: "https://cdn.example/assets"
    })
  ]
};
```

The plugin runs only during Vite builds. It does not upload source maps, open support tickets, use account/session API values, or claim backend symbolication support.

The package also ships the dependency-free `logbrew-release-artifacts` command for local JavaScript source-map preparation. Use it in CI after your frontend build to inject matching Debug IDs, strip embedded source text by default, and create a privacy-bounded manifest that can be inspected before any backend upload contract exists:

```bash
npx logbrew-release-artifacts prepare-js \
  --build-dir dist \
  --strip-sources-content \
  --strip-source-prefix "$PWD" \
  --write

npx logbrew-release-artifacts manifest-js \
  --build-dir dist \
  --release web@1.2.3 \
  --environment production \
  --service checkout-web \
  --minified-path-prefix https://cdn.example/assets \
  > logbrew-release-artifacts.json

npx logbrew-release-artifacts symbolicate-js \
  --build-dir dist \
  --manifest logbrew-release-artifacts.json \
  --stack-frame "at checkout (https://cdn.example/assets/app.js:1:1)"

npx logbrew-release-artifacts upload-js \
  --build-dir dist \
  --manifest logbrew-release-artifacts.json \
  --endpoint http://127.0.0.1:4319/release-artifacts \
  --dry-run
```

The command validates local files only. The `symbolicate-js` check resolves one generated stack frame through the prepared manifest so you can catch bad path prefixes, embedded source content, and local source-path leaks before deploy. The `upload-js` check revalidates the manifest and can post the manifest/minified/source-map parts only to a loopback fake intake for local CI transport checks; it rejects non-loopback endpoints until backend-owned release-artifact upload routes exist. It does not upload source maps to LogBrew, open support tickets, use account/session API values, or claim backend symbolication support.

## Example

```js
import { LogBrewClient, RecordingTransport } from "@logbrew/sdk";

const client = LogBrewClient.create({
  apiKey: "LOGBREW_API_KEY",
  sdkName: "logbrew-js",
  sdkVersion: "0.1.0"
});

client.release("evt_release_001", "2026-06-02T10:00:00Z", {
  version: "1.2.3",
  commit: "abc123def456",
  notes: "Public release marker"
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

console.log(client.previewJson());

const transport = RecordingTransport.alwaysAccept();
const response = await client.shutdown(transport);
console.error(JSON.stringify({ ok: true, status: response.statusCode, attempts: response.attempts, events: 6 }));
```

## Explicit Metrics

Use `client.metric()` when application code already knows the measurement name, value, unit, and aggregation shape. Metrics are queued like other events and are not collected automatically.

```js
client.metric("evt_metric_001", "2026-06-02T10:00:06Z", {
  name: "checkout.requests",
  kind: "counter",
  value: 42,
  unit: "{request}",
  temporality: "delta",
  metadata: { service: "checkout" }
});
```

Metric `kind` must be `counter`, `gauge`, or `histogram`. Counters and histograms must be non-negative and use `delta` or `cumulative` temporality; gauges use `instant` temporality and may be negative. Keep metric metadata primitive and low-cardinality, such as service, region, or route template.

## W3C Trace Context

Use `parseTraceparent()`, `createTraceparent()`, and `spanAttributesFromTraceparent()` when a JavaScript service needs to continue trace context from OpenTelemetry-compatible services or pass a W3C `traceparent` value downstream.

```js
import {
  createTraceContextHeaders,
  createTraceparentHeaders,
  LogBrewClient,
  RecordingTransport,
  spanAttributesFromTraceparent
} from "@logbrew/sdk";

const client = LogBrewClient.create({
  apiKey: "LOGBREW_API_KEY",
  sdkName: "checkout-api",
  sdkVersion: "1.0.0"
});

const incomingTraceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const span = spanAttributesFromTraceparent(incomingTraceparent, {
  name: "POST /checkout",
  spanId: "b7ad6b7169203331",
  status: "ok",
  durationMs: 18.4,
  events: [{ name: "cache.lookup", metadata: { hit: false, system: "redis" } }],
  links: [{
    traceId: "11111111111111111111111111111111",
    spanId: "2222222222222222",
    sampled: true,
    metadata: { relation: "batch_item" }
  }],
  metadata: { service: "checkout" }
});
client.span("evt_checkout_span", "2026-06-02T10:00:04Z", span);

await fetch("https://example.invalid/payments", {
  headers: createTraceparentHeaders({
    traceId: span.traceId,
    spanId: span.spanId,
    traceFlags: "01"
  })
});

await fetch("https://example.invalid/fulfillment", {
  headers: createTraceContextHeaders({
    traceId: span.traceId,
    spanId: span.spanId,
    traceFlags: "01",
    tracestate: [{ key: "rojo", value: "00f067aa0ba902b7" }],
    baggage: [{ key: "release", value: "checkout@1.2.3" }]
  })
});

await client.flush(RecordingTransport.alwaysAccept());
```

The helpers validate the W3C `version-traceId-parentSpanId-traceFlags` shape, reject all-zero trace/span ids, normalize valid ids to lowercase, expose the sampled flag from `traceFlags`, and keep span metadata primitive-only. Optional span `events` record up to eight low-cardinality milestones with optional timestamps and primitive metadata only. Optional span `links` record up to eight privacy-bounded references to related trace/span IDs for batch, fan-out, queue, or retry workflows. `createTraceparentHeaders()` returns an explicit outbound carrier with only `traceparent`. `parseTracestate()`, `createTracestate()`, `parseBaggage()`, `createBaggage()`, and `createTraceContextHeaders()` add opt-in W3C `tracestate` and `baggage` propagation with bounded entry counts and header sizes. The helpers do not install OpenTelemetry, patch HTTP clients, infer baggage/tracestate automatically, or capture payloads; use them when you need explicit interop in code you own.

If your app already installs OpenTelemetry JS, use `logbrewTraceContextFromCurrentOpenTelemetrySpan()` to copy the current active OTel span into a LogBrew child trace before recording logs, spans, or actions:

```js
import {
  LogBrewClient,
  logbrewTraceContextFromCurrentOpenTelemetrySpan
} from "@logbrew/sdk";

const client = LogBrewClient.create({
  apiKey: "LOGBREW_API_KEY",
  sdkName: "checkout-web",
  sdkVersion: "1.0.0"
});

const trace = logbrewTraceContextFromCurrentOpenTelemetrySpan();
if (trace) {
  client.log("evt_checkout_log", "2026-06-02T10:00:03Z", {
    message: "checkout step rendered",
    level: "info",
    logger: "checkout",
    metadata: {
      release: "checkout@1.2.3",
      environment: "production",
      traceId: trace.traceId,
      spanId: trace.spanId,
      parentSpanId: trace.parentSpanId,
      sampled: trace.sampled
    }
  });
}
```

The OpenTelemetry helpers also accept explicit `spanContext` and `span` objects through `logbrewTraceContextFromOpenTelemetrySpanContext()` and `logbrewTraceContextFromOpenTelemetrySpan()`. They duck-type the public OTel shape, return `null` when OpenTelemetry is absent or invalid, create a fresh LogBrew child span ID by default, and copy only valid trace ID, parent span ID, and sampled state.

If your app already owns an OpenTelemetry provider, `createLogBrewOpenTelemetrySpanProcessor()` can convert ended OTel `ReadableSpan` objects into queued LogBrew spans without making LogBrew own your provider, exporter, or instrumentation setup:

```js
import { SpanKind } from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import {
  createLogBrewOpenTelemetrySpanProcessor,
  LogBrewClient,
  RecordingTransport
} from "@logbrew/sdk";

const client = LogBrewClient.create({
  apiKey: "LOGBREW_API_KEY",
  sdkName: "checkout-api",
  sdkVersion: "1.0.0"
});
const processor = createLogBrewOpenTelemetrySpanProcessor({
  client,
  transport: RecordingTransport.alwaysAccept(),
  eventAttributeKeys: ["cache.hit"],
  includeTraceSummary: true,
  linkAttributeKeys: ["messaging.operation.name"],
  metadata: { release: "checkout@1.2.3", environment: "production" }
});
const provider = new BasicTracerProvider({ spanProcessors: [processor] });
const tracer = provider.getTracer("checkout-api");

const span = tracer.startSpan("GET /orders/:id", {
  kind: SpanKind.CLIENT,
  attributes: {
    "http.request.method": "GET",
    "http.response.status_code": 200,
    "http.route": "/orders/:id"
  }
});
span.addEvent("cache.lookup", { "cache.hit": false });
span.end();

await processor.forceFlush();
```

If your OpenTelemetry setup already uses standard processors such as `SimpleSpanProcessor` or `BatchSpanProcessor`, use `createLogBrewOpenTelemetrySpanExporter()` instead:

```js
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
  createLogBrewOpenTelemetrySpanExporter,
  LogBrewClient,
  RecordingTransport
} from "@logbrew/sdk";

const client = LogBrewClient.create({
  apiKey: "LOGBREW_API_KEY",
  sdkName: "checkout-api",
  sdkVersion: "1.0.0"
});
const exporter = createLogBrewOpenTelemetrySpanExporter({
  client,
  transport: RecordingTransport.alwaysAccept(),
  includeTraceSummary: true,
  metadata: { release: "checkout@1.2.3", environment: "production" }
});
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)]
});
```

The OTel processor and exporter follow normal OTel sampled-span behavior by default and summarize up to eight span events and eight links. Set `includeTraceSummary: true` when you also want one synthetic `opentelemetry.trace:<root-name>` span per trace on processor `forceFlush()`/`shutdown()` or exporter `export()`/`forceFlush()`/`shutdown()`; the summary carries the trace ID, span count, error count, root span ID/name/kind, duration, and safe service/environment/route metadata so a batch reads like one request or transaction. They copy only a small safe default set such as service, environment, route, method, status code, span kind, instrumentation scope, exception type, and dropped-count metadata. Additional event/link/span/resource attributes require explicit allowlists, and high-risk keys such as full URLs, headers, query strings, payloads, cookies, private auth values, DB statements, exception messages, and stacks stay blocked. Concurrent flush calls share the same in-flight send to avoid duplicate payloads. These helpers do not add an OpenTelemetry dependency, patch clients, own tracer providers, serialize baggage or tracestate, copy raw propagation headers, or capture request/response bodies.

LogBrew severity categories are `info`, `warning`, `error`, and `critical`. The JavaScript SDK accepts common runtime aliases such as `trace`, `debug`, `warn`, and `fatal` for compatibility, then serializes canonical values before queued events are sent. The shared mapping is documented in the [LogBrew severity contract](../../docs/severity-contract.md).

## Event Filtering

Use `eventFilter` when your app needs a last-mile privacy or sampling gate before events enter the in-memory queue. The filter receives a copy of the already validated event, so severity aliases are already canonical and mutations inside the callback do not alter queued payloads. Return `false` to drop an event; return `true` or nothing to keep it.

```js
const client = LogBrewClient.create({
  apiKey: "LOGBREW_API_KEY",
  sdkName: "checkout-api",
  sdkVersion: "1.0.0",
  eventFilter(event) {
    if (event.type === "log" && event.attributes.level === "info") {
      return false;
    }
    return true;
  }
});
```

Prefer removing sensitive values at the source before calling LogBrew. `eventFilter` is intentionally drop-only: it avoids broad mutable event processing, global scopes, and hidden context that can make observability payloads harder to reason about.

## Queue Bounds

`LogBrewClient` keeps a bounded in-memory queue so heavy logging bursts cannot grow without limit before the next flush. The default `maxQueueSize` is 1000 events. When the queue is full, LogBrew drops the incoming event, keeps already queued events unchanged, increments `droppedEvents()`, and calls `onEventDropped` if provided.

```js
const client = LogBrewClient.create({
  apiKey: "LOGBREW_API_KEY",
  sdkName: "checkout-api",
  sdkVersion: "1.0.0",
  maxQueueSize: 500,
  onEventDropped(drop) {
    console.warn("LogBrew dropped telemetry", drop.reason, drop.eventType);
  }
});
```

Drop callbacks are advisory and must not interrupt application logging. This is not offline persistence; flush regularly and use app-owned retry/shutdown handling for production delivery.

## Flush Failures

`flush()` keeps queued events when delivery fails. A `401` transport response raises `SdkError` with code `unauthenticated`; a `429` response raises code `rate_limited` and includes `retryAfterMs` when the transport exposes a `Retry-After` delay. LogBrew does not derive account usage locally, sleep in the SDK, or drop queued events on rate limits; the app can decide when to retry or ask the backend-owned usage/quota APIs for current account state.

## Support Ticket Drafts

Use `createSupportTicketDraft()` when a developer or support agent needs a local JSON payload for the planned LogBrew support-ticket API. The helper validates the public source/category contract, converts JavaScript camelCase inputs to the planned backend create payload fields, and redacts token-like diagnostics before returning the object.

```js
import { createSupportTicketDraft } from "@logbrew/sdk";

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
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  eventId: "evt_checkout_flush",
  diagnostics: {
    attemptCount: 2,
    retryable: false,
    endpoint: "https://api.example/ingest?debug=true",
    apiKey: "redacted by helper"
  }
});

console.log(JSON.stringify(draft, null, 2));
```

This helper does not send data, open support tickets, call `POST /api/support/tickets`, use account/session API credentials, or infer backend usage/quota state. Support routes are backend-owned and should only be called by an explicit user or agent action after backend reports deployed support-ticket routes. Diagnostics are bounded to JSON-like values; auth values, cookies, tokens, local paths, URL origins, hidden payloads, and unsupported objects are redacted or omitted.

## Agent-Readable Timelines

Use `createProductActionAttributes()` and `createNetworkMilestoneAttributes()` when a service already knows important product steps or API milestones. The helpers create normal `action` event attributes with primitive metadata that can be analyzed across many sessions without visual replay, global HTTP patching, payload capture, or header capture.

```js
import {
  createNetworkMilestoneAttributes,
  createProductActionAttributes,
  LogBrewClient
} from "@logbrew/sdk";

const client = LogBrewClient.create({
  apiKey: "LOGBREW_API_KEY",
  sdkName: "checkout-api",
  sdkVersion: "1.0.0"
});

client.action("evt_checkout_submit", new Date().toISOString(), createProductActionAttributes({
  name: "checkout.submit",
  status: "running",
  sessionId: "sess_123",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  routeTemplate: "/checkout/:step",
  funnel: "checkout",
  step: "submit",
  metadata: { service: "checkout" }
}));

client.action("evt_payment_api", new Date().toISOString(), createNetworkMilestoneAttributes({
  routeTemplate: "/payments/:id",
  method: "POST",
  statusCode: 202,
  durationMs: 94,
  sessionId: "sess_123",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  metadata: { service: "checkout" }
}));
```

Timeline helpers keep only primitive metadata, strip query strings and hashes from route templates, normalize HTTP methods, infer failed network milestones from status codes `400` and above, and serialize through the existing `action` event type. Keep metadata low-cardinality, such as `sessionId`, `traceId`, `routeTemplate`, `method`, `statusCode`, `durationMs`, `screen`, `funnel`, and `step`.

The packaged `agent-timeline` example shows a two-event checkout timeline that an AI assistant can inspect without session replay or payload capture. It combines product action metadata, network milestone metadata, explicit `traceparent` propagation, and a drop-only `eventFilter` that removes low-value info logs:

```bash
node node_modules/@logbrew/sdk/examples/index.mjs agent-timeline
node node_modules/@logbrew/sdk/examples/index.mjs agent-timeline:cjs
```

## Console Capture

If an app already uses `console.info()`, `console.warn()`, or `console.error()`, install explicit capture on the console object you own:

```js
import { installLogBrewConsoleCapture, LogBrewClient, RecordingTransport } from "@logbrew/sdk";

const client = LogBrewClient.create({
  apiKey: "LOGBREW_API_KEY",
  sdkName: "checkout-web",
  sdkVersion: "1.0.0"
});
const transport = RecordingTransport.alwaysAccept();
const capture = installLogBrewConsoleCapture({
  client,
  console,
  transport,
  levels: ["warn", "error"],
  logger: "console",
  metadata: { service: "checkout" }
});

console.warn("cart queued", { orderId: 42 });
console.error("checkout failed", new Error("database unavailable"));
await capture.flush();
capture.uninstall();
```

Console capture is opt-in. It calls the original console method first, captures only the configured levels, returns `uninstall()` so apps can stop capture cleanly, and omits error stack text unless `includeErrorStack: true` is set.

## Pino Destination

If a Node app already uses Pino, pass the dependency-free LogBrew destination as Pino's output stream:

```js
import pino from "pino";
import { createLogBrewPinoDestination, LogBrewClient, RecordingTransport } from "@logbrew/sdk";

const client = LogBrewClient.create({
  apiKey: "LOGBREW_API_KEY",
  sdkName: "checkout-api",
  sdkVersion: "1.0.0"
});
const transport = RecordingTransport.alwaysAccept();
const destination = createLogBrewPinoDestination({
  client,
  transport,
  logger: "pino",
  metadata: { service: "checkout" }
});

const logger = pino(destination);
logger.warn({ orderId: 42 }, "checkout slow");
logger.error(new Error("payment failed"), "checkout failed");
await destination.flush();
```

The Pino adapter reads JSON log lines, maps Pino `trace`/`debug` to LogBrew `info`, `warn` to `warning`, `error` to `error`, and `fatal` to `critical`, captures primitive Pino fields as `context.*`, captures serialized error name/message, skips noisy runtime defaults, and omits stack text unless `includeErrorStack: true` is set. It does not patch Pino or replace application logger ownership.

When the app also uses a LogBrew Node or framework request helper, pass `traceProvider: getActiveLogBrewTrace` from `@logbrew/node` to add the current active `traceId`, `spanId`, optional `parentSpanId`, and `sampled` flag to each captured log. The provider is called per record, invalid or missing contexts are ignored, and no raw propagation headers, request data, payloads, or stack traces are captured.

## Winston Transport

If a Node app already uses Winston, add the dependency-free LogBrew transport to the app-owned logger:

```js
import winston from "winston";
import { createLogBrewWinstonTransport, LogBrewClient, RecordingTransport } from "@logbrew/sdk";

const client = LogBrewClient.create({
  apiKey: "LOGBREW_API_KEY",
  sdkName: "checkout-api",
  sdkVersion: "1.0.0"
});
const transport = RecordingTransport.alwaysAccept();
const logbrewTransport = createLogBrewWinstonTransport({
  client,
  transport,
  logger: "winston",
  metadata: { service: "checkout" }
});

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(winston.format.errors({ stack: true }), winston.format.timestamp()),
  transports: [logbrewTransport]
});

logger.warn("checkout slow", { orderId: 42 });
logger.error(new Error("payment failed"));
await logbrewTransport.flush();
```

The Winston adapter receives Winston `info` objects, maps `debug`/`silly` to LogBrew `info`, `warn` to `warning`, `error` to `error`, `fatal`/`critical` to `critical`, and other common Winston levels to `info`. It captures primitive info fields as `context.*`, captures nested `err`/`error` objects or formatted error stack name/message, omits stack text unless `includeErrorStack: true` is set, and exposes `onError` for capture failures. It does not mutate Winston globals or replace the app's logger.

Use the same `traceProvider: getActiveLogBrewTrace` option with LogBrew Node/framework helpers when you want Winston logs to carry the active request trace. The adapter only copies normalized W3C-shaped IDs and sampled state; it does not patch Winston globally or serialize arbitrary active context.

Use a clearly fake placeholder like `LOGBREW_API_KEY` in examples. Call `flush` or `shutdown` to send queued events through a transport, and use `previewJson()` when you want a stable local JSON preview before sending anything.
