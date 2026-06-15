# @logbrew/node

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

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

## First Useful Telemetry

For a Node.js API, start with the signals that make incidents and product flows easy to inspect:

- Send `release` and `environment` once when the service starts.
- Wrap the `node:http` handler so completed requests become logs or W3C-linked spans.
- Add explicit product actions for business steps such as checkout, signup, or billing.
- Add explicit network milestones for important downstream calls.
- Add low-cardinality metrics for request or workflow duration.
- Flush on completion or shutdown so queued events are not left in memory.

```js
import { createServer } from "node:http";
import {
  createNetworkMilestoneAttributes,
  createProductActionAttributes,
  parseTraceparent
} from "@logbrew/sdk";
import {
  createLogBrewNodeClient,
  createNodeFetchTransport,
  withLogBrewHttpHandler
} from "@logbrew/node";

const client = createLogBrewNodeClient({
  sdkName: "checkout-api",
  sdkVersion: "1.4.0"
});
const transport = createNodeFetchTransport();

client.release("evt_release_checkout_api", new Date().toISOString(), {
  version: "1.4.0",
  commit: "abc123def456",
  metadata: { service: "checkout-api" }
});
client.environment("evt_environment_checkout_api", new Date().toISOString(), {
  name: "production",
  region: "us-east-1"
});
await client.flush(transport);

const server = createServer(withLogBrewHttpHandler((req, res, logbrew) => {
  const routeTemplate = "/checkout/:cartId";
  const traceId = traceIdFromRequest(req);

  logbrew.client.action("evt_checkout_started", new Date().toISOString(), createProductActionAttributes({
    name: "checkout started",
    status: "running",
    sessionId: "sess_checkout_123",
    traceId,
    routeTemplate,
    funnel: "checkout",
    step: "payment"
  }));
  logbrew.client.action("evt_payment_authorized", new Date().toISOString(), createNetworkMilestoneAttributes({
    routeTemplate: "/payments/:paymentId",
    method: "POST",
    status: "success",
    statusCode: 202,
    durationMs: 43,
    sessionId: "sess_checkout_123",
    traceId
  }));
  logbrew.client.metric("evt_checkout_duration", new Date().toISOString(), {
    name: "checkout.duration",
    kind: "histogram",
    value: 128,
    unit: "ms",
    temporality: "delta",
    metadata: { routeTemplate, traceId }
  });

  res.statusCode = 202;
  res.end("accepted");
}, {
  sdkName: "checkout-api",
  sdkVersion: "1.4.0",
  transport
}));

server.listen(3000);

function traceIdFromRequest(req) {
  const value = req.headers.traceparent;
  if (typeof value !== "string") return undefined;
  try {
    return parseTraceparent(value).traceId;
  } catch {
    return undefined;
  }
}
```

The wrapper keeps app response ownership, records URL path without query text, and does not collect request bodies, response bodies, arbitrary headers, or outgoing calls. Use the explicit action and network milestone helpers when you want AI coding assistants or teammates to inspect a workflow without replaying a full session.

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

The package includes example source for standard `node:http` handlers, first useful telemetry, request/error capture, and fetch-based delivery. Use the snippets above as the starting point for wiring LogBrew into your Node.js service.
