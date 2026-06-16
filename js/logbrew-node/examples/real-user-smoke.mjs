import { createServer } from "node:http";
import { once } from "node:events";
import { RecordingTransport } from "@logbrew/sdk";
import {
  captureHttpError,
  createHttpErrorEvent,
  createHttpRequestEvent,
  createLogBrewNodeClient,
  createLogBrewNodeContext,
  getActiveLogBrewTrace,
  withLogBrewHttpHandler
} from "@logbrew/node";

const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const requestTransport = new RecordingTransport([{ statusCode: 503 }, { statusCode: 202 }]);
const client = createLogBrewNodeClient({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "node-smoke-app",
  sdkVersion: "0.1.0",
  maxRetries: 1
});

const server = createServer(withLogBrewHttpHandler((req, res, logbrew) => {
  addFullBatch(logbrew.client);
  const event = createHttpRequestEvent(req, res, {
    idFactory: () => "evt_node_request_001",
    now: () => "2026-06-02T10:00:06Z"
  });
  if (event.attributes.metadata.path !== "/smoke") {
    throw new Error(`unexpected request event: ${JSON.stringify(event)}`);
  }
  res.end("ok");
}, {
  captureRequests: false,
  client,
  transport: requestTransport
}));

server.listen(0);
await once(server, "listening");
const port = server.address().port;
const response = await fetch(`http://127.0.0.1:${port}/smoke`);
if (response.status !== 200) {
  throw new Error(`unexpected status: ${response.status}`);
}
const payload = client.previewJson();
await client.shutdown(requestTransport);
server.close();
await once(server, "close");

const captureTransport = RecordingTransport.alwaysAccept();
const captureClient = createLogBrewNodeClient({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "node-request-capture-smoke",
  sdkVersion: "0.1.0"
});
let activeTraceFromAsync;
const captureServer = createServer(withLogBrewHttpHandler((req, res, logbrew) => {
  Promise.resolve().then(() => {
    activeTraceFromAsync = getActiveLogBrewTrace();
  });
  if (logbrew.trace?.traceId !== "4bf92f3577b34da6a3ce929d0e0e4736") {
    throw new Error(`missing request trace context: ${JSON.stringify(logbrew.trace)}`);
  }
  res.statusCode = req.url?.startsWith("/captured") ? 204 : 404;
  res.end();
}, {
  client: captureClient,
  idFactory: () => "evt_node_request_auto",
  now: () => "2026-06-02T10:00:07Z",
  spanIdFactory: () => "b7ad6b7169203331",
  transport: captureTransport
}));
captureServer.listen(0);
await once(captureServer, "listening");
const capturePort = captureServer.address().port;
const captureResponse = await fetch(`http://127.0.0.1:${capturePort}/captured?token=secret`, {
  headers: { traceparent }
});
if (captureResponse.status !== 204) {
  throw new Error(`unexpected capture status: ${captureResponse.status}`);
}
await waitFor(() => captureTransport.sentBodies.length === 1 && activeTraceFromAsync);
captureServer.close();
await once(captureServer, "close");

const errorTransport = RecordingTransport.alwaysAccept();
const errorClient = createLogBrewNodeClient({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "node-error-smoke",
  sdkVersion: "0.1.0"
});
const errorServer = createServer(withLogBrewHttpHandler(() => {
  throw new Error("node handler exploded");
}, {
  client: errorClient,
  errorEvent(error, { req, trace }) {
    if (trace?.spanId !== "b7ad6b7169203332") {
      throw new Error(`missing error callback trace: ${JSON.stringify(trace)}`);
    }
    return createHttpErrorEvent(error, req, {
      idFactory: () => "evt_node_error_001",
      now: () => "2026-06-02T10:00:08Z"
    });
  },
  spanIdFactory: () => "b7ad6b7169203332",
  transport: errorTransport
}));
errorServer.listen(0);
await once(errorServer, "listening");
const errorPort = errorServer.address().port;
const errorResponse = await fetch(`http://127.0.0.1:${errorPort}/explode?token=secret`, {
  headers: { traceparent }
});
if (errorResponse.status !== 500) {
  throw new Error(`unexpected error status: ${errorResponse.status}`);
}
await waitFor(() => errorTransport.sentBodies.length === 1);
errorServer.close();
await once(errorServer, "close");

