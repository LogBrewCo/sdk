# @logbrew/node

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

Node.js HTTP helpers for the public LogBrew JavaScript SDK.

This package is intentionally thin. It adds a wrapper for standard `node:http` handlers, outbound `fetch`, opt-in reversible global fetch instrumentation, database/cache/queue operation span capture, request/error event helpers, and request-local `req.logbrew` context while keeping event validation, retry, flush, and shutdown behavior in `@logbrew/sdk`.

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

The wrapper keeps app response ownership, records URL path without query text, and adds portable HTTP semantic metadata such as `http.request.method`, `http.response.status_code`, and `url.path`. It does not collect request bodies, response bodies, arbitrary headers, or outgoing calls automatically. Use the explicit action, network milestone, and outbound fetch helpers when you want AI coding assistants or teammates to inspect a workflow without replaying a full session.

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
  routeTemplate: "/payments/:paymentId",
  timings({ durationMs, response }) {
    const contentLength = Number(response?.headers.get("content-length"));
    return {
      responseBodyBytes: Number.isFinite(contentLength) ? contentLength : undefined,
      responseMs: 6,
      waitMs: Math.max(0, durationMs - 6)
    };
  }
});

if (!response.ok) {
  throw new Error("payment authorization failed");
}
```

The emitted span records the method, route template or URL path, status code, duration, sampled flag, W3C trace IDs, and portable HTTP semantic metadata (`http.request.method`, `http.response.status_code`, `http.route`, `url.path`). If your app already has safe timing data, pass `timings` as either an object or function. LogBrew keeps only finite non-negative numbers for `nameLookupMs`, `connectMs`, `tlsMs`, `requestMs`, `waitMs`, `responseMs`, `redirectMs`, `requestBodyBytes`, `responseBodyBytes`, `encodedBodySize`, and `decodedBodySize`; invalid values and unknown keys are dropped. It does not capture payloads, serialize arbitrary headers, store the raw propagation header, keep query strings/fragments, or infer timing streams from hidden fetch/Undici hooks.

If a service has many existing `fetch(...)` calls, opt into reversible global fetch instrumentation explicitly:

```js
import { installLogBrewFetchInstrumentation } from "@logbrew/node";

const fetchInstrumentation = installLogBrewFetchInstrumentation({
  client: logbrew.client,
  trace: logbrew.trace,
  tracePropagationTargets: ["https://api.example.com/"],
  routeTemplateFactory({ path }) {
    return path.replace(/\/\d+/g, "/:id");
  },
  metadata: {
    service: "checkout-api",
    release: "checkout-api@1.4.0"
  }
});

await fetch("https://api.example.com/orders/42?email=hidden", {
  method: "POST"
});

fetchInstrumentation.uninstall();
```

`installLogBrewFetchInstrumentation()` wraps `globalThis.fetch` by default, or another fetch owner when you pass `globalObject`. Only URLs matching `tracePropagationTargets` or `captureTargets` are captured and receive a normalized W3C `traceparent`; unmatched fetches pass through unchanged. `uninstall()` puts the original fetch back only if LogBrew still owns the slot, so a later app wrapper is not clobbered. The captured spans use the same safe `node:fetch` metadata as `fetchWithLogBrewSpan()` and drop unsafe metadata keys such as bodies, headers, URLs, query text, cookies, auth values, raw `traceparent`, payloads, and exception messages. It does not subscribe to Undici diagnostic channels, patch HTTP clients globally beyond the fetch function you opt into, capture request/response bodies, read arbitrary headers, persist offline requests, infer baggage/tracestate, or instrument LogBrew transport calls unless your target list matches them.

Global fetch instrumentation also accepts the same `timings` option. The timing function receives only the emitted method, route-template path, duration, response/error, and trace context so it cannot accidentally depend on full URLs or request headers.

When your app already uses Node's built-in `fetch` or Undici clients broadly and you want one target-gated process-wide hook, use `installLogBrewUndiciInstrumentation()`:

```js
import { installLogBrewUndiciInstrumentation } from "@logbrew/node";

const undiciInstrumentation = installLogBrewUndiciInstrumentation({
  client: logbrew.client,
  trace: logbrew.trace,
  captureTargets({ path }) {
    return path.startsWith("/payments/");
  },
  routeTemplateFactory({ path }) {
    return path.replace(/\/\d+/g, "/:id");
  }
});

await fetch("https://api.example.com/payments/42?email=hidden", {
  method: "POST"
});

