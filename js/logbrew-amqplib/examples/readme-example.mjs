import { amqplibSendToQueueWithLogBrewSpan, withLogBrewAmqplibConsumer } from "@logbrew/amqplib";
import { LogBrewClient } from "@logbrew/sdk";
import amqp from "amqplib";

/** @import { ConsumeMessage } from "amqplib" */

const client = LogBrewClient.create({
  apiKey: process.env["LOGBREW_SERVER_API_KEY"] ?? "LOGBREW_SERVER_API_KEY",
  context: { resource: { deployment: { environment: "production", release: "checkout-worker@1.0.0" } }, schemaVersion: 1 },
  sdkName: "checkout-worker",
  sdkVersion: "1.0.0"
});

const connection = await amqp.connect(process.env["AMQP_URL"] ?? "amqp://localhost");
const channel = await connection.createChannel();

await amqplibSendToQueueWithLogBrewSpan(
  channel,
  "checkout.created",
  Buffer.from(JSON.stringify({ event: "checkout.created" })),
  { contentType: "application/json" },
  { client }
);

/**
 * @param {ConsumeMessage | null} message
 * @returns {void}
 */
function acknowledgeCheckout(message) {
  if (message !== null) {
    channel.ack(message);
  }
}

const consumeCheckout = withLogBrewAmqplibConsumer(acknowledgeCheckout, { client, queueName: "checkout.created" });

await channel.consume("checkout.created", (message) => {
  consumeCheckout(message).catch(() => {
    if (message !== null) {
      channel.nack(message);
    }
  });
});
