# @logbrew/sdk

Public JavaScript SDK for creating LogBrew event batches, validating them locally, and flushing them through a transport.

## Install

```bash
npm install @logbrew/sdk
pnpm add @logbrew/sdk
npm --prefix node_modules/@logbrew/sdk/examples run
npm --prefix node_modules/@logbrew/sdk/examples run list
npm --prefix node_modules/@logbrew/sdk/examples run help
npm --prefix node_modules/@logbrew/sdk/examples run readme-example
npm --prefix node_modules/@logbrew/sdk/examples run readme-example:cjs
npm --prefix node_modules/@logbrew/sdk/examples run real-user-smoke
npm --prefix node_modules/@logbrew/sdk/examples run real-user-smoke:cjs
pnpm --dir node_modules/@logbrew/sdk/examples run
pnpm --dir node_modules/@logbrew/sdk/examples run list
pnpm --dir node_modules/@logbrew/sdk/examples run help
pnpm --dir node_modules/@logbrew/sdk/examples run readme-example
pnpm --dir node_modules/@logbrew/sdk/examples run readme-example:cjs
pnpm --dir node_modules/@logbrew/sdk/examples run real-user-smoke
pnpm --dir node_modules/@logbrew/sdk/examples run real-user-smoke:cjs
node node_modules/@logbrew/sdk/examples/index.mjs --help
node node_modules/@logbrew/sdk/examples/index.mjs --list
node node_modules/@logbrew/sdk/examples/index.mjs readme-example
node node_modules/@logbrew/sdk/examples/index.mjs readme-example:cjs
node node_modules/@logbrew/sdk/examples/index.mjs real-user-smoke
node node_modules/@logbrew/sdk/examples/index.mjs
node node_modules/@logbrew/sdk/examples/index.mjs real-user-smoke:cjs
node node_modules/@logbrew/sdk/examples/readme-example.mjs
node node_modules/@logbrew/sdk/examples/readme-example.cjs
node node_modules/@logbrew/sdk/examples/real-user-smoke.mjs
node node_modules/@logbrew/sdk/examples/real-user-smoke.cjs
```

