# @logbrew/node

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

Node.js HTTP helpers for the public LogBrew JavaScript SDK.

This package is intentionally thin. It adds a wrapper for standard `node:http` handlers, outbound `fetch`, database/cache/queue operation span capture, request/error event helpers, and request-local `req.logbrew` context while keeping event validation, retry, flush, and shutdown behavior in `@logbrew/sdk`.

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

When an incoming request has a valid W3C `traceparent` header, the wrapper attaches `logbrew.trace` and the default request capture records the request as a LogBrew `span` that continues the incoming trace. The active trace is also available from `getActiveLogBrewTrace()` inside asynchronous work started by the wrapped handler. Requests without `traceparent`, or with a malformed header, fall back to the existing request `log` event so bad client headers do not break your server. Use `spanIdFactory` when your runtime needs app-provided child span IDs:

```js
const server = createServer(withLogBrewHttpHandler((req, res) => {
  res.end("ok");
}, {
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  spanIdFactory: () => "b7ad6b7169203331",
  transport
}));
```

`logbrew.trace` contains only normalized W3C IDs and the sampled flag. It does not include request bodies, response bodies, headers, query strings, or the raw `traceparent` value. Use it to correlate your own logs, errors, product actions, and downstream milestones with the current request span:

```js
import { getActiveLogBrewTrace } from "@logbrew/node";

const server = createServer(withLogBrewHttpHandler((req, res, logbrew) => {
  const trace = logbrew.trace ?? getActiveLogBrewTrace();

  logbrew.client.log("evt_checkout_received", new Date().toISOString(), {
    message: "checkout request accepted",
    level: "info",
    logger: "checkout-api",
    metadata: {
      routeTemplate: "/checkout/:cartId",
      traceId: trace?.traceId,
      spanId: trace?.spanId
    }
  });

  res.end("ok");
}, {
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  transport
}));
```

## First Useful Telemetry

For a Node.js API, start with the signals that make incidents and product flows easy to inspect:

- Send `release` and `environment` once when the service starts.
- Wrap the `node:http` handler so completed requests become logs or W3C-linked spans.
- Add explicit product actions for business steps such as checkout, signup, or billing.
- Add explicit network milestones for important downstream calls.
- Wrap important database calls with safe operation names and statement templates.
- Wrap important cache and queue calls with safe operation names and bounded metadata.
- Add low-cardinality metrics for request or workflow duration.
- Flush on completion or shutdown so queued events are not left in memory.

```js
import { createServer } from "node:http";
import {
  createNetworkMilestoneAttributes,
  createProductActionAttributes
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
  const trace = logbrew.trace;

  logbrew.client.action("evt_checkout_started", new Date().toISOString(), createProductActionAttributes({
    name: "checkout started",
    status: "running",
    sessionId: "sess_checkout_123",
    traceId: trace?.traceId,
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
    traceId: trace?.traceId
  }));
  logbrew.client.metric("evt_checkout_duration", new Date().toISOString(), {
    name: "checkout.duration",
    kind: "histogram",
    value: 128,
    unit: "ms",
    temporality: "delta",
    metadata: {
      routeTemplate,
      traceId: trace?.traceId,
      spanId: trace?.spanId
    }
  });

  res.statusCode = 202;
  res.end("accepted");
}, {
  sdkName: "checkout-api",
  sdkVersion: "1.4.0",
  transport
}));

server.listen(3000);
```

The wrapper keeps app response ownership, records URL path without query text, and does not collect request bodies, response bodies, arbitrary headers, or outgoing calls automatically. Use the explicit action, network milestone, and outbound fetch helpers when you want AI coding assistants or teammates to inspect a workflow without replaying a full session.

## Outbound Fetch Spans

Use `fetchWithLogBrewSpan()` for important downstream calls you want linked to the active request trace. It wraps one app-owned `fetch` call, clones caller headers, writes one normalized W3C `traceparent`, queues one client span, and leaves flushing/shutdown to your existing `LogBrewClient` lifecycle:

```js
import { fetchWithLogBrewSpan } from "@logbrew/node";

const response = await fetchWithLogBrewSpan("https://payments.example/payments/123?coupon=summer", {
  method: "POST",
  headers: { accept: "application/json" }
}, {
  client: logbrew.client,
  trace: logbrew.trace,
  routeTemplate: "/payments/:paymentId"
});

if (!response.ok) {
  throw new Error("payment authorization failed");
}
```

The emitted span records the method, route template or URL path, status code, duration, sampled flag, and W3C trace IDs. It does not globally patch `fetch`, capture payloads, serialize arbitrary headers, store the raw propagation header, or keep query strings/fragments.

## Database Operation Spans

Use `databaseOperationWithLogBrewSpan()` around important app-owned database calls when you want request, log, error, and DB timing correlation without installing driver instrumentation:

```js
import { databaseOperationWithLogBrewSpan } from "@logbrew/node";

const orders = await databaseOperationWithLogBrewSpan("orders.select_by_id", {
  client: logbrew.client,
  trace: logbrew.trace,
  system: "postgresql",
  operationKind: "SELECT",
  databaseName: "checkout",
  statementTemplate: "SELECT * FROM orders WHERE id = ?",
  rowCount: 1,
  operation: () => db.query("SELECT * FROM orders WHERE id = $1", [orderId])
});
```

The helper returns or rethrows exactly what your `operation` does, records one child span, and keeps the active trace available inside asynchronous work started by the operation. Metadata records the DB system, operation name, operation kind, optional database name, optional safe statement template, row count, duration, sampled flag, and W3C trace IDs. It does not monkey-patch drivers, capture raw SQL, serialize parameters, record connection strings, store auth values, collect result rows, or include database error messages/stacks.

## Cache Operation Spans

Use `cacheOperationWithLogBrewSpan()` around important app-owned cache calls when you want cache timing and hit/miss correlation without installing Redis or memcached instrumentation:

```js
import { cacheOperationWithLogBrewSpan } from "@logbrew/node";

const profile = await cacheOperationWithLogBrewSpan("profile.get", {
  client: logbrew.client,
  trace: logbrew.trace,
  system: "redis",
  operationKind: "GET",
  cacheName: "profiles",
  hit: true,
  itemSizeBytes: 128,
  operation: () => redis.get(profileKey)
});
```

The helper returns or rethrows exactly what your `operation` does, records one child span, and keeps the active trace available inside asynchronous work started by the operation. Metadata records the cache system, operation name, operation kind, optional cache name, hit flag, item size/count, duration, sampled flag, and W3C trace IDs. It does not monkey-patch cache clients, capture cache keys, serialize values, store commands, record headers, or include cache error messages/stacks.

## Queue Operation Spans

Use `queueOperationWithLogBrewSpan()` around important producer or consumer work when you want queue timing correlation without installing AMQP, Kafka, BullMQ, or cloud queue instrumentation:

```js
import { queueOperationWithLogBrewSpan } from "@logbrew/node";

await queueOperationWithLogBrewSpan("email.publish", {
  client: logbrew.client,
  trace: logbrew.trace,
  system: "amqp",
  operationKind: "publish",
  queueName: "email",
  taskName: "send_welcome_email",
  messageCount: 1,
  operation: () => channel.sendToQueue("email", payload)
});
```

The helper returns or rethrows exactly what your `operation` does, records one child span, and keeps the active trace available inside asynchronous work started by the operation. Metadata records the queue system, operation name, operation kind, optional queue/task names, message count, duration, sampled flag, and W3C trace IDs. It does not monkey-patch queue clients, mutate broker headers, capture message bodies, serialize job arguments, record broker URLs, or include queue error messages/stacks.

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