undiciInstrumentation.uninstall();
```

This installer subscribes to Node's public Undici diagnostic channels and captures matching `fetch`, `undici.request`, `undici.stream`, and other Undici-backed requests without adding an Undici dependency. It writes one normalized `traceparent`, creates one `node:undici` client span, records status, total duration, safe phase timings (`http.phase.request_ms`, `http.phase.wait_ms`, `http.phase.response_ms`), and `content-length` as `http.response_content_length` when available. It is off by default, target-gated, reversible, and one installation per process to avoid duplicate spans. It does not capture arbitrary headers, request or response payloads, query strings, fragments, hosts, socket addresses, error messages, baggage, tracestate, or raw propagation metadata.

## Node HTTP Client Spans

For libraries or app code that still use Node core `http` or `https` modules directly, install target-scoped module instrumentation explicitly. LogBrew wraps only the module objects you pass, puts them back on `uninstall()`, and leaves unmatched requests untouched:

```js
import http from "node:http";
import https from "node:https";
import { installLogBrewHttpClientInstrumentation } from "@logbrew/node";

const httpInstrumentation = installLogBrewHttpClientInstrumentation({
  client: logbrew.client,
  trace: logbrew.trace,
  modules: { http, https },
  captureTargets({ path }) {
    return path.startsWith("/payments/");
  },
  tracePropagationTargets({ path }) {
    return path.startsWith("/payments/");
  },
  routeTemplateFactory({ path }) {
    return path.replace(/\/\d+/g, "/:id");
  },
  metadata: {
    service: "checkout-api",
    release: "checkout-api@1.4.0"
  }
});

const req = http.request("http://payments.example/payments/123?coupon=hidden", {
  method: "POST",
  headers: { accept: "application/json" }
}, (res) => {
  res.resume();
});
req.end();

httpInstrumentation.uninstall();
```

Captured spans use `framework: "node:http"` or `framework: "node:https"` with method, route or query-free path, status code, duration, sampled flag, and W3C trace IDs. LogBrew clones request options before writing one normalized `traceparent`, so caller-owned header objects are not mutated. HTTP 4xx/5xx responses become error-status spans with a type-only `HttpStatusError` event, but the original response is still delivered normally. LogBrew does not patch modules you do not pass, capture request or response bodies, keep query strings/fragments, serialize arbitrary headers, store raw `traceparent`, include network addresses/socket details in telemetry, infer baggage/tracestate, or include exception messages/stacks.

## Outbound Axios Spans

If your service already uses Axios, install LogBrew on the Axios instance your app owns. The helper uses Axios interceptors, injects one normalized W3C `traceparent`, captures one client span per matching request, and returns an `uninstall()` handle:

```js
import axios from "axios";
import { instrumentLogBrewAxiosInstance } from "@logbrew/node";

const payments = axios.create({
  baseURL: "https://payments.example"
});

const axiosInstrumentation = instrumentLogBrewAxiosInstance(payments, {
  client: logbrew.client,
  trace: logbrew.trace,
  tracePropagationTargets: ["https://payments.example/"],
  routeTemplateFactory({ path }) {
    return path.replace(/\/\d+/g, "/:id");
  },
  metadata: {
    service: "checkout-api",
    release: "checkout-api@1.4.0"
  }
});

await payments.post("/payments/123?coupon=hidden", {
  cartId: "cart_123"
});

axiosInstrumentation.uninstall();
```

For one important call, wrap the request explicitly instead of installing interceptors:

```js
import { axiosRequestWithLogBrewSpan } from "@logbrew/node";

const response = await axiosRequestWithLogBrewSpan(payments, {
  method: "GET",
  url: "/payments/123?coupon=hidden"
}, {
  client: logbrew.client,
  trace: logbrew.trace,
  routeTemplate: "/payments/:paymentId"
});
```

Axios spans use `framework: "node:axios"` with method, route or query-free path, status code, duration, sampled flag, and W3C trace IDs. `tracePropagationTargets` and `captureTargets` accept the same string, regular expression, and predicate matchers as fetch instrumentation. LogBrew does not install Axios for you, patch all Node HTTP clients globally, capture request or response bodies, keep query strings/fragments, serialize arbitrary headers, store raw `traceparent`, infer baggage/tracestate, or include exception messages. If an Axios instance is already instrumented, do not wrap the same call with `axiosRequestWithLogBrewSpan()` or you will intentionally create two spans.

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
  events: [{ name: "db.pool.wait", metadata: { phase: "before_query" } }],
  links: [{ traceId: "11111111111111111111111111111111", spanId: "2222222222222222", metadata: { relation: "batch_item" } }],
  operation: () => db.query("SELECT * FROM orders WHERE id = $1", [orderId])
});
```

