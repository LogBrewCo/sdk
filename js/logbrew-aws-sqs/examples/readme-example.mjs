import { ReceiveMessageCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
import {
  sqsReceiveMessageWithLogBrewSpan,
  sqsSendMessageWithLogBrewSpan,
  withLogBrewSqsMessageProcessor
} from "@logbrew/aws-sqs";
import { LogBrewClient } from "@logbrew/sdk";

const MAX_MESSAGES = 10;

const logbrew = LogBrewClient.create({
  apiKey: process.env["LOGBREW_SERVER_API_KEY"] ?? "LOGBREW_SERVER_API_KEY",
  context: {
    resource: {
      deployment: {
        environment: process.env["NODE_ENV"] ?? "development",
        release: process.env["LOGBREW_RELEASE"] ?? "local"
      }
    },
    schemaVersion: 1
  },
  sdkName: "checkout-worker",
  sdkVersion: "1.0.0"
});

const sqs = {
  /**
   * @param {unknown} command
   * @returns {Promise<{ $metadata: Record<string, never>, MessageId?: string, Messages?: [] }>}
   */
  send: async (command) => {
    await Promise.resolve();
    if (command instanceof SendMessageCommand) {
      return { $metadata: {}, MessageId: "msg_001" };
    }
    if (command instanceof ReceiveMessageCommand) {
      return { $metadata: {}, Messages: [] };
    }
    throw new Error("unexpected command");
  }
};
const queueUrl = process.env["ORDERS_QUEUE_URL"] ?? "https://sqs.us-east-1.amazonaws.com/123456789012/orders";

await sqsSendMessageWithLogBrewSpan(
  sqs,
  SendMessageCommand,
  {
    MessageBody: JSON.stringify({ type: "checkout.created" }),
    QueueUrl: queueUrl
  },
  { client: logbrew, queueName: "orders" }
);

const output = await sqsReceiveMessageWithLogBrewSpan(
  sqs,
  ReceiveMessageCommand,
  { MaxNumberOfMessages: MAX_MESSAGES, QueueUrl: queueUrl },
  { client: logbrew, queueName: "orders" }
);

const processMessage = withLogBrewSqsMessageProcessor(
  async (message) => {
    await Promise.resolve();
    process.stdout.write(`processing ${message.MessageId ?? ""}\n`);
  },
  {
    client: logbrew,
    extractSnsEnvelopeTraceparent: true,
    queueName: "orders"
  }
);

await Promise.all((output.Messages ?? []).map(async (message) => processMessage(message)));

process.stdout.write(`${logbrew.previewJson()}\n`);
