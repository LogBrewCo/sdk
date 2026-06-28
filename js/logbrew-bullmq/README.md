# @logbrew/bullmq

BullMQ tracing helpers for the public LogBrew JavaScript SDK.

Use this package when your Node.js service already uses BullMQ and you want producer and worker spans correlated by W3C `traceparent` without global patching.

## Install

This package is source-only until its first npm release. The npm and pnpm
commands below require the package to be available on npm; use a local checkout
when evaluating it before release.

```bash
npm install @logbrew/sdk @logbrew/node @logbrew/bullmq bullmq
pnpm add @logbrew/sdk @logbrew/node @logbrew/bullmq bullmq
```

Configure LogBrew with a project-scoped server ingest key for SDK ingest.

## Producer and Worker

```js
import { Queue, Worker } from "bullmq";
import { createLogBrewNodeClient } from "@logbrew/node";
import {
  bullMqQueueAddWithLogBrewSpan,
  instrumentLogBrewBullMqQueue,
  withLogBrewBullMqProcessor
} from "@logbrew/bullmq";

const client = createLogBrewNodeClient({
  serverApiKey: process.env.LOGBREW_SERVER_API_KEY,
  sdkName: "orders-worker",
  sdkVersion: "1.0.0"
});

const redisConnection = createAppRedisConnection();
const queue = new Queue("orders", { connection: redisConnection });

await bullMqQueueAddWithLogBrewSpan(queue, "charge-card", { orderId: "ord_123" }, {}, {
  client
});

new Worker("orders", withLogBrewBullMqProcessor(async (job) => {
  await chargeCard(job.data.orderId);
}, {
  client
}));
```

`bullMqQueueAddWithLogBrewSpan()` and `bullMqQueueAddBulkWithLogBrewSpan()` wrap app-owned queue calls, add one producer span, and merge one normalized LogBrew `traceparent` into BullMQ `opts.telemetry.metadata`. `withLogBrewBullMqProcessor()` extracts only that LogBrew trace context, creates one consumer span, and rethrows application failures.

If you prefer queue-level setup over wrapping every producer call, patch only
the queue instance your app owns:

```js
const logbrewQueue = instrumentLogBrewBullMqQueue(queue, { client });

await queue.add("charge-card", { orderId: "ord_123" });
await queue.addBulk([
  { name: "send-receipt", data: { orderId: "ord_123" } }
]);

logbrewQueue.uninstall();
```

`instrumentLogBrewBullMqQueue()` wraps that queue object's `add()` and `addBulk()`
methods, preserves the original methods for `uninstall()`, and rejects duplicate
LogBrew instrumentation on the same queue instance.

## Privacy Defaults

- No job payloads, return values, Redis connection strings, headers, or full URLs are captured.
- Malformed `opts.telemetry.metadata` is ignored for propagation instead of breaking the job.
- Worker exceptions record type-only span events through `@logbrew/node`; exception messages and stacks are not added by these helpers.
- The package does not patch BullMQ globally, patch NestJS decorators, create queues, own Redis connections, or open support tickets.
