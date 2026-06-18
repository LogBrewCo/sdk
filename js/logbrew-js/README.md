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
The package ships copyable examples under `node_modules/@logbrew/sdk/examples/`. Use the fake `LOGBREW_API_KEY` placeholder in docs, keep the real key in your app configuration, and call `previewJson()` when you want to inspect queued JSON before sending. Type declarations document payload shapes such as `ReleaseAttributes`, `SpanAttributes`, `MetricAttributes`, transport responses, SDK errors, lifecycle helpers, W3C trace helpers, product timeline helpers, console capture, Pino destination, and Winston transport APIs.

After install, discover and run the packaged examples:

```bash
node node_modules/@logbrew/sdk/examples/index.mjs --list
node node_modules/@logbrew/sdk/examples/index.mjs agent-timeline
npm --prefix node_modules/@logbrew/sdk/examples run agent-timeline
```

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
  --minified-path-prefix https://cdn.example/assets
```

The command validates local files only. It does not upload source maps, open support tickets, use account/session API values, or claim backend symbolication support.

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

await client.flush(RecordingTransport.alwaysAccept());
```

The helpers validate the W3C `version-traceId-parentSpanId-traceFlags` shape, reject all-zero trace/span ids, normalize valid ids to lowercase, expose the sampled flag from `traceFlags`, and keep span metadata primitive-only. `createTraceparentHeaders()` returns an explicit outbound carrier with only `traceparent`. The helpers do not install OpenTelemetry or patch HTTP clients; use them when you need explicit interop in code you own.

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

Use a clearly fake placeholder like `LOGBREW_API_KEY` in examples. Call `flush` or `shutdown` to send queued events through a transport, and use `previewJson()` when you want a stable local JSON preview before sending anything.
