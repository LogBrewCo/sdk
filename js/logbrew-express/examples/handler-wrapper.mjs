import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { RecordingTransport } from "@logbrew/sdk";
import { logbrewMiddleware, withLogBrewExpressHandler } from "@logbrew/express";

const transport = RecordingTransport.alwaysAccept();
const app = express();
let releaseWork;
let resolveInitialDelivery;
let resolveDelivery;
const work = new Promise((resolve) => { releaseWork = resolve; });
const initialDelivery = new Promise((resolve) => { resolveInitialDelivery = resolve; });
const delivered = new Promise((resolve) => { resolveDelivery = resolve; });
let deliveries = 0;

app.use(logbrewMiddleware({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  transport,
  onFlush() {
    deliveries += 1;
    if (deliveries === 1) { resolveInitialDelivery(); }
    if (deliveries === 2) { resolveDelivery(); }
  }
}));
app.get("/health", withLogBrewExpressHandler(async (req, res) => {
  res.json({ ok: true });
  await work;
  req.logbrew.client.log("evt_handler_complete", new Date().toISOString(), {
    message: "handler work completed",
    level: "info"
  });
}));

const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
try {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
  assert.deepEqual(await response.json(), { ok: true });
  await initialDelivery;
  releaseWork();
  await delivered;
  const events = transport.sentBodies.flatMap((body) => JSON.parse(body).events);
  assert.deepEqual(events.map(({ type }) => type), ["span", "log"]);
  console.log(JSON.stringify({ ok: true, events }));
} finally {
  releaseWork();
  server.closeAllConnections();
  await new Promise((resolve) => { server.close(resolve); });
}
