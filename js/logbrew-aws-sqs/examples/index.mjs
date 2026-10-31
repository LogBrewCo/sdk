import {
  ReceiveMessageCommand,
  SQSClient,
  SendMessageBatchCommand,
  SendMessageCommand
} from "@aws-sdk/client-sqs";
import {
  instrumentLogBrewSqsClient,
  sqsReceiveMessageWithLogBrewSpan,
  sqsSendMessageBatchWithLogBrewSpan,
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
  sdkName: "aws-sqs-example",
  sdkVersion: "0.1.0"
});

const sqs = new SQSClient({ region: process.env["AWS_REGION"] ?? "us-east-1" });
const queueUrl = process.env["ORDERS_QUEUE_URL"] ?? "https://sqs.us-east-1.amazonaws.com/123456789012/orders";

async function sendOrderMessage() {
  return sqsSendMessageWithLogBrewSpan(
    sqs,
    SendMessageCommand,
    {
      MessageBody: JSON.stringify({ type: "checkout.created" }),
      QueueUrl: queueUrl
    },
    { client: logbrew, queueName: "orders" }
  );
}

async function sendOrderBatch() {
  return sqsSendMessageBatchWithLogBrewSpan(
    sqs,
    SendMessageBatchCommand,
    {
      Entries: [
        { Id: "one", MessageBody: JSON.stringify({ type: "checkout.created" }) },
        { Id: "two", MessageBody: JSON.stringify({ type: "checkout.confirmed" }) }
      ],
      QueueUrl: queueUrl
    },
    { client: logbrew, queueName: "orders" }
  );
}

async function receiveAndProcessOrders() {
  const output = await sqsReceiveMessageWithLogBrewSpan(
    sqs,
    ReceiveMessageCommand,
    { MaxNumberOfMessages: MAX_MESSAGES, QueueUrl: queueUrl },
    { client: logbrew, queueName: "orders" }
  );
  const processMessage = withLogBrewSqsMessageProcessor(
    async (message) => {
      await Promise.resolve();
      process.stdout.write(`received ${message.MessageId ?? ""}\n`);
    },
    {
      client: logbrew,
      extractSnsEnvelopeTraceparent: true,
      queueName: "orders"
    }
  );

  await Promise.all((output.Messages ?? []).map(async (message) => processMessage(message)));
}

function instrumentOrdersClient() {
  return instrumentLogBrewSqsClient(
    sqs,
    { ReceiveMessageCommand, SendMessageBatchCommand, SendMessageCommand },
    { client: logbrew, queueName: "orders" }
  );
}

export { instrumentOrdersClient, receiveAndProcessOrders, sendOrderBatch, sendOrderMessage };
