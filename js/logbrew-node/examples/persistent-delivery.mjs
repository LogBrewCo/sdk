import fs from "node:fs";
import { createLogBrewNodeClient, createNodeFetchTransport } from "@logbrew/node";

const queueDirectory = process.env.LOGBREW_QUEUE_DIRECTORY;
const queueKeyFile = process.env.LOGBREW_QUEUE_KEY_FILE;
if (!queueDirectory || !queueKeyFile) {
  throw new Error("Set LOGBREW_QUEUE_DIRECTORY and LOGBREW_QUEUE_KEY_FILE");
}

const client = createLogBrewNodeClient({
  persistentQueue: {
    directory: queueDirectory,
    encryptionKey: fs.readFileSync(queueKeyFile),
    onWarning({ code }) {
      console.warn("LogBrew persistent queue warning", code);
    }
  },
  sdkName: "checkout-worker",
  sdkVersion: "1.0.0"
});
const transport = createNodeFetchTransport();

client.log("evt_worker_started", new Date().toISOString(), {
  level: "info",
  logger: "checkout-worker",
  message: "worker started"
});

try {
  await client.flush(transport);
} catch (error) {
  console.error("LogBrew flush failed; encrypted events remain queued", error.name);
}

async function shutdown() {
  try {
    await client.shutdown(transport);
  } catch (error) {
    console.error("LogBrew shutdown failed; encrypted events remain queued", error.name);
  }
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
