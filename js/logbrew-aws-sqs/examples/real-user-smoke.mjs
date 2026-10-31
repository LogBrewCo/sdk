import {
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SendMessageCommand
} from "@aws-sdk/client-sqs";
import {
  sqsReceiveMessageWithLogBrewSpan,
  sqsSendMessageBatchWithLogBrewSpan,
  sqsSendMessageWithLogBrewSpan
} from "@logbrew/aws-sqs";
import { LogBrewClient } from "@logbrew/sdk";

const logbrew = LogBrewClient.create({
  apiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "aws-sqs-real-user-smoke",
  sdkVersion: "0.1.0"
});

/**
 * @template Output
 * @param {new (input: never) => unknown} Command
 * @param {Output} output
 * @returns {{ send: (command: unknown) => Promise<Output> }}
 */
function createFakeSqsClient(Command, output) {
  return {
    send: async (command) => {
      await Promise.resolve();
      if (!(command instanceof Command)) {
        throw new TypeError("unexpected command");
      }
      return output;
    }
  };
}

const queueUrl = "https://sqs.us-east-1.amazonaws.com/123456789012/orders";

await sqsSendMessageWithLogBrewSpan(
  createFakeSqsClient(SendMessageCommand, { $metadata: {}, MessageId: "msg_001" }),
  SendMessageCommand,
  { MessageBody: "example", QueueUrl: queueUrl },
  { client: logbrew, queueName: "orders" }
);

await sqsSendMessageBatchWithLogBrewSpan(
  createFakeSqsClient(SendMessageBatchCommand, {
    $metadata: {},
    Failed: [],
    Successful: [{ Id: "one", MD5OfMessageBody: "1a79a4d60de6718e8e5b326e338ae533", MessageId: "msg_002" }]
  }),
  SendMessageBatchCommand,
  {
    Entries: [{ Id: "one", MessageBody: "example" }],
    QueueUrl: queueUrl
  },
  { client: logbrew, queueName: "orders" }
);

await sqsReceiveMessageWithLogBrewSpan(
  createFakeSqsClient(ReceiveMessageCommand, { $metadata: {}, Messages: [] }),
  ReceiveMessageCommand,
  { MaxNumberOfMessages: 1, QueueUrl: queueUrl },
  { client: logbrew, queueName: "orders" }
);
