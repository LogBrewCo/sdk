import { Kafka, logLevel } from "kafkajs";
import { createLogBrewNodeClient, createLogBrewTraceContext, runWithLogBrewTrace, setLogBrewUser } from "@logbrew/node";
import { instrumentLogBrewKafkaJsConsumer, instrumentLogBrewKafkaJsProducer } from "@logbrew/kafkajs";

process.env.LOGBREW_RELEASE = "checkout@1.2.3";
process.env.LOGBREW_ENVIRONMENT = "production";
process.env.LOGBREW_SERVICE_NAME = "checkout-worker";
const kafka = new Kafka({ brokers: ["127.0.0.1:9"], clientId: "checkout-worker", logLevel: logLevel.INFO });
const logger = kafka.logger();

// No Kafka broker runs here, so the producer and consumer are in-memory stand-ins with the KafkaJS
// send and run shapes, the way the package's own examples drive the helpers.
const topics = new Map();
const producer = {
  async send({ topic, messages }) {
    topics.set(topic, [...(topics.get(topic) ?? []), ...messages.map((message, offset) => ({ ...message, offset: String(offset) }))]);
    return [{ topicName: topic, partition: 0, errorCode: 0, baseOffset: "0" }];
  }
};
const consumer = {
  async run({ eachMessage }) {
    for (const [topic, messages] of topics) {
      for (const message of messages) {
        const kafkaMessage = { attributes: 0, timestamp: "0", key: null, headers: {}, ...message, value: Buffer.from(message.value) };
        try {
          await eachMessage({ topic, partition: 0, message: kafkaMessage, heartbeat: async () => undefined, pause: () => () => undefined });
        } catch (error) {
          logger.error("eachMessage failed", { error: error.message });
        }
      }
    }
  }
};

const client = createLogBrewNodeClient({ serverApiKey: "LOGBREW_SERVER_API_KEY", endpoint: process.env.LOGBREW_CAPTURE_ENDPOINT });
const producerTracing = instrumentLogBrewKafkaJsProducer(producer, { client });
const consumerTracing = instrumentLogBrewKafkaJsConsumer(consumer, { client });

const trace = createLogBrewTraceContext("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
await runWithLogBrewTrace(trace, async () => {
  setLogBrewUser("user_123");
  await producer.send({ topic: "checkout.events", messages: [{ value: "charge-card" }, { value: "charge-declined" }] });
});
await consumer.run({
  async eachMessage({ message }) {
    setLogBrewUser("user_123");
    logger.info("checkout message received");
    if (message.value.toString() === "charge-declined") {
      throw new Error("payment declined");
    }
  }
});
producerTracing.uninstall();
consumerTracing.uninstall();
await client.shutdown();
