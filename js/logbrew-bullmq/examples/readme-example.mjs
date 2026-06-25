import { LogBrewClient } from "@logbrew/sdk";
import {
  bullMqQueueAddWithLogBrewSpan,
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

const processor = withLogBrewBullMqProcessor(async (currentJob) => ({
  processed: currentJob.name
}), {
  client
});

await processor(job);

console.log(client.previewJson());
