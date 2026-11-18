import { snsPublishWithLogBrewSpan, sqsSendMessageWithLogBrewSpan } from "@logbrew/aws-sqs";
import { RecordingTransport } from "@logbrew/sdk";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import assert from "node:assert/strict";
import { createLogBrewNodeClient } from "@logbrew/node";
import test from "node:test";

/**
 * @import { LogBrewClient } from "@logbrew/sdk"
 * @typedef {{ readonly Message: string, readonly TopicArn: string }} PublishInput
 * @typedef {{ readonly elapsed: number, readonly json: string }} Sent
 */

const LONG_INPUT_LENGTH = 50_000;
const LONG_LABEL = ".".repeat(LONG_INPUT_LENGTH);
const TIME_BUDGET_MS = 100;

class PublishCommand {
  /** @param {PublishInput} input */
  constructor(input) {
    this.input = input;
  }

  /** @returns {string} */
  topicArn() {
    return this.input.TopicArn;
  }
}

const sqsClient = { send: async () => ({ $metadata: {} }) };
const snsClient = {
  /**
   * @param {Readonly<PublishCommand>} command
   * @returns {Promise<{ readonly TopicArn: string }>}
   */
  send: async (command) => ({ TopicArn: command.topicArn() })
};

/**
 * @param {(client: LogBrewClient) => Promise<unknown>} publish
 * @returns {Promise<Sent>}
 */
async function sentJson(publish) {
  const client = createLogBrewNodeClient({ apiKey: "TEST_API_KEY", automaticDelivery: false, captureRuntimeContext: false, transport: RecordingTransport.alwaysAccept() });
  const started = performance.now();
  await publish(client);
  return { elapsed: performance.now() - started, json: client.previewJson() };
}

/**
 * @param {string} QueueUrl
 * @returns {Promise<Sent>}
 */
async function sendToQueue(QueueUrl) {
  return sentJson(async (client) => sqsSendMessageWithLogBrewSpan(sqsClient, SendMessageCommand, { MessageBody: "{}", QueueUrl }, { client }));
}

/**
 * @param {string} TopicArn
 * @returns {Promise<Sent>}
 */
async function publishToTopic(TopicArn) {
  return sentJson(async (client) => snsPublishWithLogBrewSpan(snsClient, PublishCommand, { Message: "{}", TopicArn }, { client }));
}

await test("SQS queue names stay fast on a long queue URL", async () => {
  const { elapsed } = await sendToQueue(`${LONG_LABEL}/x`);
  assert.ok(elapsed < TIME_BUDGET_MS, `queue name took ${elapsed} ms`);
});

await test("SNS topic names stay fast on a long topic ARN", async () => {
  const { elapsed } = await publishToTopic(`${LONG_LABEL}/a/`);
  assert.ok(elapsed < TIME_BUDGET_MS, `topic name took ${elapsed} ms`);
});

await test("queue and topic names keep the last path or ARN segment", async () => {
  const queue = await sendToQueue("https://sqs.us-east-1.amazonaws.com/123456789012/orders//");
  assert.match(queue.json, /"orders"/u);
  const topic = await publishToTopic("arn:aws:sns:us-east-1:123456789012:billing:");
  assert.match(topic.json, /"billing"/u);
});
