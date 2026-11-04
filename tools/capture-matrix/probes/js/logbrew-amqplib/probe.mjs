import pino from "pino";
import {
  createLogBrewNodeClient,
  createLogBrewTraceContext,
  installLogBrewPinoInstrumentation,
  runWithLogBrewTrace,
  setLogBrewUser
} from "@logbrew/node";
import { amqplibSendToQueueWithLogBrewSpan, withLogBrewAmqplibConsumer } from "@logbrew/amqplib";

process.env.LOGBREW_RELEASE = "checkout@1.2.3";
process.env.LOGBREW_ENVIRONMENT = "production";
process.env.LOGBREW_SERVICE_NAME = "checkout-worker";

// No RabbitMQ broker runs here, so the channel is an in-memory stand-in with the amqplib
// sendToQueue, consume, ack, and nack shapes, the way the package's own examples drive the helpers.
const queues = new Map();
const channel = {
  sendToQueue(queue, content, options = {}) {
    queues.set(queue, [...(queues.get(queue) ?? []), { content, fields: { exchange: "", routingKey: queue }, properties: { headers: {}, ...options } }]);
    return true;
  },
  async consume(queue, onMessage) {
    for (const message of queues.get(queue) ?? []) {
      await onMessage(message);
    }
  },
  ack() {},
  nack() {}
};

const client = createLogBrewNodeClient({ serverApiKey: "LOGBREW_SERVER_API_KEY", endpoint: process.env.LOGBREW_CAPTURE_ENDPOINT });
const pinoCapture = installLogBrewPinoInstrumentation({ client });
const logger = pino({ level: "info" });

const trace = createLogBrewTraceContext("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
await runWithLogBrewTrace(trace, async () => {
  setLogBrewUser("user_123");
  for (const body of ["charge-card", "charge-declined"]) {
    await amqplibSendToQueueWithLogBrewSpan(channel, "checkout.created", Buffer.from(body), { contentType: "text/plain" }, { client });
  }
});
const consumeCheckout = withLogBrewAmqplibConsumer((message) => {
  setLogBrewUser("user_123");
  logger.info("checkout message received");
  if (message.content.toString() === "charge-declined") {
    throw new Error("payment declined");
  }
  channel.ack(message);
}, { client, queueName: "checkout.created" });
await channel.consume("checkout.created", (message) => consumeCheckout(message).catch(() => {
  logger.warn("checkout message rejected");
  channel.nack(message);
}));
await pinoCapture.flush();
pinoCapture.uninstall();
await client.shutdown();
