import express from "express";
import { RecordingTransport } from "@logbrew/sdk";
import {
  logbrewErrorHandler,
  logbrewMiddleware
} from "@logbrew/express";

const requestTransport = new RecordingTransport([{ statusCode: 503 }, { statusCode: 202 }]);
const errorTransport = RecordingTransport.alwaysAccept();
const app = express();

app.use("/logbrew", logbrewMiddleware({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "logbrew-express-real-user-smoke",
  sdkVersion: "0.1.0",
  maxRetries: 1,
  captureRequests: false,
  transport: requestTransport
}));

app.get("/logbrew", (req, res) => {
  addFullBatch(req.logbrew.client);
  res.type("json").send(req.logbrew.previewJson());
  void req.logbrew.shutdown();
});

app.get("/fail", async () => {
  throw new Error("route exploded");
});

app.use(logbrewErrorHandler({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  transport: errorTransport,
  now: () => "2026-06-02T10:00:06Z",
  idFactory: () => "evt_express_error_001"
}));

app.use((error, _req, res, _next) => {
  void _next;
  res.status(500).json({ error: error.message });
});

const server = app.listen(0);
const port = server.address().port;
const okResponse = await fetch(`http://127.0.0.1:${port}/logbrew`);
const okText = await okResponse.text();
const failResponse = await fetch(`http://127.0.0.1:${port}/fail?token=secret`);
await failResponse.json();
await waitFor(() => errorTransport.sentBodies.length === 1);
await new Promise((resolve) => {
  server.close(resolve);
});

const errorPayload = JSON.parse(errorTransport.lastBody());
if (errorPayload.events[0].type !== "issue" || errorPayload.events[0].id !== "evt_express_error_001") {
  throw new Error(`unexpected error payload: ${errorTransport.lastBody()}`);
}
if (errorPayload.events[0].attributes.metadata.path !== "/fail") {
  throw new Error(`error capture should omit query text: ${errorTransport.lastBody()}`);
}

console.log(okText);
console.error(JSON.stringify({
  ok: true,
  status: okResponse.status,
  attempts: requestTransport.sentBodies.length,
  errorStatus: failResponse.status,
  errorCaptured: errorPayload.events[0].attributes.title,
  events: 6
}));

function addFullBatch(client) {
  client.release("evt_release_001", "2026-06-02T10:00:00Z", {
    version: "1.2.3",
    commit: "abc123def456",
    notes: "Public release marker"
  });
  client.environment("evt_environment_001", "2026-06-02T10:00:01Z", {
    name: "production",
    region: "global"
  });
  client.issue("evt_issue_001", "2026-06-02T10:00:02Z", {
    title: "Checkout timeout",
    level: "error",
    message: "Request timed out after retry budget"
  });
  client.log("evt_log_001", "2026-06-02T10:00:03Z", {
    message: "worker started",
    level: "info",
    logger: "job-runner"
  });
  client.span("evt_span_001", "2026-06-02T10:00:04Z", {
    name: "GET /health",
    traceId: "trace_001",
    spanId: "span_001",
    status: "ok",
    durationMs: 12.5
  });
  client.action("evt_action_001", "2026-06-02T10:00:05Z", {
    name: "deploy",
    status: "success"
  });
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error("timed out waiting for Express error capture");
}
