# `@logbrew/aws-sqs`

Amazon SQS tracing helpers for Node apps that use `@aws-sdk/client-sqs`, with
explicit SNS and EventBridge producer helpers for queues fed by those services.

This package is source-only until its first npm release. The npm and pnpm
commands below require the package to be available on npm; use a local checkout
when evaluating it before release.

```sh
npm install @logbrew/sdk @logbrew/node @logbrew/aws-sqs @aws-sdk/client-sqs
pnpm add @logbrew/sdk @logbrew/node @logbrew/aws-sqs @aws-sdk/client-sqs
```

If you also publish to SNS or EventBridge before messages arrive in SQS,
install the matching AWS SDK clients used by your app:

```sh
npm install @aws-sdk/client-sns @aws-sdk/client-eventbridge
pnpm add @aws-sdk/client-sns @aws-sdk/client-eventbridge
```

Use a project-scoped server ingest key, for example `LOGBREW_SERVER_API_KEY`.
Do not use dashboard login or session values as SDK ingest configuration.

```js
import { LogBrewClient } from "@logbrew/sdk";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { PublishBatchCommand, PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { SQSClient, SendMessageCommand, SendMessageBatchCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import {
  eventBridgePutEventsWithLogBrewSpan,
  extractLogBrewSqsTraceparent,
  instrumentLogBrewSqsClient,
  snsPublishBatchWithLogBrewSpan,
  snsPublishWithLogBrewSpan,
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
const sns = new SNSClient({ region: "us-east-1" });
const eventBridge = new EventBridgeClient({ region: "us-east-1" });
const queueUrl = process.env.ORDERS_QUEUE_URL;

await snsPublishWithLogBrewSpan(
  sns,
  PublishCommand,
  {
    TopicArn: process.env.ORDERS_TOPIC_ARN,
    Message: JSON.stringify({ type: "checkout.created" })
  },
  { client: logbrew, topicName: "orders" }
);

await snsPublishBatchWithLogBrewSpan(
  sns,
  PublishBatchCommand,
  {
    TopicArn: process.env.ORDERS_TOPIC_ARN,
    PublishBatchRequestEntries: [
      { Id: "one", Message: JSON.stringify({ type: "checkout.created" }) },
      { Id: "two", Message: JSON.stringify({ type: "checkout.confirmed" }) }
    ]
  },
  { client: logbrew, topicName: "orders" }
);

await eventBridgePutEventsWithLogBrewSpan(
  eventBridge,
  PutEventsCommand,
  {
    Entries: [{
      Source: "checkout",
      DetailType: "checkout.created",
      EventBusName: process.env.ORDERS_EVENT_BUS,
      Detail: JSON.stringify({ type: "checkout.created" })
    }]
  },
  { client: logbrew, eventBusName: "orders" }
);

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
}, {
  client: logbrew,
  queueName: "orders",
  extractSnsEnvelopeTraceparent: true
});

for (const message of output.Messages ?? []) {
  await processMessage(message);
}
```

For teams that want client-level automatic coverage without global patching,
instrument one app-owned SQS client explicitly:

```js
const sqsInstrumentation = instrumentLogBrewSqsClient(
  sqs,
  { SendMessageCommand, SendMessageBatchCommand, ReceiveMessageCommand },
  { client: logbrew, queueName: "orders" }
);

await sqs.send(new SendMessageCommand({
  QueueUrl: queueUrl,
  MessageBody: JSON.stringify({ type: "checkout.created" })
}));

sqsInstrumentation.uninstall();
```

The instrumentation only wraps that client instance's `send()` method, passes
unknown commands through unchanged, preserves AWS SDK send options, and
reinstates the prior `send()` function when uninstalled.

If your queue receives SNS notification envelopes or EventBridge events that
carry a W3C `traceparent`, opt in explicitly when linking receives or processing
messages:

```js
const traceparent = extractLogBrewSqsTraceparent(message, {
  extractSnsEnvelopeTraceparent: true,
  extractEventBridgeEnvelopeTraceparent: true
});

const processMessage = withLogBrewSqsMessageProcessor(handleMessage, {
  client: logbrew,
  queueName: "orders",
  extractSnsEnvelopeTraceparent: true,
  extractEventBridgeEnvelopeTraceparent: true
});
```

Envelope parsing is bounded to the SQS payload size by default and only returns
one normalized `traceparent`. LogBrew does not store or send the body,
EventBridge detail, SNS message, arbitrary message attributes, or malformed
propagation values. `extractEventBridgeEnvelopeTraceparent` also covers
EventBridge events wrapped by an SNS notification.

## What It Captures

The helpers create producer, receive, and message-processing spans with safe
messaging metadata: messaging system, destination label, operation type, and
message count for batch receives/sends. SQS and SNS producers inject one
normalized W3C `traceparent` message attribute. EventBridge producers inject a
normalized `traceparent` into JSON object `Detail` strings only when the cloned
`PutEvents` request stays within the configured size limit. Receive calls
request the `traceparent` attribute and add bounded span links for received
messages that carry valid trace context. With explicit opt-in, receive and
processor helpers can also continue W3C trace context from SNS notification
envelopes and EventBridge `detail.traceparent` values delivered through SQS.

## What It Does Not Capture

This package does not globally monkey-patch AWS SDK modules, create SQS clients,
SNS clients, or EventBridge clients, own delete/visibility/ack behavior, capture
raw `QueueUrl`, ARNs, account IDs, regions, hosts, receipt handles, message IDs,
EventBridge event IDs, arbitrary message attributes, payloads, baggage,
tracestate, or error messages/stacks. It only parses message bodies when you opt
in to SNS/EventBridge trace extraction, and that path keeps payload bytes out of
telemetry. The optional client instrumentation is explicit, one-client-only, and
reversible.

If a message already has ten SQS message attributes and does not already have
`traceparent`, LogBrew leaves the attributes unchanged rather than violating the
SQS message-attribute limit.

SNS publish helpers use the same ten-message-attribute guard. EventBridge
helpers leave entries unchanged when `Detail` is not JSON or trace injection
would exceed the bounded `PutEvents` request size.
