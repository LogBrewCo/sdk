# `@logbrew/aws-sqs`

Amazon SQS tracing helpers for Node apps that use `@aws-sdk/client-sqs`.

```sh
npm install @logbrew/sdk @logbrew/node @logbrew/aws-sqs @aws-sdk/client-sqs
pnpm add @logbrew/sdk @logbrew/node @logbrew/aws-sqs @aws-sdk/client-sqs
```

Use a project-scoped server ingest key, for example `LOGBREW_SERVER_API_KEY`.
Do not use dashboard login or session values as SDK ingest configuration.

```js
import { LogBrewClient } from "@logbrew/sdk";
import { SQSClient, SendMessageCommand, SendMessageBatchCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import {
  sqsReceiveMessageWithLogBrewSpan,
  sqsSendMessageBatchWithLogBrewSpan,
  sqsSendMessageWithLogBrewSpan,
  withLogBrewSqsMessageProcessor
} from "@logbrew/aws-sqs";

const logbrew = LogBrewClient.create({
  apiKey: process.env.LOGBREW_SERVER_API_KEY,
  release: process.env.LOGBREW_RELEASE,
  environment: process.env.NODE_ENV,
  sdkName: "checkout-worker",
  sdkVersion: "1.0.0"
});

const sqs = new SQSClient({ region: "us-east-1" });
const queueUrl = process.env.ORDERS_QUEUE_URL;

await sqsSendMessageWithLogBrewSpan(
  sqs,
  SendMessageCommand,
  {
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify({ type: "checkout.created" })
  },
  { client: logbrew, queueName: "orders" }
);

await sqsSendMessageBatchWithLogBrewSpan(
  sqs,
  SendMessageBatchCommand,
  {
    QueueUrl: queueUrl,
    Entries: [
      { Id: "one", MessageBody: JSON.stringify({ type: "checkout.created" }) },
      { Id: "two", MessageBody: JSON.stringify({ type: "checkout.confirmed" }) }
    ]
  },
  { client: logbrew, queueName: "orders" }
);

const output = await sqsReceiveMessageWithLogBrewSpan(
  sqs,
  ReceiveMessageCommand,
  { QueueUrl: queueUrl, MaxNumberOfMessages: 10 },
  { client: logbrew, queueName: "orders" }
);

const processMessage = withLogBrewSqsMessageProcessor(async (message) => {
  console.log("processing", message.MessageId);
}, { client: logbrew, queueName: "orders" });

for (const message of output.Messages ?? []) {
  await processMessage(message);
}
```

## What It Captures

The helpers create producer, receive, and message-processing spans with safe
messaging metadata: `messaging.system=aws_sqs`, queue name, operation type, and
message count for batch receives/sends. Producers inject one normalized W3C
`traceparent` SQS message attribute. Receive calls request the `traceparent`
attribute and add bounded span links for received messages that carry valid
trace context.

## What It Does Not Capture

This package does not monkey-patch AWS SDK clients, create SQS clients, own
delete/visibility/ack behavior, read message bodies, capture raw `QueueUrl`,
account IDs, regions, hosts, receipt handles, message IDs, arbitrary message
attributes, payloads, baggage, tracestate, or error messages/stacks.

If a message already has ten SQS message attributes and does not already have
`traceparent`, LogBrew leaves the attributes unchanged rather than violating the
SQS message-attribute limit.
