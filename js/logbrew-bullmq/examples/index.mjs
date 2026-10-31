import { bullMqQueueAddWithLogBrewSpan, instrumentLogBrewBullMqQueue } from "@logbrew/bullmq";
import { LogBrewClient } from "@logbrew/sdk";
import { Queue } from "bullmq";

/**
 * @import { Job } from "bullmq"
 */

const DEFAULT_REDIS_PORT = 6379;

const logbrew = LogBrewClient.create({
  apiKey: process.env["LOGBREW_SERVER_API_KEY"] ?? "LOGBREW_SERVER_API_KEY",
  sdkName: "bullmq-example",
  sdkVersion: "0.1.0"
});

/** @type {Queue<{ orderId: string }, string, "charge-card">} */
const orders = new Queue("orders", {
  connection: {
    host: process.env["REDIS_HOST"] ?? "127.0.0.1",
    port: Number(process.env["REDIS_PORT"] ?? DEFAULT_REDIS_PORT)
  }
});

/**
 * @param {string} orderId
 * @returns {Promise<Job<{ orderId: string }, string, "charge-card">>}
 */
async function enqueueCharge(orderId) {
  return bullMqQueueAddWithLogBrewSpan(orders, "charge-card", { orderId }, {}, { client: logbrew, queueName: "orders" });
}

function instrumentOrdersQueue() {
  return instrumentLogBrewBullMqQueue(orders, { client: logbrew, queueName: "orders" });
}

async function closeOrders() {
  await orders.close();
}

export { closeOrders, enqueueCharge, instrumentOrdersQueue };
