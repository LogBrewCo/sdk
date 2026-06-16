# @logbrew/express

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

Express middleware helpers for the public LogBrew JavaScript SDK.

This package is intentionally thin. It adds request and error middleware UX while keeping event validation, retry, flush, and shutdown behavior in `@logbrew/sdk`.

## Install

```bash
npm install @logbrew/sdk @logbrew/express express
pnpm add @logbrew/sdk @logbrew/express express
```

## Request Middleware

```js
import express from "express";
import { RecordingTransport } from "@logbrew/sdk";
import { logbrewMiddleware } from "@logbrew/express";

const app = express();

app.use(logbrewMiddleware({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  transport: RecordingTransport.alwaysAccept()
}));

app.get("/health", (req, res) => {
  req.logbrew.client.log("evt_log_001", "2026-06-02T10:00:03Z", {
    message: "health check reached",
    level: "info",
    logger: "express"
  });
  res.json({ ok: true });
});
```

Use `serverApiKey` directly for local server examples, or set `LOGBREW_SERVER_API_KEY` in your server environment and omit it. `apiKey` and `LOGBREW_API_KEY` are still accepted for compatibility with the lower-level JavaScript SDK. Automatic request and error metadata records the path without query text by default.

When an incoming request has a valid W3C `traceparent` header, the middleware attaches `req.logbrew.trace` and the default request capture records the request as a LogBrew `span` that continues the incoming trace. The active trace is also available from `getActiveLogBrewTrace()` inside asynchronous work started by the Express middleware. Requests without `traceparent`, or with a malformed header, fall back to the existing request `log` event so bad client headers do not break your app. Use `spanIdFactory` when your runtime needs app-provided child span IDs:

```js
app.use(logbrewMiddleware({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  spanIdFactory: () => "b7ad6b7169203331",
  transport: RecordingTransport.alwaysAccept()
}));
```

`req.logbrew.trace` contains only normalized W3C IDs and the sampled flag. It does not include request bodies, response bodies, headers, query strings, or the raw `traceparent` value. Use it to correlate app-owned logs, errors, product actions, and downstream milestones with the current request span:

```js
import { getActiveLogBrewTrace } from "@logbrew/express";

app.get("/checkout/:cartId", async (req, res) => {
  const trace = req.logbrew.trace ?? getActiveLogBrewTrace();

  await Promise.resolve();

  const metadata = trace
    ? { routeTemplate: "/checkout/:cartId", traceId: trace.traceId, spanId: trace.spanId }
    : { routeTemplate: "/checkout/:cartId" };

  req.logbrew.client.log("evt_checkout_received", new Date().toISOString(), {
    message: "checkout request accepted",
    level: "info",
    logger: "express",
    metadata
  });

  res.json({ ok: true });
});
```

## Request Metrics

Request metrics are opt-in. Enable `captureRequestMetrics` when you want the middleware to send an explicit `http.server.duration` histogram for each completed request:

```js
app.use(logbrewMiddleware({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  captureRequestMetrics: true,
  transport: RecordingTransport.alwaysAccept()
}));
```

The metric includes primitive, low-cardinality metadata: `framework`, `method`, `routeTemplate`, `statusCode`, and `statusCodeClass`. Query strings and hashes are omitted. Prefer Express route templates such as `/checkout/:id` over raw URLs, and avoid user IDs, request payloads, headers, or free-form text in custom metric metadata. Use `metricName`, `metricIdFactory`, or `requestMetricEvent` when your app needs a different naming or metadata policy.

## Error Middleware

```js
import { logbrewErrorHandler } from "@logbrew/express";

app.use(logbrewErrorHandler({
  serverApiKey: "LOGBREW_SERVER_API_KEY"
}));

app.use((err, _req, res, _next) => {
  res.status(500).json({ error: err.message });
});
```

Express error-handling middleware uses four arguments: `(err, req, res, next)`. In Express 5, route handlers and middleware that return rejected promises are forwarded to error handlers automatically, so `logbrewErrorHandler()` is designed to capture and then pass the error onward to your existing response handler. When the failing request passed through `logbrewMiddleware()` with a valid `traceparent`, the default error event includes trace correlation metadata without echoing the raw propagation header.

## Example Source

The package includes example source for request middleware, error middleware, and app-owned response handling. Use the snippets above as the starting point for wiring LogBrew into your Express application.
