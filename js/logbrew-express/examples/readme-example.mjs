import { RecordingTransport } from "@logbrew/sdk";
import express from "express";
import { logbrewMiddleware } from "@logbrew/express";
import { once } from "node:events";

/**
 * @import { Request, Response } from "express"
 * @import { LogBrewClient } from "@logbrew/sdk"
 */

const ANY_PORT = 0;
const NO_PORT = 0;
const EVENT_COUNT = 6;

/**
 * @param {LogBrewClient} client
 * @returns {void}
 */
function addFullBatch(client) {
  client.release("evt_release_001", "2026-06-02T10:00:00Z", {
    commit: "abc123def456",
    notes: "Public release marker",
    version: "1.2.3"
  });
  client.environment("evt_environment_001", "2026-06-02T10:00:01Z", {
    name: "production",
    region: "global"
  });
  client.issue("evt_issue_001", "2026-06-02T10:00:02Z", {
    level: "error",
    message: "Request timed out after retry budget",
    title: "Checkout timeout"
  });
  client.log("evt_log_001", "2026-06-02T10:00:03Z", {
    level: "info",
    logger: "job-runner",
    message: "worker started"
  });
  client.span("evt_span_001", "2026-06-02T10:00:04Z", {
    durationMs: 12.5,
    name: "GET /health",
    spanId: "span_001",
    status: "ok",
    traceId: "trace_001"
  });
  client.action("evt_action_001", "2026-06-02T10:00:05Z", {
    name: "deploy",
    status: "success"
  });
}

/**
 * @param {Request} req
 * @param {Response} res
 * @returns {void}
 */
function sendBatch(req, res) {
  const context = req.logbrew;
  if (!context) {
    throw new Error("logbrewMiddleware must run before this route");
  }
  addFullBatch(context.client);
  res.type("json").send(context.previewJson());
  void context.shutdown();
}

const transport = RecordingTransport.alwaysAccept();
const app = express();

app.use(logbrewMiddleware({
  captureRequests: false,
  sdkName: "logbrew-express-readme-example",
  sdkVersion: "0.1.1",
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  transport
}));

app.get("/logbrew", sendBatch);

const server = app.listen(ANY_PORT);
await once(server, "listening");
const address = server.address();
const port = typeof address === "object" && address !== null ? address.port : NO_PORT;
const response = await fetch(`http://127.0.0.1:${String(port)}/logbrew`);
const text = await response.text();
server.close();
await once(server, "close");

process.stdout.write(`${text}\n`);
process.stderr.write(
  `${JSON.stringify({
    ok: true,

    status: response.status,

    attempts: transport.sentBodies.length,

    events: EVENT_COUNT
  })}\n`
);
