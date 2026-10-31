import { LogBrewClient, RecordingTransport } from "@logbrew/sdk";
import {
  bullMqQueueAddBulkWithLogBrewSpan,
  bullMqQueueAddWithLogBrewSpan,
  extractLogBrewBullMqTraceparent,
  withLogBrewBullMqProcessor
} from "@logbrew/bullmq";
import { Queue } from "bullmq";

const transport = RecordingTransport.alwaysAccept();
const client = LogBrewClient.create({
  apiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "bullmq-real-user-smoke",
  sdkVersion: "0.1.0",
  transport
});

/** @type {Queue<{ template: string }, string, "welcome">} */
const queue = new Queue("email", { connection: { host: "127.0.0.1", port: 6379 } });
const job = await bullMqQueueAddWithLogBrewSpan(queue, "welcome", { template: "safe" }, {}, {
  client,
  spanIdFactory: () => "1111111111111111",
  traceIdFactory: () => "22222222222222222222222222222222"
});
const processor = withLogBrewBullMqProcessor(async (currentJob) => {
  await Promise.resolve();
  return currentJob.name;
}, {
  client,
  spanIdFactory: () => "3333333333333333"
});
await processor(job);
await bullMqQueueAddBulkWithLogBrewSpan(queue, [
  { data: { template: "one" }, name: "welcome" },
  { data: { template: "two" }, name: "welcome" }
], {
  client,
  spanIdFactory: () => "4444444444444444",
  traceIdFactory: () => "55555555555555555555555555555555"
});

if (extractLogBrewBullMqTraceparent(job) === undefined) {
  throw new Error("expected BullMQ job traceparent");
}

await queue.close();
const events = client.pendingEvents();
await client.flush();

process.stdout.write(`${JSON.stringify({ events, ok: transport.lastBody() !== null })}\n`);
