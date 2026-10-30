# @logbrew/amqplib

Explicit RabbitMQ `amqplib` tracing helpers for the public LogBrew JavaScript SDK.

This package is source-only until its first npm release. The npm and pnpm
commands below require the package to be available on npm; use a local checkout
when evaluating it before release.

```bash
npm install @logbrew/sdk @logbrew/node @logbrew/amqplib amqplib
pnpm add @logbrew/sdk @logbrew/node @logbrew/amqplib amqplib
```

Use a project-scoped server ingest key from your LogBrew project settings:

```js
import { amqplibSendToQueueWithLogBrewSpan, withLogBrewAmqplibConsumer } from "@logbrew/amqplib";
import { LogBrewClient } from "@logbrew/sdk";
import amqp from "amqplib";

const client = LogBrewClient.create({
  apiKey: process.env["LOGBREW_SERVER_API_KEY"] ?? "LOGBREW_SERVER_API_KEY",
  context: { resource: { deployment: { environment: "production", release: "checkout-worker@1.0.0" } }, schemaVersion: 1 },
  sdkName: "checkout-worker",
  sdkVersion: "1.0.0"
});

const connection = await amqp.connect(process.env["AMQP_URL"] ?? "amqp://localhost");
const channel = await connection.createChannel();

await amqplibSendToQueueWithLogBrewSpan(
  channel,
  "checkout.created",
  Buffer.from(JSON.stringify({ event: "checkout.created" })),
  { contentType: "application/json" },
  { client }
);

function acknowledgeCheckout(message) {
  if (message !== null) {
    channel.ack(message);
  }
}

const consumeCheckout = withLogBrewAmqplibConsumer(acknowledgeCheckout, { client, queueName: "checkout.created" });

await channel.consume("checkout.created", (message) => {
  consumeCheckout(message).catch(() => {
    if (message !== null) {
      channel.nack(message);
    }
  });
});
```

For exchange publishing, wrap `publish`:

```js
import { amqplibPublishWithLogBrewSpan } from "@logbrew/amqplib";

await amqplibPublishWithLogBrewSpan(
  channel,
  "checkout.exchange",
  "created",
  Buffer.from(JSON.stringify({ event: "checkout.created" })),
  { contentType: "application/json" },
  { client }
);
```

## Behavior

- Producer helpers clone the `amqplib` publish options and headers, write exactly one normalized W3C `traceparent`, and then call your channel.
- Consumer helpers continue from a valid `traceparent` in `message.properties.headers`; malformed propagation is ignored without failing the message.
- `null` consumer-cancel notifications are passed through without creating telemetry.
- Spans use safe metadata such as `messaging.system=rabbitmq`, `messaging.destination.name`, `messaging.operation.name`, `messaging.operation.type`, `amqpExchange`, and `amqpRoutingKey`.
- The package keeps connections, channels, acknowledgement, nack/reject, retry, confirms, and shutdown behavior app-owned.

## Privacy Boundary

The helpers do not patch `amqplib` globally, do not capture message bodies, arbitrary headers, broker URLs, host names, ports, consumer tags, message IDs, correlation IDs, payload sizes, baggage, tracestate, stack traces, exception messages, or support tickets.

Use `@logbrew/amqplib` when you want explicit trace correlation for selected RabbitMQ calls. Use lower-level `@logbrew/node` queue helpers when your app needs a custom queue abstraction.
