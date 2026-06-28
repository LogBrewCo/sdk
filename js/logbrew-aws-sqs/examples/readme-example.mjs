import { LogBrewClient } from "@logbrew/sdk";
import { ReceiveMessageCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
import {
  sqsReceiveMessageWithLogBrewSpan,
  sqsSendMessageWithLogBrewSpan,
  withLogBrewSqsMessageProcessor
} from "../index.js";

const logbrew = LogBrewClient.create({
  apiKey: process.env.LOGBREW_SERVER_API_KEY ?? "LOGBREW_SERVER_API_KEY",
  release: process.env.LOGBREW_RELEASE ?? "local",
  environment: process.env.NODE_ENV ?? "development",
  sdkName: "checkout-worker",
  sdkVersion: "1.0.0"
});

const sqs = {
  async send(command) {
    if (command instanceof SendMessageCommand) {
      return { MessageId: "msg_001" };
    }
    if (command instanceof ReceiveMessageCommand) {
      return { Messages: [] };
    }
    throw new Error("unexpected command");
  }
};
const queueUrl = process.env.ORDERS_QUEUE_URL ?? "https://sqs.us-east-1.amazonaws.com/123456789012/orders";

await sqsSendMessageWithLogBrewSpan(
  sqs,
  SendMessageCommand,
  {
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify({ type: "checkout.created" })
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
  extractSnsEnvelopeTraceparent: true,
  queueName: "orders"
});

for (const message of output.Messages ?? []) {
  await processMessage(message);
}

console.log(logbrew.previewJson());
