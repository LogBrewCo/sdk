#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sdk_package_version="$(node -p "require('${repo_root}/js/logbrew-js/package.json').version")"
node_package_version="$(node -p "require('${repo_root}/js/logbrew-node/package.json').version")"
aws_sqs_package_version="$(node -p "require('${repo_root}/js/logbrew-aws-sqs/package.json').version")"
tmp_dir="$(mktemp -d)"
export npm_config_cache="$tmp_dir/npm-cache"

remove_tmp_dir() {
  rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT

core_pack_json="$tmp_dir/core-pack.json"
node_pack_json="$tmp_dir/node-pack.json"
sqs_pack_json="$tmp_dir/aws-sqs-pack.json"
(cd "$repo_root/js/logbrew-js" && npm pack --json --pack-destination "$tmp_dir") > "$core_pack_json"
(cd "$repo_root/js/logbrew-node" && npm pack --json --pack-destination "$tmp_dir") > "$node_pack_json"
(cd "$repo_root/js/logbrew-aws-sqs" && npm pack --json --pack-destination "$tmp_dir") > "$sqs_pack_json"

package_tgz() {
  python3 - "$1" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
print(payload[0]["filename"])
PY
}

core_tgz="$tmp_dir/$(package_tgz "$core_pack_json")"
node_tgz="$tmp_dir/$(package_tgz "$node_pack_json")"
sqs_tgz="$tmp_dir/$(package_tgz "$sqs_pack_json")"
test -f "$core_tgz"
test -f "$node_tgz"
test -f "$sqs_tgz"

tar -tzf "$sqs_tgz" > "$tmp_dir/aws-sqs-tarball.txt"
grep -q '^package/README.md$' "$tmp_dir/aws-sqs-tarball.txt"
grep -q '^package/index.js$' "$tmp_dir/aws-sqs-tarball.txt"
grep -q '^package/index.cjs$' "$tmp_dir/aws-sqs-tarball.txt"
grep -q '^package/index.d.ts$' "$tmp_dir/aws-sqs-tarball.txt"
grep -q '^package/index.d.cts$' "$tmp_dir/aws-sqs-tarball.txt"
grep -q '^package/examples/index.mjs$' "$tmp_dir/aws-sqs-tarball.txt"
grep -q '^package/examples/readme-example.mjs$' "$tmp_dir/aws-sqs-tarball.txt"
grep -q '^package/examples/real-user-smoke.mjs$' "$tmp_dir/aws-sqs-tarball.txt"
tar -xOf "$sqs_tgz" package/README.md > "$tmp_dir/aws-sqs-readme.md"
grep -q 'npm install @logbrew/sdk @logbrew/node @logbrew/aws-sqs @aws-sdk/client-sqs' "$tmp_dir/aws-sqs-readme.md"
grep -q 'pnpm add @logbrew/sdk @logbrew/node @logbrew/aws-sqs @aws-sdk/client-sqs' "$tmp_dir/aws-sqs-readme.md"
grep -q 'LOGBREW_SERVER_API_KEY' "$tmp_dir/aws-sqs-readme.md"
grep -q 'project-scoped server ingest key' "$tmp_dir/aws-sqs-readme.md"
grep -q 'sqsSendMessageWithLogBrewSpan' "$tmp_dir/aws-sqs-readme.md"
grep -q 'sqsSendMessageBatchWithLogBrewSpan' "$tmp_dir/aws-sqs-readme.md"
grep -q 'sqsReceiveMessageWithLogBrewSpan' "$tmp_dir/aws-sqs-readme.md"
grep -q 'instrumentLogBrewSqsClient' "$tmp_dir/aws-sqs-readme.md"
grep -q 'extractSnsEnvelopeTraceparent' "$tmp_dir/aws-sqs-readme.md"
grep -q 'extractEventBridgeEnvelopeTraceparent' "$tmp_dir/aws-sqs-readme.md"
grep -q 'snsPublishWithLogBrewSpan' "$tmp_dir/aws-sqs-readme.md"
grep -q 'eventBridgePutEventsWithLogBrewSpan' "$tmp_dir/aws-sqs-readme.md"

app_dir="$tmp_dir/aws-sqs-smoke-app"
mkdir -p "$app_dir"
cd "$app_dir"
npm init -y >/dev/null
npm pkg set type=module >/dev/null
npm install \
  --save-exact \
  --no-audit \
  --fund=false \
  "$core_tgz" \
  "$node_tgz" \
  "$sqs_tgz" \
  @aws-sdk/client-eventbridge@3.1075.0 \
  @aws-sdk/client-sns@3.1075.0 \
  @aws-sdk/client-sqs@3.1075.0 \
  typescript@6.0.3 \
  @types/node@26.0.1 \
  >/dev/null

grep -q '"@logbrew/sdk": "file:' package.json
grep -q '"@logbrew/node": "file:' package.json
grep -q '"@logbrew/aws-sqs": "file:' package.json
grep -q '"@aws-sdk/client-eventbridge": "3.1075.0"' package.json
grep -q '"@aws-sdk/client-sns": "3.1075.0"' package.json
grep -q '"@aws-sdk/client-sqs": "3.1075.0"' package.json
grep -q '"@logbrew/aws-sqs"' package-lock.json
grep -q '"@logbrew/node"' package-lock.json
grep -q '"@logbrew/sdk"' package-lock.json
npm ls @logbrew/sdk @logbrew/node @logbrew/aws-sqs @aws-sdk/client-eventbridge @aws-sdk/client-sns @aws-sdk/client-sqs >/dev/null
npm list --depth=0 > "$tmp_dir/npm-list-depth0.txt"
grep -q "@logbrew/sdk@${sdk_package_version}" "$tmp_dir/npm-list-depth0.txt"
grep -q "@logbrew/node@${node_package_version}" "$tmp_dir/npm-list-depth0.txt"
grep -q "@logbrew/aws-sqs@${aws_sqs_package_version}" "$tmp_dir/npm-list-depth0.txt"
grep -q '@aws-sdk/client-eventbridge@3.1075.0' "$tmp_dir/npm-list-depth0.txt"
grep -q '@aws-sdk/client-sns@3.1075.0' "$tmp_dir/npm-list-depth0.txt"
grep -q '@aws-sdk/client-sqs@3.1075.0' "$tmp_dir/npm-list-depth0.txt"
test -f node_modules/@logbrew/aws-sqs/index.js
test -f node_modules/@logbrew/aws-sqs/index.cjs
test -f node_modules/@logbrew/aws-sqs/index.d.ts

cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "noEmit": true,
    "strict": true,
    "target": "ES2022",
    "types": ["node"]
  },
  "include": ["types.ts"]
}
EOF