The helper returns or rethrows exactly what your `operation` does, records one child span, and keeps the active trace available inside asynchronous work started by the operation. Metadata records the DB system, operation name, operation kind, optional database name, optional safe statement template, row count, duration, sampled flag, W3C trace IDs, and portable DB semantic metadata (`db.system.name`, `db.operation.name`, `db.namespace`). Optional `events` record up to eight explicit low-cardinality span milestones with primitive metadata; optional `links` record up to eight related trace/span IDs with primitive metadata for fan-out, batch, retry, or queue relationships; failed operations add a type-only `exception` event. It does not monkey-patch drivers, capture raw SQL, serialize parameters, record connection strings, store auth values, collect result rows, include database error messages/stacks, infer baggage/tracestate, or store raw propagation headers.

### `pg` Query Spans

Use `instrumentLogBrewPgClient()` when your app already uses `pg` and wants query spans without global patching. Pass the app-owned `Client` or `Pool`, keep `pg` as your own dependency, and uninstall when the wrapped instance should return to its original behavior:

```js
import { createLogBrewNodeClient, instrumentLogBrewPgClient } from "@logbrew/node";
import pg from "pg";

const client = createLogBrewNodeClient({ sdkName: "checkout-api", sdkVersion: "1.4.0" });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const pgInstrumentation = instrumentLogBrewPgClient(pool, {
  client,
  databaseName: "checkout",
  metadata: { feature: "checkout" }
});

const result = await pool.query({
  name: "orders.select_by_id",
  text: "SELECT * FROM orders WHERE id = $1",
  values: [orderId]
});

pgInstrumentation.uninstall();
```

The wrapper records one child span per `query()` call, preserves Promise and callback query results, rethrows driver errors, and uses the active LogBrew request trace when one exists. Metadata includes `framework: "node:pg"`, `db.system.name: "postgresql"`, operation kind, safe prepared-statement name when present, optional database name, row count, duration, sampled flag, and W3C trace IDs. Failed queries add a type-only `exception` event. It does not patch the `pg` module globally, capture raw SQL, serialize parameters, record result rows, store connection strings, read connection endpoint/user/passphrase fields, inject SQL comments, infer baggage/tracestate, or store raw propagation headers.

### MongoDB Collection Spans

Use `instrumentLogBrewMongoCollection()` when your app already uses the MongoDB driver and wants collection or cursor spans without global driver patching. Pass the app-owned collection, keep `mongodb` as your own dependency, and uninstall when the wrapped collection should return to its original behavior:

```js
import { createLogBrewNodeClient, instrumentLogBrewMongoCollection } from "@logbrew/node";

const client = createLogBrewNodeClient({ sdkName: "checkout-api", sdkVersion: "1.4.0" });
const orders = mongo.db("checkout").collection("orders");

const mongoInstrumentation = instrumentLogBrewMongoCollection(orders, {
  client,
  databaseName: "checkout",
  metadata: { feature: "checkout" }
});

const order = await orders.findOne({ id: orderId });
const recentOrders = await orders.find({ status: "open" }).toArray();

mongoInstrumentation.uninstall();
```

The wrapper records one child span per supported collection operation and per wrapped cursor materialization method such as `toArray()` or `next()`. It preserves operation and cursor results, rethrows MongoDB driver errors, and uses the active LogBrew request trace when one exists. Metadata includes `framework: "node:mongodb"`, `db.system.name: "mongodb"`, operation kind, optional database and collection names, duration, sampled flag, and W3C trace IDs. Failed operations add a type-only `exception` event. It does not patch MongoDB modules globally, capture filters, serialize documents, store update specs, record aggregation pipelines, include connection strings or endpoint details, infer baggage/tracestate, or store raw propagation headers.

### Redis Command Spans

Use `instrumentLogBrewRedisClient()` when your app already uses `redis` or `ioredis` and wants command spans without global module patching. Pass the app-owned client, keep the Redis package as your own dependency, and uninstall when the wrapped instance should return to its original behavior:

```js
import { createLogBrewNodeClient, instrumentLogBrewRedisClient } from "@logbrew/node";
import { createClient } from "redis";

const client = createLogBrewNodeClient({ sdkName: "checkout-api", sdkVersion: "1.4.0" });
const redis = createClient({ url: process.env.REDIS_URL });

const redisInstrumentation = instrumentLogBrewRedisClient(redis, {
  client,
  cacheName: "profiles",
  metadata: { feature: "profile-cache" },
  tracePipelines: true
});

await redis.connect();
const profile = await redis.sendCommand(["GET", profileKey]);
const pipelineResult = await redis.multi()
  .set(profileKey, JSON.stringify({ cached: true }))
  .get(profileKey)
  .execAsPipeline();

redisInstrumentation.uninstall();
```

