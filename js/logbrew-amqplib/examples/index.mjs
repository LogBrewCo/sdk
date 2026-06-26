import { Buffer } from "node:buffer";
import amqp from "amqplib";
import { LogBrewClient } from "@logbrew/sdk";
import {
  amqplibPublishWithLogBrewSpan,
  amqplibSendToQueueWithLogBrewSpan,
  withLogBrewAmqplibConsumer
} from "../index.js";

const client = LogBrewClient.create({
  apiKey: process.env.LOGBREW_SERVER_API_KEY ?? "LOGBREW_SERVER_API_KEY",
  release: "checkout-worker@1.0.0",
  environment: "production",
  sdkName: "checkout-worker",
  sdkVersion: "1.0.0"
});

const connection = await amqp.connect(process.env.AMQP_URL ?? "amqp://localhost");
const channel = await connection.createChannel();

await amqplibSendToQueueWithLogBrewSpan(
  channel,
  "checkout.created",
  Buffer.from(JSON.stringify({ event: "checkout.created" })),
  { contentType: "application/json" },
  { client }
);

await amqplibPublishWithLogBrewSpan(
  channel,
  "checkout.exchange",
  "created",
  Buffer.from(JSON.stringify({ event: "checkout.created" })),
  { contentType: "application/json" },
  { client }
);

await channel.consume(
  "checkout.created",
  withLogBrewAmqplibConsumer(async (message) => {
    if (!message) {
      return;
    }
    await handleCheckoutMessage(message);
    channel.ack(message);
  }, { client, queueName: "checkout.created" })
);

async function handleCheckoutMessage() {
  // Your app owns payload parsing, acknowledgement, retry, and shutdown.
}
