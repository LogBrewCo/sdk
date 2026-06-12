# @logbrew/fastify

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

Fastify plugin helpers for the public LogBrew JavaScript SDK.

This package is intentionally thin. It adds Fastify request lifecycle UX while keeping event validation, retry, flush, and shutdown behavior in `@logbrew/sdk`.

## Install

```bash
npm install @logbrew/sdk @logbrew/fastify fastify
pnpm add @logbrew/sdk @logbrew/fastify fastify
```

## Request Plugin

```js
import Fastify from "fastify";
import { RecordingTransport } from "@logbrew/sdk";
import { logbrewFastifyPlugin } from "@logbrew/fastify";

const app = Fastify();

await app.register(logbrewFastifyPlugin, {
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  transport: RecordingTransport.alwaysAccept()
});

app.get("/health", async (request) => {
  request.logbrew.client.log("evt_log_001", "2026-06-02T10:00:03Z", {
    message: "health check reached",
    level: "info",
    logger: "fastify"
  });
  return { ok: true };
});
```

Use `serverApiKey` directly for local server examples, or set `LOGBREW_SERVER_API_KEY` in your server environment and omit it. `apiKey` and `LOGBREW_API_KEY` are still accepted for compatibility with the lower-level JavaScript SDK. Automatic request and error metadata records the path without query text by default.

When an incoming request has a valid W3C `traceparent` header, the default request capture records the request as a LogBrew `span` that continues the incoming trace. Requests without `traceparent`, or with a malformed header, fall back to the existing request `log` event so bad client headers do not break your app. Use `spanIdFactory` when your runtime needs app-provided child span IDs:

```js
await app.register(logbrewFastifyPlugin, {
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  spanIdFactory: () => "b7ad6b7169203331",
  transport: RecordingTransport.alwaysAccept()
});
```

Request metrics are opt-in. Enable `captureRequestMetrics` when you want the plugin to send an explicit `http.server.duration` histogram for each completed request:

```js
await app.register(logbrewFastifyPlugin, {
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  captureRequestMetrics: true
});
```

The metric includes primitive, low-cardinality metadata: `framework`, `method`, `routeTemplate`, `statusCode`, and `statusCodeClass`. Query strings and hashes are omitted. Prefer Fastify route templates such as `/checkout/:id` over raw URLs, and avoid user IDs, request payloads, headers, or free-form text in custom metric metadata. Use `metricName`, `metricIdFactory`, or `requestMetricEvent` when your app needs a different naming or metadata policy. Set `captureRequests: false` with `captureRequestMetrics: true` when you only want the duration metric and not the request log/span.

## Error Capture

```js
import { logbrewFastifyPlugin } from "@logbrew/fastify";

await app.register(logbrewFastifyPlugin, {
  serverApiKey: "LOGBREW_SERVER_API_KEY"
});

app.get("/fail", async () => {
  throw new Error("route exploded");
});

app.setErrorHandler((error, _request, reply) => {
  reply.code(500).send({ error: error.message });
});
```

The plugin uses Fastify's `onRequest`, `onResponse`, and `onError` hooks. `onResponse` runs after the response has been sent, which makes it a good place to flush request telemetry without changing the response body; `onError` captures thrown route errors before your normal error response handler finishes the request.

## Example Source

The package includes example source for the request plugin, `onResponse` flushing, `onError` capture, and app-owned error responses. Use the snippets above as the starting point for wiring LogBrew into your Fastify application.
