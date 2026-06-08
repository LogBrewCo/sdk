# @logbrew/node

Node.js HTTP helpers for the public LogBrew JavaScript SDK.

This package is intentionally thin. It adds a wrapper for standard `node:http` handlers, request/error event helpers, and request-local `req.logbrew` context while keeping event validation, retry, flush, and shutdown behavior in `@logbrew/sdk`.

## Install

```bash
npm install @logbrew/sdk @logbrew/node
pnpm add @logbrew/sdk @logbrew/node
```

## HTTP Server

```js
import { createServer } from "node:http";
import { createNodeFetchTransport, withLogBrewHttpHandler } from "@logbrew/node";

const transport = createNodeFetchTransport();

const server = createServer(withLogBrewHttpHandler((req, res, logbrew) => {
  logbrew.client.log("evt_log_001", new Date().toISOString(), {
    message: `${req.method} ${req.url}`,
    level: "info",
    logger: "node"
  });
  res.end("ok");
}, {
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  transport
}));

server.listen(3000);
```

`withLogBrewHttpHandler()` attaches `req.logbrew`, can capture completed requests from `finish`, captures thrown or rejected handler errors, and sends a plain `500` fallback when the app has not already written a response. Pass `captureRequests: false` when the app wants to record only its own explicit events.

Use `serverApiKey` directly for local server examples, or set `LOGBREW_SERVER_API_KEY` in your server environment and omit it. `apiKey` and `LOGBREW_API_KEY` are still accepted for compatibility with the lower-level JavaScript SDK. Automatic request and error metadata records the path without query text by default.

When an incoming request has a valid W3C `traceparent` header, the default request capture records the request as a LogBrew `span` that continues the incoming trace. Requests without `traceparent`, or with a malformed header, fall back to the existing request `log` event so bad client headers do not break your server. Use `spanIdFactory` when your runtime needs app-provided child span IDs:

```js
const server = createServer(withLogBrewHttpHandler((req, res) => {
  res.end("ok");
}, {
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  spanIdFactory: () => "b7ad6b7169203331",
  transport
}));
```

## HTTP Delivery

`createNodeFetchTransport()` sends batches with Node's built-in `fetch`, sets `content-type: application/json`, and passes the SDK key through the `authorization` header. Override `endpoint`, `headers`, or `fetchImpl` when you need a proxy, local collector, or custom fetch implementation:

```js
import { createNodeFetchTransport } from "@logbrew/node";

const transport = createNodeFetchTransport({
  endpoint: "https://api.logbrew.com/v1/events",
  headers: {
    "x-logbrew-source": "checkout-api"
  }
});
```

## Example Source

The package includes example source for standard `node:http` handlers, request/error capture, and fetch-based delivery. Use the snippets above as the starting point for wiring LogBrew into your Node.js service.
