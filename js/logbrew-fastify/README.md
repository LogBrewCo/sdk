# @logbrew/fastify

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

Fastify plugin helpers for the public LogBrew JavaScript SDK.

This package is intentionally thin. It adds Fastify request lifecycle UX while keeping event validation, retry, flush, and shutdown behavior in `@logbrew/sdk`.

## Install

```bash
npm install @logbrew/sdk @logbrew/node @logbrew/fastify fastify
pnpm add @logbrew/sdk @logbrew/node @logbrew/fastify fastify
```

Set `LOGBREW_SERVER_API_KEY` to a project-scoped server ingest key before starting
the app.

If you are automating setup, follow the same safe path as a person.
Do not ask a person to paste an ingest key.
Do not treat a missing environment variable as a reason to stop setup.
First run `logbrew status --json`. When it reports approved authentication,
create a temporary project and key with the commands below.
Continue without a browser handoff. Confirm authenticated readback, and then
archive the project.
Only stop for account authentication when the status command reports that no
approved authentication is available.

## Create a Project and Confirm Hosted Delivery

Use LogBrew CLI 0.1.32 or newer with approved account authentication to create
the project. This requires no dashboard sign-in. The destination key file must
not already exist. The CLI creates it with owner-only permissions and never
prints the one-time key or its file path.

```bash
logbrew status --json
install -d -m 700 "$HOME/.logbrew"

project_result="$(
  logbrew projects create fastify-service \
    --runtime node \
    --environment development \
    --ingest-key-file "$HOME/.logbrew/fastify-service.ingest" \
    --json
)"
export LOGBREW_PROJECT_ID="$(jq -er '.project.id' <<<"$project_result")"
unset project_result
export LOGBREW_SERVER_API_KEY="$(< "$HOME/.logbrew/fastify-service.ingest")"
```

Start the app after registering the plugin below, then request one safe route
that your app already owns. For example:

```bash
curl --fail http://127.0.0.1:3000/health

logbrew doctor --project "$LOGBREW_PROJECT_ID" --json
logbrew read logs --project "$LOGBREW_PROJECT_ID" \
  --search "GET /health" \
  --since 1h \
  --json
```

A successful ingest response proves submission. The authenticated read proves
that the event is indexed for the same project. If you no longer need the
temporary project, archive it and remove its revoked one-time key file:

```bash
unset LOGBREW_SERVER_API_KEY
logbrew projects archive "$LOGBREW_PROJECT_ID" --yes --json
rm -f "$HOME/.logbrew/fastify-service.ingest"
unset LOGBREW_PROJECT_ID
```

## Request Plugin

```js
import Fastify from "fastify";
import { logbrewFastifyPlugin } from "@logbrew/fastify";

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    redact: ["authorization", "cookie", "password", "token"]
  }
});

await app.register(logbrewFastifyPlugin, {
  serverApiKey: process.env.LOGBREW_SERVER_API_KEY,
  captureApplicationLogs: true,
  onCaptureError(error) {
    console.error("LogBrew request capture failed", error);
  },
  onApplicationLogCaptureError(error) {
    console.error("LogBrew application-log capture failed", error);
  }
});

app.get("/health", async (request) => {
  request.log.info({ routeTemplate: "/health" }, "health check reached");
  return { ok: true };
});
```

With no `transport` option, the plugin sends to the LogBrew ingest API by default
through `@logbrew/node`. You can pass `endpoint`, `fetchImpl`, or `headers` to
configure that fetch transport, or pass an explicit LogBrew `Transport`.
Delivery failures call `onCaptureError`; they are never converted into a
simulated successful response.

Use `serverApiKey` directly for local server examples, or set `LOGBREW_SERVER_API_KEY` in your server environment and omit it. `apiKey` and `LOGBREW_API_KEY` are still accepted for compatibility with the lower-level JavaScript SDK. Automatic request and error metadata records the path without query text by default.

`RecordingTransport` remains available from `@logbrew/sdk` when you want to
inspect serialized events locally. It does not send data to LogBrew; use the
default Node fetch transport for production telemetry:

```js
import { RecordingTransport } from "@logbrew/sdk";

const previewTransport = RecordingTransport.alwaysAccept();
await app.register(logbrewFastifyPlugin, {
  serverApiKey: "local-preview-key",
  transport: previewTransport
});
```

## Existing Fastify/Pino Application Logs

Set `captureApplicationLogs: true` on the same plugin registration to capture existing `app.log` and `request.log` calls. The plugin owns a separate automatically delivered Node client, preserves Fastify's original Pino stream or transport (including `pino-pretty`), filters Fastify's built-in request lifecycle records so the request hook remains the single request event, and flushes/uninstalls capture during Fastify close.