cat > types.ts <<'EOF'
import { LogBrewClient } from "@logbrew/sdk";
import { PutEventsCommand, type EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { PublishBatchCommand, PublishCommand, type SNSClient } from "@aws-sdk/client-sns";
import {
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SendMessageCommand,
  SQSClient,
  type Message
} from "@aws-sdk/client-sqs";
import {
  createLogBrewEventBridgePutEventsInput,
  createLogBrewSnsPublishBatchInput,
  createLogBrewSnsPublishInput,
  createLogBrewSqsReceiveMessageInput,
  createLogBrewSqsSendMessageBatchInput,
  createLogBrewSqsSendMessageInput,
  eventBridgePutEventsWithLogBrewSpan,
  extractLogBrewSqsTraceparent,
  instrumentLogBrewSqsClient,
  snsPublishBatchWithLogBrewSpan,
  snsPublishWithLogBrewSpan,
  type LogBrewSqsTraceExtractionOptions,
  sqsReceiveMessageWithLogBrewSpan,
  sqsSendMessageBatchWithLogBrewSpan,
  sqsSendMessageWithLogBrewSpan,
  withLogBrewSqsMessageProcessor
} from "@logbrew/aws-sqs";

const client = LogBrewClient.create({
  apiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "aws-sqs-type-smoke",
  sdkVersion: "0.1.0"
});
declare const eventBridgeClient: EventBridgeClient;
declare const snsClient: SNSClient;
declare const sqsClient: SQSClient;
declare const message: Message;
const queueUrl = "https://sqs.us-east-1.amazonaws.com/123456789012/orders";
const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const extractionOptions: LogBrewSqsTraceExtractionOptions = {
  extractEventBridgeEnvelopeTraceparent: true,
  extractSnsEnvelopeTraceparent: true,
  maxEnvelopeBytes: 4096
};
const sendInput = createLogBrewSqsSendMessageInput({ QueueUrl: queueUrl, MessageBody: "hello" }, traceparent);
const batchInput = createLogBrewSqsSendMessageBatchInput({
  QueueUrl: queueUrl,
  Entries: [{ Id: "1", MessageBody: "hello" }]
}, traceparent);
const snsInput = createLogBrewSnsPublishInput({
  TopicArn: "arn:aws:sns:us-east-1:123456789012:orders",
  Message: "hello"
}, traceparent);
const snsBatchInput = createLogBrewSnsPublishBatchInput({
  TopicArn: "arn:aws:sns:us-east-1:123456789012:orders",
  PublishBatchRequestEntries: [{ Id: "1", Message: "hello" }]
}, traceparent);
const eventBridgeInput = createLogBrewEventBridgePutEventsInput({
  Entries: [{ Source: "checkout", DetailType: "created", Detail: "{\"type\":\"checkout.created\"}" }]
}, traceparent);
const receiveInput = createLogBrewSqsReceiveMessageInput({ QueueUrl: queueUrl, MessageAttributeNames: ["custom"] });
const extracted = extractLogBrewSqsTraceparent(message, extractionOptions);
const snsResult = snsPublishWithLogBrewSpan(snsClient, PublishCommand, snsInput, { client, topicName: "orders" });
const snsBatchResult = snsPublishBatchWithLogBrewSpan(snsClient, PublishBatchCommand, snsBatchInput, { client, topicName: "orders" });
const eventBridgeResult = eventBridgePutEventsWithLogBrewSpan(eventBridgeClient, PutEventsCommand, eventBridgeInput, { client, eventBusName: "checkout" });
const sendResult = sqsSendMessageWithLogBrewSpan(sqsClient, SendMessageCommand, sendInput, { client });
const batchResult = sqsSendMessageBatchWithLogBrewSpan(sqsClient, SendMessageBatchCommand, batchInput, { client });
const receiveResult = sqsReceiveMessageWithLogBrewSpan(sqsClient, ReceiveMessageCommand, receiveInput, { client, ...extractionOptions });
const processMessage = withLogBrewSqsMessageProcessor(async (msg: Message) => msg.MessageId, { client, queueName: "orders", ...extractionOptions });
const instrumentation = instrumentLogBrewSqsClient(
  sqsClient,
  { ReceiveMessageCommand, SendMessageBatchCommand, SendMessageCommand },
  { client, queueName: "orders" }
);
const installed = instrumentation.isInstalled();
instrumentation.uninstall();

void extracted;
void snsResult;
void snsBatchResult;
void eventBridgeResult;
void sendResult;
void batchResult;
void receiveResult;
void processMessage(message);
void installed;
EOF

npx tsc --noEmit

cat > cjs-smoke.cjs <<'EOF'
const logbrewSqs = require("@logbrew/aws-sqs");

if (typeof logbrewSqs.sqsSendMessageWithLogBrewSpan !== "function") {
  throw new Error("missing CommonJS send export");
}
if (typeof logbrewSqs.instrumentLogBrewSqsClient !== "function") {
  throw new Error("missing CommonJS instrumentation export");
}
if (typeof logbrewSqs.default.withLogBrewSqsMessageProcessor !== "function") {
  throw new Error("missing CommonJS default export");
}
if (typeof logbrewSqs.snsPublishWithLogBrewSpan !== "function") {
  throw new Error("missing CommonJS SNS publish export");
}
if (typeof logbrewSqs.eventBridgePutEventsWithLogBrewSpan !== "function") {
  throw new Error("missing CommonJS EventBridge publish export");
}
EOF

node cjs-smoke.cjs

cat > smoke.mjs <<'EOF'
import http from "node:http";
import { once } from "node:events";
import { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { PublishBatchCommand, PublishCommand } from "@aws-sdk/client-sns";
import {
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SendMessageCommand,
  SQSClient
} from "@aws-sdk/client-sqs";
import { LogBrewClient } from "@logbrew/sdk";
import { createNodeFetchTransport } from "@logbrew/node";
import {
  createLogBrewEventBridgePutEventsInput,
  createLogBrewSnsPublishBatchInput,
  createLogBrewSnsPublishInput,
  createLogBrewSqsReceiveMessageInput,
  createLogBrewSqsSendMessageBatchInput,
  createLogBrewSqsSendMessageInput,
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

const client = LogBrewClient.create({
  apiKey: "LOGBREW_SERVER_API_KEY",
  maxRetries: 1,
  sdkName: "aws-sqs-smoke-app",
  sdkVersion: "0.1.0"
});

const capturedCommands = [];
const capturedEventBridgeCommands = [];
const capturedSnsCommands = [];
const eventBridgeClient = {
  async send(command) {
    capturedEventBridgeCommands.push(command);
    if (command instanceof PutEventsCommand) {
      return { Entries: [{ EventId: "event-id-must-not-appear" }] };
    }
    throw new Error("unexpected EventBridge command");
  }
};
const snsClient = {
  async send(command) {
    capturedSnsCommands.push(command);
    if (command instanceof PublishCommand) {
      return { MessageId: "sns-message-id-must-not-appear" };
    }
    if (command instanceof PublishBatchCommand) {
      return { Successful: [{ Id: "a", MessageId: "sns-batch-id-must-not-appear" }] };
    }
    throw new Error("unexpected SNS command");
  }
};
const sqsClient = {
  async send(command) {
    capturedCommands.push(command);
    if (command instanceof SendMessageCommand) {
      return { MessageId: "msg-1" };
    }
    if (command instanceof SendMessageBatchCommand) {
      return { Successful: [{ Id: "a", MessageId: "msg-a" }] };
    }
    if (command instanceof ReceiveMessageCommand) {
      return {
        Messages: [
          {
            MessageId: "msg-1",
            MessageAttributes: {
              traceparent: {
                DataType: "String",
                StringValue: capturedTraceparent()
              }
            }
          },
          snsWrappedMessage,
          {
            MessageId: "msg-2",
            MessageAttributes: {
              traceparent: {
                DataType: "String",
                StringValue: "malformed"
              }
            }
          }
        ]
      };
    }
    throw new Error("unexpected command");
  }
};

const queueUrl = "https://sqs.us-east-1.amazonaws.com/123456789012/orders";
const snsEnvelopeTraceparent = "00-11111111111111111111111111111111-2222222222222222-01";
const eventBridgeTraceparent = "00-33333333333333333333333333333333-4444444444444444-01";
const input = {
  QueueUrl: queueUrl,
  MessageBody: "body must not appear",
  MessageAttributes: {
    app: { DataType: "String", StringValue: "checkout" }
  }
};
const cloned = createLogBrewSqsSendMessageInput(input, "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
if (cloned === input || cloned.MessageAttributes === input.MessageAttributes) {
  throw new Error("SQS send input was not cloned");
}
if (input.MessageAttributes.traceparent) {
  throw new Error("SQS helper mutated caller message attributes");
}
if (cloned.MessageAttributes.traceparent.StringValue !== "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01") {
  throw new Error("SQS helper did not inject normalized traceparent");
}

const fullAttributes = {};
for (let index = 0; index < 10; index += 1) {
  fullAttributes[`a${index}`] = { DataType: "String", StringValue: String(index) };
}
const fullInput = createLogBrewSqsSendMessageInput({ QueueUrl: queueUrl, MessageBody: "hello", MessageAttributes: fullAttributes }, "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
if (fullInput.MessageAttributes.traceparent) {
  throw new Error("SQS helper exceeded the message attribute limit");
}

const snsTopicArn = "arn:aws:sns:us-east-1:123456789012:orders-topic";
const snsInput = {
  TopicArn: snsTopicArn,
  Message: "sns message body must not appear",
  MessageAttributes: {
    app: { DataType: "String", StringValue: "checkout" }
  }
};
const clonedSnsInput = createLogBrewSnsPublishInput(snsInput, "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
if (clonedSnsInput === snsInput || clonedSnsInput.MessageAttributes === snsInput.MessageAttributes) {
  throw new Error("SNS publish input was not cloned");
}
if (snsInput.MessageAttributes.traceparent) {
  throw new Error("SNS helper mutated caller message attributes");
}
if (clonedSnsInput.MessageAttributes.traceparent.StringValue !== "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01") {
  throw new Error("SNS helper did not inject normalized traceparent");
}
const fullSnsInput = createLogBrewSnsPublishInput({ TopicArn: snsTopicArn, Message: "hello", MessageAttributes: fullAttributes }, "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
if (fullSnsInput.MessageAttributes.traceparent) {
  throw new Error("SNS helper exceeded the message attribute limit");
}
const snsBatchInput = createLogBrewSnsPublishBatchInput({
  TopicArn: snsTopicArn,
  PublishBatchRequestEntries: [
    { Id: "a", Message: "sns batch body one", MessageAttributes: { app: { DataType: "String", StringValue: "checkout" } } },
    { Id: "b", Message: "sns batch body two" }
  ]
}, "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
if (!snsBatchInput.PublishBatchRequestEntries.every((entry) => extractLogBrewSqsTraceparent(entry))) {
  throw new Error("SNS batch helper did not inject traceparent into every entry");
}

const eventBridgeInput = {
  Entries: [
    {
      EventBusName: "orders-bus",
      Source: "checkout.source.must.not.appear",
      DetailType: "checkout.created",
      Detail: JSON.stringify({ type: "checkout.created", payload: "event detail must not appear" })
    }
  ]
};
const clonedEventBridgeInput = createLogBrewEventBridgePutEventsInput(eventBridgeInput, "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
if (clonedEventBridgeInput === eventBridgeInput || clonedEventBridgeInput.Entries === eventBridgeInput.Entries) {
  throw new Error("EventBridge input was not cloned");
}
if (eventBridgeInput.Entries[0].Detail.includes("traceparent")) {
  throw new Error("EventBridge helper mutated caller detail");
}
if (JSON.parse(clonedEventBridgeInput.Entries[0].Detail).traceparent !== "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01") {
  throw new Error("EventBridge helper did not inject normalized traceparent");
}
const invalidEventBridgeInput = createLogBrewEventBridgePutEventsInput({ Entries: [{ Detail: "not-json" }] }, "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
if (invalidEventBridgeInput.Entries[0].Detail !== "not-json") {
  throw new Error("EventBridge helper changed non-JSON detail");
}
const oversizedDetail = JSON.stringify({ payload: "x".repeat(1024 * 1024) });
const oversizedEventBridgeInput = createLogBrewEventBridgePutEventsInput({ Entries: [{ Detail: oversizedDetail }] }, "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
if (oversizedEventBridgeInput.Entries[0].Detail !== oversizedDetail) {
  throw new Error("EventBridge helper injected into an oversized request");
}
const aliasLimitedEventBridgeInput = createLogBrewEventBridgePutEventsInput({ Entries: [{ Detail: "{\"type\":\"alias\"}" }] }, "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", { maxEventBridgeRequestBytes: 1 });
if (aliasLimitedEventBridgeInput.Entries[0].Detail.includes("traceparent")) {
  throw new Error("EventBridge helper ignored maxEventBridgeRequestBytes");
}

const receiveInput = createLogBrewSqsReceiveMessageInput({ QueueUrl: queueUrl, MessageAttributeNames: ["custom"] });
if (!receiveInput.MessageAttributeNames.includes("traceparent") || !receiveInput.MessageAttributeNames.includes("custom")) {
  throw new Error("SQS receive input did not request traceparent");
}
const allReceiveInput = createLogBrewSqsReceiveMessageInput({ QueueUrl: queueUrl, MessageAttributeNames: ["All"] });
if (allReceiveInput.MessageAttributeNames.filter((name) => name === "traceparent").length !== 0) {
  throw new Error("SQS receive input duplicated traceparent when All is present");
}

const snsWrappedMessage = {
  MessageId: "sns-msg-1",
  Body: JSON.stringify({
    Type: "Notification",
    Message: "SNS payload must not appear",
    MessageAttributes: {
      traceparent: {
        Type: "String",
        Value: snsEnvelopeTraceparent
      }
    }
  })
};
const eventBridgeMessage = {
  MessageId: "eventbridge-msg-1",
  Body: JSON.stringify({
    version: "0",
    id: "eventbridge-event-id",
    "detail-type": "checkout.created",
    source: "checkout.app",
    detail: {
      traceparent: eventBridgeTraceparent,
      payload: "eventbridge detail must not appear"
    }
  })
};
const snsWrappedEventBridgeMessage = {
  Body: JSON.stringify({
    Type: "Notification",
    Message: JSON.stringify({
      version: "0",
      "detail-type": "checkout.confirmed",
      source: "checkout.app",
      detail: { traceparent: eventBridgeTraceparent }
    })
  })
};
if (extractLogBrewSqsTraceparent(snsWrappedMessage) !== undefined) {
  throw new Error("SQS helper parsed SNS body without explicit opt-in");
}
if (extractLogBrewSqsTraceparent(eventBridgeMessage) !== undefined) {
  throw new Error("SQS helper parsed EventBridge body without explicit opt-in");
}
if (extractLogBrewSqsTraceparent(snsWrappedMessage, { extractSnsEnvelopeTraceparent: true }) !== snsEnvelopeTraceparent) {
  throw new Error("SQS helper did not extract SNS envelope traceparent");
}
if (extractLogBrewSqsTraceparent(eventBridgeMessage, { extractEventBridgeEnvelopeTraceparent: true }) !== eventBridgeTraceparent) {
  throw new Error("SQS helper did not extract EventBridge detail traceparent");
}
if (extractLogBrewSqsTraceparent(snsWrappedEventBridgeMessage, {
  extractEventBridgeEnvelopeTraceparent: true,
  extractSnsEnvelopeTraceparent: true
}) !== eventBridgeTraceparent) {
  throw new Error("SQS helper did not extract SNS-wrapped EventBridge traceparent");
}
if (extractLogBrewSqsTraceparent(snsWrappedEventBridgeMessage, {
  extractEventBridgeEnvelopeTraceparent: true
}) !== eventBridgeTraceparent) {
  throw new Error("SQS helper made SNS-wrapped EventBridge extraction depend on the SNS flag");
}
if (extractLogBrewSqsTraceparent({ Body: "not-json" }, {
  extractEventBridgeEnvelopeTraceparent: true,
  extractSnsEnvelopeTraceparent: true
}) !== undefined) {
  throw new Error("SQS helper did not tolerate malformed envelope JSON");
}
if (extractLogBrewSqsTraceparent({
  Body: JSON.stringify({
    Type: "Notification",
    MessageAttributes: { traceparent: { Type: "String", Value: "malformed" } }
  })
}, { extractSnsEnvelopeTraceparent: true }) !== undefined) {
  throw new Error("SQS helper accepted malformed SNS envelope traceparent");
}

await sqsSendMessageWithLogBrewSpan(sqsClient, SendMessageCommand, input, { client });
await snsPublishWithLogBrewSpan(snsClient, PublishCommand, snsInput, {
  client,
  id: "evt_sns_publish_001",
  topicName: "orders-topic"
});
await snsPublishBatchWithLogBrewSpan(snsClient, PublishBatchCommand, {
  TopicArn: snsTopicArn,
  PublishBatchRequestEntries: [
    { Id: "a", Message: "sns batch body one" },
    { Id: "b", Message: "sns batch body two" }
  ]
}, {
  client,
  id: "evt_sns_batch_001",
  topicName: "orders-topic"
});
await eventBridgePutEventsWithLogBrewSpan(eventBridgeClient, PutEventsCommand, eventBridgeInput, {
  client,
  eventBusName: "orders-events",
  id: "evt_eventbridge_put_001"
});
await sqsSendMessageBatchWithLogBrewSpan(sqsClient, SendMessageBatchCommand, {
  QueueUrl: queueUrl,
  Entries: [
    { Id: "a", MessageBody: "first", MessageAttributes: { app: { DataType: "String", StringValue: "checkout" } } },
    { Id: "b", MessageBody: "second" }
  ]
}, { client });
const receiveOutput = await sqsReceiveMessageWithLogBrewSpan(sqsClient, ReceiveMessageCommand, { QueueUrl: queueUrl }, {
  client,
  extractSnsEnvelopeTraceparent: true,
  id: "evt_sqs_receive_001"
});
const processor = withLogBrewSqsMessageProcessor(async (message) => message.MessageId, { client, queueName: "orders" });
await processor(receiveOutput.Messages[0]);
const snsProcessor = withLogBrewSqsMessageProcessor(async (message) => message.MessageId, {
  client,
  extractSnsEnvelopeTraceparent: true,
  id: "evt_sqs_sns_process_001",
  queueName: "orders",
  spanIdFactory: () => "5555555555555555"
});
await snsProcessor(snsWrappedMessage);
const failingProcessor = withLogBrewSqsMessageProcessor(() => {
  throw new TypeError("details must not appear");
}, { client, queueName: "orders" });
try {
  await failingProcessor(receiveOutput.Messages[0]);
  throw new Error("expected failing processor");
} catch (error) {
  if (!(error instanceof TypeError)) {
    throw error;
  }
}

if (capturedCommands.length !== 3) {
  throw new Error(`expected 3 SQS commands, saw ${capturedCommands.length}`);
}
if (capturedSnsCommands.length !== 2) {
  throw new Error(`expected 2 SNS commands, saw ${capturedSnsCommands.length}`);
}
if (!extractLogBrewSqsTraceparent(capturedSnsCommands[0].input)) {
  throw new Error("SNS publish command missing traceparent");
}
if (!capturedSnsCommands[1].input.PublishBatchRequestEntries.every((entry) => extractLogBrewSqsTraceparent(entry))) {
  throw new Error("SNS batch command missing entry traceparents");
}
if (capturedEventBridgeCommands.length !== 1) {
  throw new Error(`expected 1 EventBridge command, saw ${capturedEventBridgeCommands.length}`);
}
const eventBridgeCommandTraceparent = JSON.parse(capturedEventBridgeCommands[0].input.Entries[0].Detail).traceparent;
if (typeof eventBridgeCommandTraceparent !== "string" || eventBridgeCommandTraceparent.split("-").length !== 4) {
  throw new Error("EventBridge command missing detail traceparent");
}
if (capturedCommands[0].input.MessageBody !== "body must not appear") {
  throw new Error("SQS send command changed message body");
}
if (capturedCommands[0].input === input || capturedCommands[0].input.MessageAttributes === input.MessageAttributes) {
  throw new Error("SQS send command reused mutable caller input");
}
if (!extractLogBrewSqsTraceparent(capturedCommands[0].input)) {
  throw new Error("SQS send command missing traceparent");
}
if (!capturedCommands[1].input.Entries.every((entry) => extractLogBrewSqsTraceparent(entry))) {
  throw new Error("SQS batch command missing entry traceparents");
}
if (!capturedCommands[2].input.MessageAttributeNames.includes("traceparent")) {
  throw new Error("SQS receive command did not request traceparent");
}

const queuedPayload = JSON.parse(client.previewJson());
const snsPublishSpan = queuedPayload.events.find((event) => event.id === "evt_sns_publish_001");
if (!snsPublishSpan || snsPublishSpan.attributes.metadata["messaging.system"] !== "aws_sns") {
  throw new Error("SNS publish span was not queued with SNS metadata");
}
const snsBatchSpan = queuedPayload.events.find((event) => event.id === "evt_sns_batch_001");
if (!snsBatchSpan || snsBatchSpan.attributes.metadata["messaging.batch.message_count"] !== 2) {
  throw new Error("SNS batch span did not record the publish batch count");
}
const eventBridgeSpan = queuedPayload.events.find((event) => event.id === "evt_eventbridge_put_001");
if (!eventBridgeSpan || eventBridgeSpan.attributes.metadata["messaging.system"] !== "aws_eventbridge") {
  throw new Error("EventBridge put span was not queued with EventBridge metadata");
}
const receiveSpan = queuedPayload.events.find((event) => event.id === "evt_sqs_receive_001");
if (!receiveSpan) {
  throw new Error("SQS receive span was not queued");
}
if (receiveSpan.attributes.metadata["messaging.batch.message_count"] !== 3) {
  throw new Error("SQS receive span did not record the received message count");
}
if (!Array.isArray(receiveSpan.attributes.links) || receiveSpan.attributes.links.length !== 2) {
  throw new Error("SQS receive span did not include the generated message trace link");
}
const [, expectedTraceId, expectedSpanId] = capturedTraceparent().split("-");
if (receiveSpan.attributes.links[0].traceId !== expectedTraceId || receiveSpan.attributes.links[0].spanId !== expectedSpanId) {
  throw new Error("SQS receive span link did not match the message traceparent");
}
if (receiveSpan.attributes.links[0].metadata?.relation !== "sqs_receive") {
  throw new Error("SQS receive span link did not keep its relation metadata");
}
if (receiveSpan.attributes.links[1].traceId !== snsEnvelopeTraceparent.split("-")[1]) {
  throw new Error("SQS receive span did not link the SNS envelope traceparent");
}
const snsProcessSpan = queuedPayload.events.find((event) => event.id === "evt_sqs_sns_process_001");
if (!snsProcessSpan) {
  throw new Error("SQS SNS processor span was not queued");
}
if (snsProcessSpan.attributes.traceId !== snsEnvelopeTraceparent.split("-")[1] || snsProcessSpan.attributes.parentSpanId !== snsEnvelopeTraceparent.split("-")[2]) {
  throw new Error("SQS SNS processor did not continue the envelope traceparent");
}

const events = [];
const server = http.createServer(async (req, res) => {
  const body = await new Promise((resolve) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
  });
  events.push(JSON.parse(body));
  res.writeHead(events.length === 1 ? 503 : 202, { "content-type": "application/json" });
  res.end("{}");
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const endpoint = `http://127.0.0.1:${server.address().port}/v1/events`;
const transport = createNodeFetchTransport({ endpoint, timeoutMs: 2000 });
const response = await client.flush(transport);
server.close();
await once(server, "close");

if (events.length !== 2) {
  throw new Error(`expected retryable flush to hit fake intake twice, got ${events.length}`);
}
if (response.statusCode !== 202 || response.attempts !== 2) {
  throw new Error(`expected retryable flush success, got status=${response.statusCode} attempts=${response.attempts}`);
}
const payloadText = JSON.stringify(events);
for (const forbidden of [
  "body must not appear",
  "first",
  "second",
  "SNS payload must not appear",
  "sns message body must not appear",
  "sns batch body",
  "sns-message-id",
  "event-id-must-not-appear",
  "eventbridge detail must not appear",
  "eventbridge-event-id",
  "event detail must not appear",
  "checkout.source.must.not.appear",
  "arn:aws:sns",
  "123456789012",
  "sqs.us-east-1.amazonaws.com",
  "details must not appear",
  "msg-1",
  "msg-2",
  "checkout"
]) {
  if (payloadText.includes(forbidden)) {
    throw new Error(`SQS payload leaked ${forbidden}`);
  }
}
for (const expected of ["aws_sqs", "aws_sns", "aws_eventbridge", "orders", "orders-topic", "orders-events", "publish", "receive", "process", "exception", "TypeError"]) {
  if (!payloadText.includes(expected)) {
    throw new Error(`SQS payload missing ${expected}`);
  }
}
if (client.pendingEvents() !== 0) {
  throw new Error("client queue did not drain");
}

const instrumentationClient = LogBrewClient.create({
  apiKey: "LOGBREW_SERVER_API_KEY",
  maxRetries: 1,
  sdkName: "aws-sqs-instrumentation-smoke",
  sdkVersion: "0.1.0"
});
const instrumentedCommands = [];
const instrumentedSqsClient = {
  async send(command, sendOptions) {
    instrumentedCommands.push({ command, sendOptions });
    if (command instanceof SendMessageCommand) {
      return { MessageId: "auto-msg-1" };
    }
    if (command instanceof SendMessageBatchCommand) {
      return { Successful: [{ Id: "auto-a", MessageId: "auto-msg-a" }] };
    }
    if (command instanceof ReceiveMessageCommand) {
      return {
        Messages: [
          {
            MessageId: "auto-msg-2",
            MessageAttributes: {
              traceparent: {
                DataType: "String",
                StringValue: extractLogBrewSqsTraceparent(instrumentedCommands[0].command.input)
              }
            }
          }
        ]
      };
    }
    return { passthrough: true, sendOptions };
  }
};
const instrumentation = instrumentLogBrewSqsClient(
  instrumentedSqsClient,
  { ReceiveMessageCommand, SendMessageBatchCommand, SendMessageCommand },
  { client: instrumentationClient, queueName: "orders" }
);
if (!instrumentation.isInstalled()) {
  throw new Error("SQS instrumentation did not report installed");
}
try {
  instrumentLogBrewSqsClient(
    instrumentedSqsClient,
    { ReceiveMessageCommand, SendMessageBatchCommand, SendMessageCommand },
    { client: instrumentationClient, queueName: "orders" }
  );
  throw new Error("expected duplicate instrumentation to fail");
} catch (error) {
  if (error.code !== "configuration_error") {
    throw error;
  }
}

const originalSendBeforeUninstall = instrumentedSqsClient.send;
await instrumentedSqsClient.send(new SendMessageCommand({
  QueueUrl: queueUrl,
  MessageBody: "automatic body must not appear",
  MessageAttributes: {
    app: { DataType: "String", StringValue: "checkout" }
  }
}), { abortSignal: "kept" });
await instrumentedSqsClient.send(new SendMessageBatchCommand({
  QueueUrl: queueUrl,
  Entries: [
    { Id: "auto-a", MessageBody: "automatic batch body", MessageAttributes: { app: { DataType: "String", StringValue: "checkout" } } },
    { Id: "auto-b", MessageBody: "automatic batch body two" }
  ]
}));
await instrumentedSqsClient.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MessageAttributeNames: ["custom"] }));
const passthroughResult = await instrumentedSqsClient.send({ input: { QueueUrl: queueUrl } }, { marker: "passthrough" });
if (passthroughResult.passthrough !== true || passthroughResult.sendOptions?.marker !== "passthrough") {
  throw new Error("SQS instrumentation did not pass unknown commands through");
}
if (instrumentedCommands.length !== 4) {
  throw new Error(`expected 4 instrumented sends, saw ${instrumentedCommands.length}`);
}
if (!extractLogBrewSqsTraceparent(instrumentedCommands[0].command.input)) {
  throw new Error("instrumented SQS send did not inject traceparent");
}
if (!instrumentedCommands[1].command.input.Entries.every((entry) => extractLogBrewSqsTraceparent(entry))) {
  throw new Error("instrumented SQS batch did not inject traceparent into every entry");
}
if (!instrumentedCommands[2].command.input.MessageAttributeNames.includes("traceparent")) {
  throw new Error("instrumented SQS receive did not request traceparent");
}
if (instrumentedCommands[0].sendOptions?.abortSignal !== "kept") {
  throw new Error("instrumented SQS send did not preserve send options");
}
instrumentation.uninstall();
if (instrumentation.isInstalled()) {
  throw new Error("SQS instrumentation still reported installed after uninstall");
}
if (instrumentedSqsClient.send === originalSendBeforeUninstall) {
  throw new Error("SQS instrumentation did not put back the prior send method");
}
await instrumentedSqsClient.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: "after uninstall" }));
if (instrumentedCommands.length !== 5 || extractLogBrewSqsTraceparent(instrumentedCommands[4].command.input)) {
  throw new Error("SQS instrumentation kept modifying commands after uninstall");
}

const instrumentationEvents = [];
const instrumentationServer = http.createServer(async (req, res) => {
  const body = await new Promise((resolve) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
  });
  instrumentationEvents.push(JSON.parse(body));
  res.writeHead(instrumentationEvents.length === 1 ? 503 : 202, { "content-type": "application/json" });
  res.end("{}");
});
instrumentationServer.listen(0, "127.0.0.1");
await once(instrumentationServer, "listening");
const instrumentationEndpoint = `http://127.0.0.1:${instrumentationServer.address().port}/v1/events`;
const instrumentationTransport = createNodeFetchTransport({ endpoint: instrumentationEndpoint, timeoutMs: 2000 });
const instrumentationResponse = await instrumentationClient.flush(instrumentationTransport);
instrumentationServer.close();
await once(instrumentationServer, "close");
if (instrumentationEvents.length !== 2 || instrumentationResponse.statusCode !== 202 || instrumentationResponse.attempts !== 2) {
  throw new Error(`expected instrumentation retry success, got requests=${instrumentationEvents.length} status=${instrumentationResponse.statusCode} attempts=${instrumentationResponse.attempts}`);
}
const instrumentationPayloadText = JSON.stringify(instrumentationEvents);
for (const forbidden of [
  "automatic body must not appear",
  "automatic batch body",
  "after uninstall",
  "auto-msg",
  "123456789012",
  "sqs.us-east-1.amazonaws.com",
  "checkout"
]) {
  if (instrumentationPayloadText.includes(forbidden)) {
    throw new Error(`instrumented SQS payload leaked ${forbidden}`);
  }
}
for (const expected of ["aws_sqs", "orders", "publish", "receive"]) {
  if (!instrumentationPayloadText.includes(expected)) {
    throw new Error(`instrumented SQS payload missing ${expected}`);
  }
}
if (instrumentationClient.pendingEvents() !== 0) {
  throw new Error("instrumented SQS client queue did not drain");
}

const highVolumeSqsSpans = 1200;
const maxQueueSize = 1000;
const sqsDrops = [];
const highVolumeClient = LogBrewClient.create({
  apiKey: "LOGBREW_SERVER_API_KEY",
  maxRetries: 1,
  maxQueueSize,
  sdkName: "aws-sqs-high-load-smoke",
  sdkVersion: "0.1.0",
  onEventDropped(drop) {
    sqsDrops.push(drop);
  }
});
let highVolumeSendCount = 0;
const highVolumeSqsClient = {
  async send(command) {
    if (!(command instanceof SendMessageCommand)) {
      throw new Error("high-volume SQS smoke expected SendMessageCommand");
    }
    highVolumeSendCount += 1;
    if (!extractLogBrewSqsTraceparent(command.input)) {
      throw new Error("high-volume SQS command missing traceparent");
    }
    return { MessageId: `burst-msg-${highVolumeSendCount}` };
  }
};

for (let index = 0; index < highVolumeSqsSpans; index += 1) {
  const result = await sqsSendMessageWithLogBrewSpan(
    highVolumeSqsClient,
    SendMessageCommand,
    {
      QueueUrl: queueUrl,
      MessageBody: `burst-body-${index}`
    },
    {
      client: highVolumeClient,
      id: `evt_sqs_high_load_${index.toString().padStart(4, "0")}`,
      now: () => timestamp(index),
      nowMs: () => index,
      queueName: "orders",
      spanIdFactory: () => hexId(index + 1, 16),
      traceIdFactory: () => hexId(index + 1, 32)
    }
  );
  if (result.MessageId !== `burst-msg-${index + 1}`) {
    throw new Error("high-volume SQS helper changed the app result");
  }
}

if (highVolumeSendCount !== highVolumeSqsSpans) {
  throw new Error(`expected ${highVolumeSqsSpans} high-volume SQS sends, got ${highVolumeSendCount}`);
}
if (highVolumeClient.pendingEvents() !== maxQueueSize) {
  throw new Error(`expected bounded SQS queue size ${maxQueueSize}, got ${highVolumeClient.pendingEvents()}`);
}
if (highVolumeClient.droppedEvents() !== highVolumeSqsSpans - maxQueueSize) {
  throw new Error(`expected ${highVolumeSqsSpans - maxQueueSize} SQS drops, got ${highVolumeClient.droppedEvents()}`);
}
if (sqsDrops.length !== highVolumeSqsSpans - maxQueueSize) {
  throw new Error(`expected ${highVolumeSqsSpans - maxQueueSize} SQS drop callbacks, got ${sqsDrops.length}`);
}
if (sqsDrops[0].eventId !== "evt_sqs_high_load_1000" || sqsDrops[0].eventType !== "span" || sqsDrops[0].reason !== "queue_overflow") {
  throw new Error(`unexpected first SQS drop callback: ${JSON.stringify(sqsDrops[0])}`);
}

const highVolumeEvents = [];
const highVolumeBodies = [];
const highVolumeServer = http.createServer(async (req, res) => {
  const body = await new Promise((resolve) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
  });
  highVolumeBodies.push(body);
  highVolumeEvents.push(JSON.parse(body));
  res.writeHead(highVolumeEvents.length === 1 ? 503 : 202, { "content-type": "application/json" });
  res.end("{}");
});
highVolumeServer.listen(0, "127.0.0.1");
await once(highVolumeServer, "listening");
const highVolumeEndpoint = `http://127.0.0.1:${highVolumeServer.address().port}/v1/events`;
const highVolumeTransport = createNodeFetchTransport({ endpoint: highVolumeEndpoint, timeoutMs: 2000 });
const highVolumeResponse = await highVolumeClient.flush(highVolumeTransport);
highVolumeServer.close();
await once(highVolumeServer, "close");

if (highVolumeEvents.length !== highVolumeResponse.attempts || highVolumeResponse.statusCode !== 202 || highVolumeResponse.batches !== 10 || highVolumeResponse.attempts !== 11) {
  throw new Error(`expected high-volume SQS retry success, got requests=${highVolumeEvents.length} status=${highVolumeResponse.statusCode} attempts=${highVolumeResponse.attempts}`);
}
if (highVolumeBodies[0] !== highVolumeBodies[1]) {
  throw new Error("expected byte-identical high-volume SQS retry body");
}
const acceptedSqsEvents = highVolumeEvents.slice(1).flatMap((payload) => payload.events);
if (acceptedSqsEvents.length !== maxQueueSize) {
  throw new Error(`expected ${maxQueueSize} high-volume SQS events, got ${acceptedSqsEvents.length}`);
}
for (let index = 0; index < acceptedSqsEvents.length; index += 1) {
  const expectedId = `evt_sqs_high_load_${index.toString().padStart(4, "0")}`;
  if (acceptedSqsEvents[index].id !== expectedId) {
    throw new Error(`high-volume SQS event order mismatch at ${index}`);
  }
}
for (let index = 1; index < highVolumeEvents.length; index += 1) {
  if (highVolumeEvents[index].events.length > 100) {
    throw new Error(`high-volume SQS batch ${index - 1} exceeded event limit`);
  }
  if (Buffer.byteLength(highVolumeBodies[index], "utf8") > 256 * 1024) {
    throw new Error(`high-volume SQS batch ${index - 1} exceeded byte limit`);
  }
}
const highVolumePayloadText = JSON.stringify(highVolumeEvents.slice(1));
for (const forbidden of [
  "burst-body",
  "burst-msg",
  "123456789012",
  "sqs.us-east-1.amazonaws.com",
  "evt_sqs_high_load_1000"
]) {
  if (highVolumePayloadText.includes(forbidden)) {
    throw new Error(`high-volume SQS payload leaked ${forbidden}`);
  }
}
for (const expected of ["aws_sqs", "orders", "publish", "evt_sqs_high_load_0000", "evt_sqs_high_load_0999"]) {
  if (!highVolumePayloadText.includes(expected)) {
    throw new Error(`high-volume SQS payload missing ${expected}`);
  }
}
if (highVolumeClient.pendingEvents() !== 0) {
  throw new Error("high-volume SQS client queue did not drain");
}

function capturedTraceparent() {
  return extractLogBrewSqsTraceparent(capturedCommands[0].input);
}

function hexId(value, width) {
  return value.toString(16).padStart(width, "0").slice(-width);
}

function timestamp(index) {
  return new Date(Date.UTC(2026, 5, 26, 10, 0, 0, index)).toISOString();
}
EOF

node smoke.mjs

echo "aws sqs real-user smoke ok: 1200 sends, 1000 flushed, 200 dropped, batches=10, retryAttempts=11"
