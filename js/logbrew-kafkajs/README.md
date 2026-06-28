# @logbrew/kafkajs

Explicit KafkaJS tracing helpers for the public LogBrew JavaScript SDK.

This package is source-only until its first npm release. The npm and pnpm
commands below require the package to be available on npm; use a local checkout
when evaluating it before release.

```bash
npm install @logbrew/sdk @logbrew/node @logbrew/kafkajs kafkajs
pnpm add @logbrew/sdk @logbrew/node @logbrew/kafkajs kafkajs
```

Use a project-scoped server ingest key from your LogBrew project settings:

```js
import { Kafka } from "kafkajs";
import { LogBrewClient } from "@logbrew/sdk";
import { instrumentLogBrewKafkaJsConsumer, instrumentLogBrewKafkaJsProducer } from "@logbrew/kafkajs";

const client = LogBrewClient.create({
  apiKey: process.env.LOGBREW_SERVER_API_KEY ?? "LOGBREW_SERVER_API_KEY",
  release: "checkout-api@1.0.0",
  environment: "production",
  sdkName: "checkout-worker",
  sdkVersion: "1.0.0"
});

const kafka = new Kafka({
  clientId: "checkout-worker",
  brokers: [process.env.KAFKA_BROKER ?? "localhost:9092"]
});
const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: "checkout-worker" });

const producerInstrumentation = instrumentLogBrewKafkaJsProducer(producer, { client });
const consumerInstrumentation = instrumentLogBrewKafkaJsConsumer(consumer, { client });

await producer.send({
  topic: "checkout.events",
  messages: [{ value: JSON.stringify({ event: "checkout.started" }) }]
});

await consumer.run({
  eachMessage: async ({ message }) => {
    // Process your app-owned message. LogBrew does not capture key/value bytes.
    await handleCheckoutMessage(message);
  }
});

producerInstrumentation.uninstall();
consumerInstrumentation.uninstall();
```

For one-off producer calls or callback-level adoption, use the lower-level
helpers directly:

```js
import {
  kafkaJsProducerSendWithLogBrewSpan,
  withLogBrewKafkaJsEachBatch,
  withLogBrewKafkaJsEachMessage
} from "@logbrew/kafkajs";

await kafkaJsProducerSendWithLogBrewSpan(producer, {
  topic: "checkout.events",
  messages: [{ value: JSON.stringify({ event: "checkout.started" }) }]
}, { client });

await consumer.run({
  eachMessage: withLogBrewKafkaJsEachMessage(async ({ message }) => {
    await handleCheckoutMessage(message);
  }, { client })
});

// Or, for batch consumers:
await consumer.run({
  eachBatch: withLogBrewKafkaJsEachBatch(async ({ batch }) => {
    for (const message of batch.messages) {
      await handleCheckoutMessage(message);
    }
  }, { client })
});
```

## Behavior

- `instrumentLogBrewKafkaJsProducer(...)` wraps only the producer instance you pass, traces `send` and `sendBatch`, preserves `this` plus KafkaJS call arguments, rejects duplicate installs, and returns `uninstall()`.
- `instrumentLogBrewKafkaJsConsumer(...)` wraps only the consumer instance you pass, clones the `run(...)` config before wrapping `eachMessage` or `eachBatch`, preserves app-owned options, rejects duplicate installs, and returns `uninstall()`.
- Producer helpers clone the KafkaJS record or batch, write exactly one normalized W3C `traceparent` header into each app-owned message, and then call your producer.
- Consumer helpers continue a single-message trace from a valid `traceparent`; malformed propagation is ignored without failing the message.
- Batch consumers use bounded span links from message headers and derive `messaging.batch.message_count`.
- Spans use safe metadata such as `messaging.system=kafka`, `messaging.destination.name`, `messaging.operation.name`, and `messaging.operation.type`.
- The package keeps KafkaJS connections, producer/consumer lifecycle, retries, commits, and shutdown behavior app-owned.

## Privacy Boundary

The helpers do not patch KafkaJS globally, do not capture message keys or values, do not capture arbitrary headers, do not store broker URLs, partitions, offsets, auth material, baggage, tracestate, payloads, stack traces, or exception messages, and do not open support tickets.

Use `@logbrew/kafkajs` when you want explicit trace correlation for the KafkaJS calls you choose. Use lower-level `@logbrew/node` queue helpers when your app needs a custom queue abstraction.
