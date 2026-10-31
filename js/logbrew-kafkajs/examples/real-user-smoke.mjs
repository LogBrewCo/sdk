import {
  kafkaJsProducerSendBatchWithLogBrewSpan,
  kafkaJsProducerSendWithLogBrewSpan,
  withLogBrewKafkaJsEachBatch,
  withLogBrewKafkaJsEachMessage
} from "@logbrew/kafkajs";
import { LogBrewClient } from "@logbrew/sdk";
import { setImmediate } from "node:timers/promises";

/** @import { Batch, ProducerBatch, ProducerRecord, RecordMetadata } from "kafkajs" */

const client = LogBrewClient.create({
  apiKey: "LOGBREW_SERVER_API_KEY",
  context: { resource: { deployment: { environment: "test", release: "kafkajs-smoke@1.0.0" } }, schemaVersion: 1 },
  sdkName: "kafkajs-smoke",
  sdkVersion: "0.1.0"
});

/**
 * @returns {Promise<void>}
 */
async function settle() {
  await setImmediate();
}

/**
 * @param {ProducerRecord} record
 * @returns {Promise<RecordMetadata[]>}
 */
async function send(record) {
  await setImmediate();
  return [{ baseOffset: "1", errorCode: 0, partition: 0, topicName: record.topic }];
}

/**
 * @param {ProducerBatch} batch
 * @returns {Promise<RecordMetadata[]>}
 */
async function sendBatch(batch) {
  await setImmediate();
  return (batch.topicMessages ?? []).map((topicMessage, index) => ({
    baseOffset: String(index),
    errorCode: 0,
    partition: index,
    topicName: topicMessage.topic
  }));
}

await kafkaJsProducerSendWithLogBrewSpan({ send }, {
  messages: [{ value: "example" }],
  topic: "checkout.events"
}, { client });

await kafkaJsProducerSendBatchWithLogBrewSpan({ sendBatch }, {
  topicMessages: [{ messages: [{ value: "example" }], topic: "checkout.events" }]
}, { client });

await withLogBrewKafkaJsEachMessage(() => "processed", { client })({
  heartbeat: settle,
  message: { attributes: 0, headers: {}, key: Buffer.from("checkout"), offset: "0", timestamp: "0", value: Buffer.from("example") },
  partition: 0,
  pause: () => () => undefined,
  topic: "checkout.events"
});

/** @type {Batch} */
const batch = {
  firstOffset: () => "0",
  highWatermark: "1",
  isEmpty: () => false,
  lastOffset: () => "0",
  messages: [{ attributes: 0, headers: {}, key: Buffer.from("checkout"), offset: "0", timestamp: "0", value: Buffer.from("example") }],
  offsetLag: () => "0",
  offsetLagLow: () => "0",
  partition: 0,
  topic: "checkout.events"
};

await withLogBrewKafkaJsEachBatch(() => "processed", { client })({
  batch,
  commitOffsetsIfNecessary: settle,
  heartbeat: settle,
  isRunning: () => true,
  isStale: () => false,
  pause: () => () => undefined,
  resolveOffset: () => undefined,
  uncommittedOffsets: () => ({ topics: [] })
});
