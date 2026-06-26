import { LogBrewClient } from "@logbrew/sdk";
import {
  kafkaJsProducerSendBatchWithLogBrewSpan,
  kafkaJsProducerSendWithLogBrewSpan,
  withLogBrewKafkaJsEachBatch,
  withLogBrewKafkaJsEachMessage
} from "@logbrew/kafkajs";

const client = LogBrewClient.create({
  apiKey: "LOGBREW_SERVER_API_KEY",
  release: "kafkajs-smoke@1.0.0",
  environment: "test",
  sdkName: "kafkajs-smoke",
  sdkVersion: "0.1.0"
});

const producer = {
  async send(record) {
    return [{ topicName: record.topic, partition: 0, baseOffset: "1" }];
  },
  async sendBatch(batch) {
    return batch.topicMessages.map((topicMessage, index) => ({
      topicName: topicMessage.topic,
      partition: index,
      baseOffset: String(index)
    }));
  }
};

await kafkaJsProducerSendWithLogBrewSpan(producer, {
  topic: "checkout.events",
  messages: [{ value: "example" }]
}, { client });

await kafkaJsProducerSendBatchWithLogBrewSpan(producer, {
  topicMessages: [{ topic: "checkout.events", messages: [{ value: "example" }] }]
}, { client });

await withLogBrewKafkaJsEachMessage(async () => undefined, { client })({
  topic: "checkout.events",
  partition: 0,
  message: { headers: {}, value: "example" }
});

await withLogBrewKafkaJsEachBatch(async () => undefined, { client })({
  batch: {
    topic: "checkout.events",
    partition: 0,
    messages: [{ headers: {}, value: "example" }]
  }
});
