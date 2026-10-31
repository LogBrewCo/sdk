import { FlowProducer, Queue } from "bullmq";
import {
  bullMqFlowProducerAddWithLogBrewSpan,
  bullMqQueueAddWithLogBrewSpan,
  instrumentLogBrewBullMqFlowProducer,
  instrumentLogBrewBullMqQueue,
  withLogBrewBullMqProcessor
} from "@logbrew/bullmq";
import { LogBrewClient } from "@logbrew/sdk";

const DEFAULT_REDIS_PORT = 6379;

const client = LogBrewClient.create({
  apiKey: process.env["LOGBREW_SERVER_API_KEY"] ?? "LOGBREW_SERVER_API_KEY",
  sdkName: "logbrew-bullmq-readme-example",
  sdkVersion: "0.1.0"
});
const connection = {
  host: process.env["REDIS_HOST"] ?? "127.0.0.1",
  port: Number(process.env["REDIS_PORT"] ?? DEFAULT_REDIS_PORT)
};

/** @type {Queue<{ orderId: string }, { processed: string }, "charge-card">} */
const queue = new Queue("orders", { connection });

const job = await bullMqQueueAddWithLogBrewSpan(queue, "charge-card", { orderId: "ord_123" }, {}, {
  client
});

const queueInstrumentation = instrumentLogBrewBullMqQueue(queue, { client });
await queue.add("charge-card", { orderId: "ord_124" }, {});
queueInstrumentation.uninstall();

const flowProducer = new FlowProducer({ connection });
await bullMqFlowProducerAddWithLogBrewSpan(flowProducer, {
  children: [
    { data: { orderId: "ord_123" }, name: "send-receipt", queueName: "orders" }
  ],
  data: { orderId: "ord_123" },
  name: "checkout-flow",
  queueName: "orders"
}, undefined, {
  client
});
const flowInstrumentation = instrumentLogBrewBullMqFlowProducer(flowProducer, { client });
await flowProducer.add({
  data: { orderId: "ord_124" },
  name: "post-checkout-flow",
  queueName: "orders"
});
flowInstrumentation.uninstall();

const processor = withLogBrewBullMqProcessor(async (currentJob) => {
  await Promise.resolve();
  return { processed: currentJob.name };
}, {
  client
});

await processor(job);
await flowProducer.close();
await queue.close();

process.stdout.write(`${client.previewJson()}\n`);
