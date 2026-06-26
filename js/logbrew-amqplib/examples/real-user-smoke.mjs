import { Buffer } from "node:buffer";
import { LogBrewClient } from "@logbrew/sdk";
import {
  amqplibSendToQueueWithLogBrewSpan,
  withLogBrewAmqplibConsumer
} from "../index.js";

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

await withLogBrewAmqplibConsumer(async () => undefined, {
  client,
  queueName: "checkout.created"
})({
  fields: { exchange: "", routingKey: "checkout.created" },
  properties: { headers: {} },
  content: Buffer.from("example")
});
