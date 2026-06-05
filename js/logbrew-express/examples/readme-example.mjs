import express from "express";
import { RecordingTransport } from "@logbrew/sdk";
import { logbrewMiddleware } from "@logbrew/express";

const transport = RecordingTransport.alwaysAccept();
const app = express();

app.use(logbrewMiddleware({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "logbrew-express-readme-example",
  sdkVersion: "0.1.0",
  captureRequests: false,
  transport
}));

app.get("/logbrew", (req, res) => {
  addFullBatch(req.logbrew.client);
  res.type("json").send(req.logbrew.previewJson());
  void req.logbrew.shutdown();
});

const server = app.listen(0);
const port = server.address().port;
const response = await fetch(`http://127.0.0.1:${port}/logbrew`);
const text = await response.text();
await new Promise((resolve) => {
  server.close(resolve);
});

console.log(text);
console.error(JSON.stringify({ ok: true, status: response.status, attempts: transport.sentBodies.length, events: 6 }));

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
