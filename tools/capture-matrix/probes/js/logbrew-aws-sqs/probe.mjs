import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import pino from "pino";
import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageBatchCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import {
  createLogBrewNodeClient,
  createLogBrewTraceContext,
  installLogBrewPinoInstrumentation,
  runWithLogBrewTrace,
  setLogBrewUser
} from "@logbrew/node";
import { instrumentLogBrewSqsClient, withLogBrewSqsMessageProcessor } from "@logbrew/aws-sqs";

process.env.LOGBREW_RELEASE = "checkout@1.2.3";
process.env.LOGBREW_ENVIRONMENT = "production";
process.env.LOGBREW_SERVICE_NAME = "checkout-worker";

// No SQS service runs here, so a local HTTP stand-in answers the AWS JSON protocol calls the real
// SQSClient sends: SendMessage, ReceiveMessage, and DeleteMessage.
const md5 = (text) => createHash("md5").update(text).digest("hex");
const messages = [];
const sqsServer = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
  }
  const input = JSON.parse(body || "{}");
  const action = String(request.headers["x-amz-target"]).replace("AmazonSQS.", "");
  let output = {};
  if (action === "SendMessage") {
    const message = { MessageId: randomUUID(), ReceiptHandle: randomUUID(), Body: input.MessageBody, MD5OfBody: md5(input.MessageBody), MessageAttributes: input.MessageAttributes };
    messages.push(message);
    output = { MessageId: message.MessageId, MD5OfMessageBody: message.MD5OfBody };
  } else if (action === "ReceiveMessage") {
    output = { Messages: messages.splice(0, input.MaxNumberOfMessages ?? 1) };
  }
  response.writeHead(200, { "content-type": "application/x-amz-json-1.0" });
  response.end(JSON.stringify(output));
});
await new Promise((resolve) => sqsServer.listen(0, "127.0.0.1", resolve));
const queueUrl = `http://127.0.0.1:${sqsServer.address().port}/000000000000/orders`;

const client = createLogBrewNodeClient({ serverApiKey: "LOGBREW_SERVER_API_KEY", endpoint: process.env.LOGBREW_CAPTURE_ENDPOINT });
const pinoCapture = installLogBrewPinoInstrumentation({ client });
const logger = pino({ level: "info" });
const sqs = new SQSClient({
  region: "us-east-1",
  endpoint: `http://127.0.0.1:${sqsServer.address().port}`,
  credentials: { accessKeyId: "local-test", secretAccessKey: "local-test" }
});
const sqsTracing = instrumentLogBrewSqsClient(sqs, { SendMessageCommand, SendMessageBatchCommand, ReceiveMessageCommand }, { client, queueName: "orders" });

const trace = createLogBrewTraceContext("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
await runWithLogBrewTrace(trace, async () => {
  setLogBrewUser("user_123");
  for (const type of ["charge-card", "charge-declined"]) {
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify({ type }) }));
  }
});
const processMessage = withLogBrewSqsMessageProcessor(async (message) => {
  setLogBrewUser("user_123");
  logger.info("checkout message received");
  if (JSON.parse(message.Body).type === "charge-declined") {
    throw new Error("payment declined");
  }
  await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
}, { client, queueName: "orders" });
const output = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10 }));
await Promise.allSettled((output.Messages ?? []).map((message) => processMessage(message).catch((error) => {
  logger.warn("checkout message left for retry");
  throw error;
})));
sqsTracing.uninstall();
sqs.destroy();
sqsServer.close();
await pinoCapture.flush();
pinoCapture.uninstall();
await client.shutdown();