This opt-in requires Fastify logging to be enabled, Node.js 18.19 or newer, and Pino 9.11+ or 10.1+. Registration fails with an actionable configuration error when Fastify's logger is disabled or its Pino version is too old; request-only capture continues to support the package's normal Fastify and Node ranges.

Primitive structured fields become bounded LogBrew metadata. Credentials, cookies, bodies, payloads, query fields, raw URLs, propagation headers, local file paths, and stack text are excluded automatically. Keep normal Pino redaction enabled because the log message itself is telemetry.

`onApplicationLogCaptureError` observes advisory delivery or conversion failures without interrupting Pino or app shutdown. Use `applicationLogClient` or `applicationLogTransport` for an app-owned delivery boundary. For custom filtering, metadata, or explicit stack policy, use the lower-level `installLogBrewPinoInstrumentation()` API documented by [`@logbrew/node`](../logbrew-node/README.md#existing-pino-logs) instead of `captureApplicationLogs`.

When an incoming request has a valid W3C `traceparent` header, the plugin attaches `request.logbrew.trace` and the default request capture records the request as a LogBrew `span` that continues the incoming trace. The active trace is also available from `getActiveLogBrewTrace()` inside asynchronous work started by Fastify after the plugin's `onRequest` hook. Requests without `traceparent`, or with a malformed header, fall back to the existing request `log` event so bad client headers do not break your app. Use `spanIdFactory` when your runtime needs app-provided child span IDs:

```js
await app.register(logbrewFastifyPlugin, {
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  spanIdFactory: () => "b7ad6b7169203331"
});
```

`request.logbrew.trace` contains only normalized W3C IDs and the sampled flag. It does not include request bodies, response bodies, headers, query strings, or the raw `traceparent` value. Use it to correlate app-owned logs, errors, product actions, and downstream milestones with the current request span:

```js
import { getActiveLogBrewTrace } from "@logbrew/fastify";

app.get("/checkout/:cartId", async (request) => {
  const trace = request.logbrew.trace ?? getActiveLogBrewTrace();

  await Promise.resolve();

  const metadata = trace
    ? { routeTemplate: "/checkout/:cartId", traceId: trace.traceId, spanId: trace.spanId }
    : { routeTemplate: "/checkout/:cartId" };

  request.logbrew.client.log("evt_checkout_received", new Date().toISOString(), {
    message: "checkout request accepted",
    level: "info",
    logger: "fastify",
    metadata
  });

  return { ok: true };
});
```

Request metrics are opt-in. Enable `captureRequestMetrics` when you want the plugin to send an explicit `http.server.duration` histogram for each completed request:

```js
await app.register(logbrewFastifyPlugin, {
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  captureRequestMetrics: true
});
```

The metric carries the stable description `Duration of one completed server request.` plus primitive, low-cardinality metadata: `framework`, `method`, `routeTemplate`, `statusCode`, and `statusCodeClass`. Query strings and hashes are omitted. Prefer Fastify route templates such as `/checkout/:id` over raw URLs, and avoid user IDs, request payloads, headers, or free-form text in custom metric metadata. Use `metricName`, `metricIdFactory`, or `requestMetricEvent` when your app needs a different naming, description, or metadata policy. Set `captureRequests: false` with `captureRequestMetrics: true` when you only want the duration metric and not the request log/span.

## Error Capture

```js
import { logbrewFastifyPlugin } from "@logbrew/fastify";

await app.register(logbrewFastifyPlugin, {
  serverApiKey: process.env.LOGBREW_SERVER_API_KEY,
  onCaptureError(error) {
    console.error("LogBrew error capture failed", error);
  }
});

app.get("/fail", async () => {
  throw new Error("route exploded");
});

app.setErrorHandler((error, _request, reply) => {
  reply.code(500).send({ error: error.message });
});
```

The plugin uses Fastify's `onRequest`, `preHandler`, `onResponse`, and `onError` hooks. `onResponse` runs after the response has been sent, which makes it a good place to flush request telemetry without changing the response body; `onError` queues thrown route errors before your normal error response handler finishes the request. When request capture or request metrics are enabled, the completed error response and its issue are delivered together once from `onResponse`. When both are disabled, `onError` delivers the issue directly. A failing request with a valid `traceparent` includes trace correlation metadata without echoing the raw propagation header.

## Example Source

The package includes example source for the request plugin, `onResponse` flushing, `onError` capture, and app-owned error responses. The packaged examples use an explicit `RecordingTransport` so they can run offline and print serialized event batches without sending them. Use the default network-delivery snippets above as the starting point for wiring LogBrew into your Fastify application.