const manualErrorTransport = RecordingTransport.alwaysAccept();
const manualErrorClient = createLogBrewNodeClient({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "node-manual-error-smoke",
  sdkVersion: "0.1.0"
});
const manualServer = createServer(async (req, res) => {
  const context = createLogBrewNodeContext(manualErrorClient, manualErrorTransport);
  await captureHttpError(new Error("manual node failure"), req, res, context, {
    idFactory: () => "evt_node_error_manual",
    now: () => "2026-06-02T10:00:09Z"
  });
  res.end("captured");
});
manualServer.listen(0);
await once(manualServer, "listening");
const manualPort = manualServer.address().port;
const manualResponse = await fetch(`http://127.0.0.1:${manualPort}/manual?token=secret`);
if (manualResponse.status !== 200) {
  throw new Error(`unexpected manual status: ${manualResponse.status}`);
}
await waitFor(() => manualErrorTransport.sentBodies.length === 1);
manualServer.close();
await once(manualServer, "close");

const capturePayload = JSON.parse(captureTransport.lastBody());
const errorPayload = JSON.parse(errorTransport.lastBody());
const manualErrorPayload = JSON.parse(manualErrorTransport.lastBody());
if (capturePayload.events[0].id !== "evt_node_request_auto") {
  throw new Error(`unexpected request capture payload: ${captureTransport.lastBody()}`);
}
if (capturePayload.events[0].attributes.metadata.path !== "/captured") {
  throw new Error(`request capture should omit query text: ${captureTransport.lastBody()}`);
}
if (capturePayload.events[0].type !== "span") {
  throw new Error(`expected node request span payload: ${captureTransport.lastBody()}`);
}
if (capturePayload.events[0].attributes.traceId !== "4bf92f3577b34da6a3ce929d0e0e4736") {
  throw new Error(`unexpected node trace id: ${captureTransport.lastBody()}`);
}
if (capturePayload.events[0].attributes.parentSpanId !== "00f067aa0ba902b7") {
  throw new Error(`unexpected node parent span id: ${captureTransport.lastBody()}`);
}
if (capturePayload.events[0].attributes.spanId !== "b7ad6b7169203331") {
  throw new Error(`unexpected node request span id: ${captureTransport.lastBody()}`);
}
if (capturePayload.events[0].attributes.metadata.sampled !== true) {
  throw new Error(`missing sampled request metadata: ${captureTransport.lastBody()}`);
}
if (activeTraceFromAsync?.spanId !== "b7ad6b7169203331") {
  throw new Error(`async trace context was not preserved: ${JSON.stringify(activeTraceFromAsync)}`);
}
if (errorPayload.events[0].id !== "evt_node_error_001") {
  throw new Error(`unexpected error payload: ${errorTransport.lastBody()}`);
}
if (errorPayload.events[0].attributes.metadata.path !== "/explode") {
  throw new Error(`error capture should omit query text: ${errorTransport.lastBody()}`);
}
if (errorPayload.events[0].attributes.metadata.traceId !== "4bf92f3577b34da6a3ce929d0e0e4736") {
  throw new Error(`error capture should include trace id: ${errorTransport.lastBody()}`);
}
if (errorPayload.events[0].attributes.metadata.spanId !== "b7ad6b7169203332") {
  throw new Error(`error capture should include request span id: ${errorTransport.lastBody()}`);
}
if (manualErrorPayload.events[0].id !== "evt_node_error_manual") {
  throw new Error(`unexpected manual error payload: ${manualErrorTransport.lastBody()}`);
}
if (manualErrorPayload.events[0].attributes.metadata.path !== "/manual") {
  throw new Error(`manual error capture should omit query text: ${manualErrorTransport.lastBody()}`);
}

console.log(payload);
console.error(JSON.stringify({
  ok: true,
  attempts: requestTransport.sentBodies.length,
  errorCaptured: errorPayload.events[0].attributes.title,
  events: JSON.parse(payload).events.length,
  manualErrorCaptured: manualErrorPayload.events[0].attributes.title,
  requestCaptured: capturePayload.events[0].attributes.name,
  requestTraceId: capturePayload.events[0].attributes.traceId,
  requestHelper: "evt_node_request_001"
}));

function addFullBatch(logbrew) {
  logbrew.release("evt_release_001", "2026-06-02T10:00:00Z", {
    version: "1.2.3",
    commit: "abc123def456",
    notes: "Public release marker"
  });
  logbrew.environment("evt_environment_001", "2026-06-02T10:00:01Z", {
    name: "production",
    region: "global"
  });
  logbrew.issue("evt_issue_001", "2026-06-02T10:00:02Z", {
    title: "Checkout timeout",
    level: "error",
    message: "Request timed out after retry budget"
  });
  logbrew.log("evt_log_001", "2026-06-02T10:00:03Z", {
    message: "worker started",
    level: "info",
    logger: "job-runner"
  });
  logbrew.span("evt_span_001", "2026-06-02T10:00:04Z", {
    name: "GET /health",
    traceId: "trace_001",
    spanId: "span_001",
    status: "ok",
    durationMs: 12.5
  });
  logbrew.action("evt_action_001", "2026-06-02T10:00:05Z", {
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
  throw new Error("timed out waiting for Node.js capture");
}
