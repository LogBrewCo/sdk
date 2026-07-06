import { LogBrewClient } from "@logbrew/sdk";
import {
  bullMqFlowProducerAddWithLogBrewSpan,
  bullMqQueueAddWithLogBrewSpan,
  instrumentLogBrewBullMqFlowProducer,
  instrumentLogBrewBullMqQueue,
  withLogBrewBullMqProcessor
} from "@logbrew/bullmq";

const client = LogBrewClient.create({
  apiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "logbrew-bullmq-readme-example",
  sdkVersion: "0.1.0"
});

const queue = {
  name: "orders",
  async add(name, data, opts) {
    return { data, name, opts, queueName: "orders" };
  }
};

const job = await bullMqQueueAddWithLogBrewSpan(queue, "charge-card", { orderId: "ord_123" }, {}, {
  client
});

const queueInstrumentation = instrumentLogBrewBullMqQueue(queue, { client });
await queue.add("send-receipt", { orderId: "ord_123" }, {});
queueInstrumentation.uninstall();

const flowProducer = {
  async add(flow, options) {
    return { flow, options };
  }
};
await bullMqFlowProducerAddWithLogBrewSpan(flowProducer, {
  name: "checkout-flow",
  queueName: "orders",
  data: { orderId: "ord_123" },
  children: [
    { name: "send-receipt", queueName: "orders", data: { orderId: "ord_123" } }
  ]
}, undefined, {
  client
});
const flowInstrumentation = instrumentLogBrewBullMqFlowProducer(flowProducer, { client });
await flowProducer.add({
  name: "post-checkout-flow",
  queueName: "orders",
  data: { orderId: "ord_124" }
});
flowInstrumentation.uninstall();

const processor = withLogBrewBullMqProcessor(async (currentJob) => ({
  processed: currentJob.name
}), {
  client
});

await processor(job);

console.log(client.previewJson());
