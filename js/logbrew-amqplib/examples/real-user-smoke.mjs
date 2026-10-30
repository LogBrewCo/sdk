import { amqplibSendToQueueWithLogBrewSpan, withLogBrewAmqplibConsumer } from "@logbrew/amqplib";
import { LogBrewClient } from "@logbrew/sdk";

const client = LogBrewClient.create({
  apiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "amqplib-smoke-app",
  sdkVersion: "0.1.0"
});

const channel = {
  sendToQueue() {
    return true;
  }
};

await amqplibSendToQueueWithLogBrewSpan(
  channel,
  "checkout.created",
  Buffer.from("example"),
  {},
  { client }
);

await withLogBrewAmqplibConsumer(() => "processed", {
  client,
  queueName: "checkout.created"
})({
  content: Buffer.from("example"),
  fields: { exchange: "", routingKey: "checkout.created" },
  properties: { headers: {} }
});
