import express from "express";
import { RecordingTransport } from "@logbrew/sdk";
import {
  getActiveLogBrewTrace,
  logbrewErrorHandler,
  logbrewMiddleware
} from "@logbrew/express";

const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
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

app.use("/fail", logbrewMiddleware({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  transport: errorTransport,
  captureRequests: false,
  spanIdFactory: () => "b7ad6b7169203331"
}));

let activeTraceFromAsync;
app.get("/fail", async () => {
  await Promise.resolve().then(() => {
    activeTraceFromAsync = getActiveLogBrewTrace();
  });
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
const failResponse = await fetch(`http://127.0.0.1:${port}/fail?token=secret`, {
  headers: { traceparent }
});
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
if (errorPayload.events[0].attributes.metadata.traceId !== "4bf92f3577b34da6a3ce929d0e0e4736") {
  throw new Error(`error capture should include trace id: ${errorTransport.lastBody()}`);
}
if (errorPayload.events[0].attributes.metadata.spanId !== "b7ad6b7169203331") {
  throw new Error(`error capture should include request span id: ${errorTransport.lastBody()}`);
}
if (activeTraceFromAsync?.spanId !== "b7ad6b7169203331") {
  throw new Error(`async trace context was not preserved: ${JSON.stringify(activeTraceFromAsync)}`);
}

console.log(okText);
console.error(JSON.stringify({
  ok: true,
  status: okResponse.status,
  attempts: requestTransport.sentBodies.length,
  errorStatus: failResponse.status,
  errorCaptured: errorPayload.events[0].attributes.title,
  errorTraceId: errorPayload.events[0].attributes.metadata.traceId,
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
