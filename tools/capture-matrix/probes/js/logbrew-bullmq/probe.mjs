import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { Queue, QueueEvents, Worker } from "bullmq";
import IORedis from "ioredis";
import { createLogBrewNodeClient, createLogBrewTraceContext, runWithLogBrewTrace, setLogBrewUser } from "@logbrew/node";
import { instrumentLogBrewBullMqQueue, withLogBrewBullMqProcessor } from "@logbrew/bullmq";

process.env.LOGBREW_RELEASE = "checkout@1.2.3";
process.env.LOGBREW_ENVIRONMENT = "production";
process.env.LOGBREW_SERVICE_NAME = "checkout-worker";
const port = await new Promise((resolve) => {
  const free = createServer().listen(0, "127.0.0.1", () => {
    const { port: chosen } = free.address();
    free.close(() => resolve(chosen));
  });
});
const redis = spawn("redis-server", ["--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no"], { stdio: ["ignore", "pipe", "ignore"] });
process.on("exit", () => redis.kill("SIGTERM"));
await new Promise((resolve) => redis.stdout.on("data", (chunk) => chunk.toString().includes("Ready to accept") && resolve()));
const connections = [];
const connect = () => connections[connections.push(new IORedis({ host: "127.0.0.1", port, maxRetriesPerRequest: null })) - 1];

const client = createLogBrewNodeClient({ serverApiKey: "LOGBREW_SERVER_API_KEY", endpoint: process.env.LOGBREW_CAPTURE_ENDPOINT });
const queue = new Queue("orders", { connection: connect() });
const queueEvents = new QueueEvents("orders", { connection: connect() });
await queueEvents.waitUntilReady();
const queueTracing = instrumentLogBrewBullMqQueue(queue, { client });
const worker = new Worker("orders", withLogBrewBullMqProcessor(async (job) => {
  setLogBrewUser("user_123");
  await job.log(`charging ${job.name}`);
  if (job.name === "charge-declined") {
    throw new Error("payment declined");
  }
  return { charged: true };
}, { client }), { connection: connect() });

const trace = createLogBrewTraceContext("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
const jobs = await runWithLogBrewTrace(trace, async () => {
  setLogBrewUser("user_123");
  return [
    await queue.add("charge-card", { orderId: "ord_1" }, { attempts: 1 }),
    await queue.add("charge-declined", { orderId: "ord_2" }, { attempts: 1 })
  ];
});
for (const job of jobs) {
  await job.waitUntilFinished(queueEvents).catch((error) => console.log("job failed:", error.message));
}
await new Promise((resolve) => setTimeout(resolve, 300));
queueTracing.uninstall();
await worker.close();
await queueEvents.close();
await queue.close();
await Promise.all(connections.map((connection) => connection.quit()));
await client.shutdown();
redis.kill("SIGTERM");
await new Promise((resolve) => redis.once("exit", resolve));
