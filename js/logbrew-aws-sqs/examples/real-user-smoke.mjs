import {
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SendMessageCommand
} from "@aws-sdk/client-sqs";
import { LogBrewClient } from "@logbrew/sdk";
import {
  sqsReceiveMessageWithLogBrewSpan,
  sqsSendMessageBatchWithLogBrewSpan,
  sqsSendMessageWithLogBrewSpan
} from "../index.js";

const logbrew = LogBrewClient.create({
  apiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "aws-sqs-real-user-smoke",
  sdkVersion: "0.1.0"
});

const sqs = {
  async send(command) {
    if (command instanceof SendMessageCommand) {
      return { MessageId: "msg_001" };
    }
    if (command instanceof SendMessageBatchCommand) {
      return { Successful: [{ Id: "one", MessageId: "msg_002" }] };
    }
    if (command instanceof ReceiveMessageCommand) {
      return { Messages: [] };
    }
    throw new Error("unexpected command");
  }
};
const queueUrl = "https://sqs.us-east-1.amazonaws.com/123456789012/orders";

await sqsSendMessageWithLogBrewSpan(
  sqs,
  SendMessageCommand,
  { QueueUrl: queueUrl, MessageBody: "example" },
  { client: logbrew, queueName: "orders" }
);

await sqsSendMessageBatchWithLogBrewSpan(
  sqs,
  SendMessageBatchCommand,
  {
    QueueUrl: queueUrl,
    Entries: [{ Id: "one", MessageBody: "example" }]
  },
  { client: logbrew, queueName: "orders" }
);

await sqsReceiveMessageWithLogBrewSpan(
  sqs,
  ReceiveMessageCommand,
  { QueueUrl: queueUrl, MaxNumberOfMessages: 1 },
  { client: logbrew, queueName: "orders" }
);
