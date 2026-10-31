import { instrumentLogBrewKafkaJsConsumer, instrumentLogBrewKafkaJsProducer } from "@logbrew/kafkajs";
import { Kafka } from "kafkajs";
import { LogBrewClient } from "@logbrew/sdk";

/** @import { EachMessagePayload } from "kafkajs" */

const client = LogBrewClient.create({
  apiKey: process.env["LOGBREW_SERVER_API_KEY"] ?? "LOGBREW_SERVER_API_KEY",
  context: {
    resource: { deployment: { environment: process.env["NODE_ENV"] ?? "development", release: "checkout-worker@1.0.0" } },
    schemaVersion: 1
  },
  sdkName: "checkout-worker",
  sdkVersion: "1.0.0"
});

const kafka = new Kafka({
  brokers: [process.env["KAFKA_BROKER"] ?? "localhost:9092"],
  clientId: "checkout-worker"
});

const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: "checkout-worker" });

await producer.connect();
await consumer.connect();
await consumer.subscribe({ fromBeginning: false, topic: "checkout.events" });

const producerInstrumentation = instrumentLogBrewKafkaJsProducer(producer, { client });
const consumerInstrumentation = instrumentLogBrewKafkaJsConsumer(consumer, { client });

await producer.send({
  messages: [{ value: JSON.stringify({ event: "checkout.started" }) }],
  topic: "checkout.events"
});

/**
 * @param {EachMessagePayload} payload
 * @returns {Promise<void>}
 */
async function forwardCheckout({ message }) {
  await producer.send({ messages: [{ key: message.key, value: message.value }], topic: "checkout.processed" });
}

await consumer.run({ eachMessage: forwardCheckout });

producerInstrumentation.uninstall();
consumerInstrumentation.uninstall();