The package supports both ESM `import` and CommonJS `require`.
The shipped package also includes `.d.ts` and `.d.cts` declarations so ESM and CommonJS TypeScript consumers can install it directly without a separate build step.
The packed tarball and installed package both ship `README.md`, package metadata, an explicit ESM/CommonJS `exports` map, runnable `examples/readme-example.mjs`, `examples/readme-example.cjs`, `examples/real-user-smoke.mjs`, and `examples/real-user-smoke.cjs` files, a tiny `examples/package.json` helper surface, a packaged `examples/index.mjs` launcher, declaration comments in `index.d.ts`, and the CommonJS `index.d.cts` declaration path that TypeScript-aware tools can inspect. Those packed and installed README, example, and declaration surfaces should still include the normal `npm` and `pnpm` install commands, the fake `LOGBREW_API_KEY` placeholder guidance, the `previewJson()` usage note, the optional `parseTraceparent()`, `createTraceparent()`, `spanAttributesFromTraceparent()`, `installLogBrewConsoleCapture()`, `createLogBrewPinoDestination()`, and `createLogBrewWinstonTransport()` guidance, the helper discovery commands, helper runtime commands, and launcher commands shown above, and the typed API docs for shapes like `ReleaseAttributes`, `SpanAttributes`, `MetricAttributes`, `TraceparentContext`, `TraceparentInput`, `TraceparentSpanInput`, `Event`, `ConsoleCaptureConfig`, `ConsoleCaptureHandle`, `PinoDestinationConfig`, `PinoDestinationHandle`, `PinoLogRecord`, `WinstonTransportConfig`, `WinstonTransportHandle`, `WinstonLogInfo`, `SdkError`, `TransportError`, `TransportResponse`, `alwaysAccept()`, `lastBody()`, `pendingEvents()`, `flush()`, and `shutdown()`. Real installs should also start from a package-manager-native app bootstrap, using `npm init -y` on the npm path and `pnpm init` on the pnpm path, then rewrite the temp app `package.json` dependencies plus the lockfiles so they point back to the packed `.tgz` with the expected file target and integrity metadata, while npm’s own `npm pack --dry-run --json` and `npm pack --json` outputs still report the expected tarball name, integrity, shasum, and file list, and those generated lockfiles should retain that same tarball integrity value before recreating the install through `npm ci` and `pnpm install --frozen-lockfile`. The temp app should also survive a package-manager-native removal step, with `npm uninstall @logbrew/sdk` and `pnpm remove @logbrew/sdk` dropping the SDK from `package.json`, the top-level installed-package list, and `node_modules` before the tarball is added back. The consumer graph should also stay explicit in package-manager-native output, with plain `npm ls @logbrew/sdk` and `pnpm ls @logbrew/sdk` showing the direct installed SDK tree a user reads in the terminal, `npm explain @logbrew/sdk` showing the direct root-project edge, `pnpm why @logbrew/sdk` showing the temp app dependency relationship, plain `npm list --depth=0` and `pnpm list --depth=0` showing the top-level installed dependency summary, and `npm list --json --depth=0` plus `pnpm list --json --depth=0` still listing the temp app and direct installed dependencies, while small installed-user script entries in the temp app still exercise the shipped package through `npm run` and `pnpm run`, including a TypeScript typecheck script that compiles both an ESM `.ts` consumer and a CommonJS `.cts` consumer plus a script that mirrors the published README example before and after reinstall. The installed package should also let a consumer run the shipped README-style and stronger happy-path ESM and CommonJS example files directly from `node_modules/@logbrew/sdk/examples/`, and it now ships a small Node launcher at `node node_modules/@logbrew/sdk/examples/index.mjs` so users can discover packaged examples through `--help`, list them through `--list`, run the default no-argument `real-user-smoke` path, or select named examples like `readme-example` and `real-user-smoke` without going through package-manager scripts. The helper commands in `node_modules/@logbrew/sdk/examples/package.json` should still be discoverable enough that plain `npm --prefix node_modules/@logbrew/sdk/examples run` and `pnpm --dir node_modules/@logbrew/sdk/examples run` list the available example entrypoints before users run `npm --prefix node_modules/@logbrew/sdk/examples run help`, where that help output should print copy-pasteable installed-user commands for both npm and pnpm across the README and `real-user-smoke` default, ESM, and CommonJS example paths, including `npm --prefix node_modules/@logbrew/sdk/examples run readme-example` or `pnpm --dir node_modules/@logbrew/sdk/examples run readme-example`, `npm --prefix node_modules/@logbrew/sdk/examples run readme-example:esm` or `pnpm --dir node_modules/@logbrew/sdk/examples run readme-example:esm`, `npm --prefix node_modules/@logbrew/sdk/examples run readme-example:cjs` or `pnpm --dir node_modules/@logbrew/sdk/examples run readme-example:cjs`, `npm --prefix node_modules/@logbrew/sdk/examples run real-user-smoke` or `pnpm --dir node_modules/@logbrew/sdk/examples run real-user-smoke`, `npm --prefix node_modules/@logbrew/sdk/examples run real-user-smoke:esm` or `pnpm --dir node_modules/@logbrew/sdk/examples run real-user-smoke:esm`, and `npm --prefix node_modules/@logbrew/sdk/examples run real-user-smoke:cjs` or `pnpm --dir node_modules/@logbrew/sdk/examples run real-user-smoke:cjs`, while the launcher surface itself should still reveal `node node_modules/@logbrew/sdk/examples/index.mjs --help`, `node node_modules/@logbrew/sdk/examples/index.mjs --list`, `node node_modules/@logbrew/sdk/examples/index.mjs`, `node node_modules/@logbrew/sdk/examples/index.mjs readme-example`, `node node_modules/@logbrew/sdk/examples/index.mjs real-user-smoke`, and `node node_modules/@logbrew/sdk/examples/index.mjs real-user-smoke:cjs`.

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
  createTraceparent,
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

const downstreamTraceparent = createTraceparent({
  traceId: span.traceId,
  spanId: span.spanId,
  traceFlags: "01"
});
await fetch("https://example.invalid/payments", {
  headers: { traceparent: downstreamTraceparent }
});

await client.flush(RecordingTransport.alwaysAccept());
```

The helpers validate the W3C `version-traceId-parentSpanId-traceFlags` shape, reject all-zero trace/span ids, normalize valid ids to lowercase, expose the sampled flag from `traceFlags`, and keep span metadata primitive-only. They do not install OpenTelemetry or patch HTTP clients; use them when you need explicit interop in code you own.

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

The Pino adapter reads JSON log lines, maps `trace`/`debug`/`info`/`warn`/`error`/`fatal` into LogBrew levels, captures primitive Pino fields as `context.*`, captures serialized error name/message, skips noisy runtime defaults, and omits stack text unless `includeErrorStack: true` is set. It does not patch Pino or replace application logger ownership.

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

The Winston adapter receives Winston `info` objects, maps `debug`/`silly` to `debug`, `warn` to `warning`, `error`/`fatal` to `error`, and other common Winston levels to `info`. It captures primitive info fields as `context.*`, captures nested `err`/`error` objects or formatted error stack name/message, omits stack text unless `includeErrorStack: true` is set, and exposes `onError` for capture failures. It does not mutate Winston globals or replace the app's logger.

Use a clearly fake placeholder like `LOGBREW_API_KEY` in local examples and tests. Call `flush` or `shutdown` to send queued events through a transport, and use `previewJson()` when you want a stable local JSON preview without sending anything.
