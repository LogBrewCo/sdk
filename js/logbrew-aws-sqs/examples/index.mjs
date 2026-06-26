import { LogBrewClient } from "@logbrew/sdk";
import {
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SendMessageCommand,
  SQSClient
} from "@aws-sdk/client-sqs";
import {
  instrumentLogBrewSqsClient,
  sqsReceiveMessageWithLogBrewSpan,
  sqsSendMessageBatchWithLogBrewSpan,
  sqsSendMessageWithLogBrewSpan,
  withLogBrewSqsMessageProcessor
} from "../index.js";

const logbrew = LogBrewClient.create({
  apiKey: process.env.LOGBREW_SERVER_API_KEY ?? "LOGBREW_SERVER_API_KEY",
  environment: process.env.NODE_ENV ?? "development",
  release: process.env.LOGBREW_RELEASE ?? "local",
  sdkName: "aws-sqs-example",
  sdkVersion: "0.1.0"
});

const sqs = new SQSClient({ region: process.env.AWS_REGION ?? "us-east-1" });
const queueUrl = process.env.ORDERS_QUEUE_URL ?? "https://sqs.us-east-1.amazonaws.com/123456789012/orders";

export async function sendOrderMessage() {
  return sqsSendMessageWithLogBrewSpan(
    sqs,
    SendMessageCommand,
    {
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({ type: "checkout.created" })
    },
    { client: logbrew, queueName: "orders" }
  );
}

export async function sendOrderBatch() {
  return sqsSendMessageBatchWithLogBrewSpan(
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
}

export async function receiveAndProcessOrders() {
  const output = await sqsReceiveMessageWithLogBrewSpan(
    sqs,
    ReceiveMessageCommand,
    { QueueUrl: queueUrl, MaxNumberOfMessages: 10 },
    { client: logbrew, queueName: "orders" }
  );
  const processMessage = withLogBrewSqsMessageProcessor(async (message) => {
    console.log("received", message.MessageId);
  }, { client: logbrew, queueName: "orders" });

  for (const message of output.Messages ?? []) {
    await processMessage(message);
  }
}

export function instrumentOrdersClient() {
  return instrumentLogBrewSqsClient(
    sqs,
    { ReceiveMessageCommand, SendMessageBatchCommand, SendMessageCommand },
    { client: logbrew, queueName: "orders" }
  );
}
