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
  bullMqFlowProducerAddWithLogBrewSpan,
  bullMqQueueAddWithLogBrewSpan,
  instrumentLogBrewBullMqFlowProducer,
  instrumentLogBrewBullMqProcessor,
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

`bullMqQueueAddWithLogBrewSpan()`, `bullMqQueueAddBulkWithLogBrewSpan()`, and `bullMqFlowProducerAddWithLogBrewSpan()` wrap app-owned producer calls, add one producer span, and merge one normalized LogBrew `traceparent` into BullMQ `opts.telemetry.metadata`. Flow jobs receive the same trace context on the root job and children so worker spans can correlate without reading job payloads. `withLogBrewBullMqProcessor()` extracts only that LogBrew trace context, creates one consumer span, and rethrows application failures.

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

For BullMQ `FlowProducer` trees, instrument only the producer instance your app
owns:

```js
const flowProducer = createAppFlowProducer();
const logbrewFlowProducer = instrumentLogBrewBullMqFlowProducer(flowProducer, {
  client
});

await flowProducer.add({
  name: "checkout-flow",
  queueName: "orders",
  data: { orderId: "ord_123" },
  children: [
    { name: "send-receipt", queueName: "orders", data: { orderId: "ord_123" } }
  ]
});

logbrewFlowProducer.uninstall();
```

`instrumentLogBrewBullMqFlowProducer()` wraps only `add()` on that FlowProducer,
preserves call options and extra arguments, recursively adds LogBrew trace
metadata to root and child flow jobs, and puts the original `add()` back on
`uninstall()`.

For NestJS `WorkerHost` processors or other class-owned processor methods, wrap
only the processor instance your app owns:

```js
class OrdersProcessor {
  async process(job) {
    await chargeCard(job.data.orderId);
  }
}

const processor = new OrdersProcessor();
const logbrewProcessor = instrumentLogBrewBullMqProcessor(processor, {
  client,
  queueName: "orders"
});

await processor.process(job);
logbrewProcessor.uninstall();
```

`instrumentLogBrewBullMqProcessor()` preserves `this`, keeps extra processor
arguments such as locks or abort signals, creates the same privacy-bounded
consumer span as `withLogBrewBullMqProcessor()`, and puts the original method
back on `uninstall()`.

## Privacy Defaults

- No job payloads, return values, Redis connection strings, headers, or full URLs are captured.
- Malformed `opts.telemetry.metadata` is ignored for propagation instead of breaking the job.
- Worker exceptions record type-only span events through `@logbrew/node`; exception messages and stacks are not added by these helpers.
- The package does not patch BullMQ globally, patch NestJS decorators, create queues or FlowProducers, own Redis connections, or open support tickets.