The wrapper records one child span per `sendCommand()` call and one optional `connect()` span when the client exposes `connect()`. With `tracePipelines: true`, it also wraps only pipeline objects returned by that owned client instance and records one aggregate `redis.pipeline` or `redis.multi` span around `exec()` / `execAsPipeline()`. Pipeline metadata is limited to command count and capped command verbs such as `SET,GET`; keys, values, command arguments, raw command text, connection details, and replies are never serialized. It preserves command and pipeline results, rethrows Redis driver errors, supports node-redis array commands and ioredis-style `{ name, args }` command objects, and uses the active LogBrew request trace when one exists. Metadata includes `framework: "node:redis"`, `db.system.name: "redis"`, operation kind, optional cache name, cache-hit boolean for read commands when the result is available, duration, sampled flag, and W3C trace IDs. Failed commands and pipelines add a type-only `exception` event. It does not patch Redis modules globally, capture command arguments, serialize keys or values, record host/port/URLs/connection strings, store connection access values, infer baggage/tracestate, or store raw propagation headers.

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

The helper returns or rethrows exactly what your `operation` does, records one child span, and keeps the active trace available inside asynchronous work started by the operation. Metadata records the cache system, operation name, operation kind, optional cache name, hit flag, item size/count, duration, sampled flag, W3C trace IDs, and portable Redis-like DB semantic metadata when available (`db.system.name`, `db.operation.name`, `db.namespace`). Optional `events` record up to eight explicit low-cardinality span milestones with primitive metadata; optional `links` record up to eight related trace/span IDs with primitive metadata; failed operations add a type-only `exception` event. It does not monkey-patch cache clients, capture cache keys, serialize values, store commands, record headers, include cache error messages/stacks, infer baggage/tracestate, or store raw propagation headers.

## Queue Operation Spans

Use `queueOperationWithLogBrewSpan()` around important producer or consumer work when you want queue timing correlation without installing AMQP, Kafka, BullMQ, or cloud queue instrumentation:

```js
import {
  createLogBrewQueueTraceHeaders,
  createLogBrewQueueTraceLinks,
  queueBatchOperationWithLogBrewSpan,
  queueOperationWithLogBrewSpan
} from "@logbrew/node";

await queueOperationWithLogBrewSpan("email.publish", {
  client: logbrew.client,
  trace: logbrew.trace,
  system: "amqp",
  operationKind: "publish",
  queueName: "email",
  taskName: "send_welcome_email",
  messageCount: 1,
  operation: () => channel.sendToQueue("email", payload, {
    headers: createLogBrewQueueTraceHeaders()
  })
});

await queueOperationWithLogBrewSpan("email.process", {
  client: logbrew.client,
  system: "amqp",
  operationKind: "process",
  queueName: "email",
  traceparent: message.headers?.traceparent,
  operation: () => processMessage(message)
});

const links = createLogBrewQueueTraceLinks(messages.map((item) => item.headers), {
  relation: "batch_item"
});

await queueOperationWithLogBrewSpan("email.batch_process", {
  client: logbrew.client,
  system: "amqp",
  operationKind: "process",
  queueName: "email",
  messageCount: messages.length,
  links,
  operation: () => processBatch(messages)
});

await queueBatchOperationWithLogBrewSpan("email.batch_process", {
  client: logbrew.client,
  system: "amqp",
  operationKind: "process",
  queueName: "email",
  messages,
  linkMetadata: { relation: "batch_item" },
  operation: () => processBatch(messages)
});
```

The helper returns or rethrows exactly what your `operation` does, records one child span, and keeps the active trace available inside asynchronous work started by the operation. Call `createLogBrewQueueTraceHeaders()` inside a producer operation to create one normalized W3C `traceparent` header from the active queue span, then pass that header into a consumer span through `traceparent` when you process one message. For batch consumers, use `queueBatchOperationWithLogBrewSpan()` with message objects that expose `headers`, or call `createLogBrewQueueTraceLinks()` directly when your queue library has a different carrier shape. Both paths cap links at eight, skip malformed propagation, and avoid retaining raw broker headers.

Metadata records the queue system, operation name, operation kind, optional queue/task names, message count, duration, sampled flag, W3C trace IDs, and portable messaging semantic metadata when available (`messaging.system`, `messaging.destination.name`, `messaging.operation.name`, `messaging.operation.type`, `messaging.batch.message_count`). Optional `events` record up to eight explicit low-cardinality span milestones with primitive metadata; optional `links` record up to eight related trace/span IDs with primitive metadata; failed operations add a type-only `exception` event. Queue link metadata is primitive-only and drops unsafe keys such as bodies, payloads, headers, raw messages, URLs, traceparents, and auth-like values. It does not monkey-patch queue clients, mutate broker headers outside your explicit call, capture message bodies, serialize job arguments, record broker URLs, include queue error messages/stacks, infer baggage/tracestate, or store raw propagation headers.

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
