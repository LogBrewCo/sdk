import { Kafka } from "kafkajs";
import { LogBrewClient } from "@logbrew/sdk";
import { kafkaJsProducerSendWithLogBrewSpan, withLogBrewKafkaJsEachMessage } from "@logbrew/kafkajs";

const client = LogBrewClient.create({
  apiKey: process.env.LOGBREW_SERVER_API_KEY ?? "LOGBREW_SERVER_API_KEY",
  environment: process.env.NODE_ENV ?? "development",
  release: "checkout-worker@1.0.0",
  sdkName: "checkout-worker",
  sdkVersion: "1.0.0"
});

const kafka = new Kafka({
  clientId: "checkout-worker",
  brokers: [process.env.KAFKA_BROKER ?? "localhost:9092"]
});

const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: "checkout-worker" });

await producer.connect();
await consumer.connect();
await consumer.subscribe({ topic: "checkout.events", fromBeginning: false });

await kafkaJsProducerSendWithLogBrewSpan(producer, {
  topic: "checkout.events",
  messages: [{ value: JSON.stringify({ event: "checkout.started" }) }]
}, { client });

await consumer.run({
  eachMessage: withLogBrewKafkaJsEachMessage(async ({ message }) => {
    await handleCheckoutMessage(message);
  }, { client })
});

async function handleCheckoutMessage(message) {
  void message;
}
