import { RecordingTransport } from "@logbrew/sdk";
import { createNodeFetchTransport } from "@logbrew/node";
import {
  bullMqQueueAddBulkWithLogBrewSpan,
  bullMqQueueAddWithLogBrewSpan,
  extractLogBrewBullMqTraceparent,
  withLogBrewBullMqProcessor
} from "@logbrew/bullmq";

const transport = RecordingTransport.alwaysAccept();
void createNodeFetchTransport;
const client = {
  span(id, timestamp, attributes) {
    transport.sentBodies.push(JSON.stringify({ events: [{ id, timestamp, attributes, type: "span" }] }));
  }
};

const queue = {
  name: "email",
  async add(name, data, opts) {
    return { data, name, opts, queueName: "email" };
  },
  async addBulk(jobs) {
    return jobs.map((job) => ({ ...job, queueName: "email" }));
  }
};

const job = await bullMqQueueAddWithLogBrewSpan(queue, "welcome", { template: "safe" }, {}, {
  client,
  spanIdFactory: () => "1111111111111111",
  traceIdFactory: () => "22222222222222222222222222222222"
});
const processor = withLogBrewBullMqProcessor(async (currentJob) => currentJob.name, {
  client,
  spanIdFactory: () => "3333333333333333"
});
await processor(job);
await bullMqQueueAddBulkWithLogBrewSpan(queue, [
  { name: "one", data: { ok: true } },
  { name: "two", data: { ok: true } }
], {
  client,
  spanIdFactory: () => "4444444444444444",
  traceIdFactory: () => "55555555555555555555555555555555"
});

if (!extractLogBrewBullMqTraceparent(job)) {
  throw new Error("expected BullMQ job traceparent");
}

console.log(JSON.stringify({ events: transport.sentBodies.length, ok: true }));
