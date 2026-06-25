# @logbrew/bullmq

BullMQ tracing helpers for the public LogBrew JavaScript SDK.

Use this package when your Node.js service already uses BullMQ and you want producer and worker spans correlated by W3C `traceparent` without global patching.

## Install

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

## Privacy Defaults

- No job payloads, return values, Redis connection strings, headers, or full URLs are captured.
- Malformed `opts.telemetry.metadata` is ignored for propagation instead of breaking the job.
- Worker exceptions record type-only span events through `@logbrew/node`; exception messages and stacks are not added by these helpers.
- The package does not patch BullMQ, patch NestJS decorators, or open support tickets.
