import Fastify from "fastify";
import { RecordingTransport } from "@logbrew/sdk";
import {
  createErrorEvent,
  createLogBrewFastifyClient,
  createRequestEvent,
  getActiveLogBrewTrace,
  logbrewFastifyPlugin
} from "@logbrew/fastify";

const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const requestTransport = new RecordingTransport([{ statusCode: 503 }, { statusCode: 202 }]);
const autoTransport = RecordingTransport.alwaysAccept();
const errorTransport = RecordingTransport.alwaysAccept();
const app = Fastify();
let activeTraceFromAuto;

const explicitClient = createLogBrewFastifyClient({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "fastify-smoke-explicit",
  sdkVersion: "0.1.0"
});
if (explicitClient.pendingEvents() !== 0) {
  throw new Error("expected empty explicit client");
}

await app.register(async (scope) => {
  await scope.register(logbrewFastifyPlugin, {
    serverApiKey: "LOGBREW_SERVER_API_KEY",
    captureRequests: false,
    maxRetries: 1,
    sdkName: "fastify-smoke-app",
    sdkVersion: "0.1.0",
    transport: requestTransport
  });

  scope.get("/logbrew", async (request) => {
    addFullBatch(request.logbrew.client);
    const payload = request.logbrew.previewJson();
    await request.logbrew.shutdown();
    return JSON.parse(payload);
  });
});

await app.register(async (scope) => {
  await scope.register(logbrewFastifyPlugin, {
    serverApiKey: "LOGBREW_SERVER_API_KEY",
    now: () => "2026-06-02T10:00:06Z",
    nowMs: () => 100,
    spanIdFactory: () => "b7ad6b7169203331",
    requestEvent(request, reply, { durationMs }) {
      return createRequestEvent(request, reply, {
        durationMs,
        idFactory: () => "evt_fastify_request_001",
        now: () => "2026-06-02T10:00:06Z"
      });
    },
    sdkName: "fastify-auto-smoke",
    sdkVersion: "0.1.0",
    transport: autoTransport
  });

  scope.get("/auto", async (request) => {
    await Promise.resolve().then(() => {
      activeTraceFromAuto = getActiveLogBrewTrace();
    });
    if (request.logbrew.trace?.traceId !== "4bf92f3577b34da6a3ce929d0e0e4736") {
      throw new Error(`missing Fastify request trace context: ${JSON.stringify(request.logbrew.trace)}`);
    }
    return { ok: true };
  });
});

await app.register(async (scope) => {
  await scope.register(logbrewFastifyPlugin, {
    serverApiKey: "LOGBREW_SERVER_API_KEY",
    captureRequests: false,
    spanIdFactory: () => "b7ad6b7169203332",
    errorEvent(error, { request }) {
      return createErrorEvent(error, request, {
        idFactory: () => "evt_fastify_error_001",
        now: () => "2026-06-02T10:00:07Z"
      });
    },
    sdkName: "fastify-error-smoke",
    sdkVersion: "0.1.0",
    transport: errorTransport
  });

  scope.get("/fail", async () => {
    throw new Error("route exploded");
  });

  scope.setErrorHandler((error, _request, reply) => {
    reply.code(500).send({ error: error.message });
  });
});

const address = await app.listen({ host: "127.0.0.1", port: 0 });
const okResponse = await fetch(`${address}/logbrew`);
const okText = await okResponse.text();
const autoResponse = await fetch(`${address}/auto?token=secret`, {
  headers: { traceparent }
});
await autoResponse.json();
await waitFor(() => autoTransport.sentBodies.length === 1);
const failResponse = await fetch(`${address}/fail?token=secret`, {
  headers: { traceparent }
});
await failResponse.json();
await waitFor(() => errorTransport.sentBodies.length === 1);
await app.close();

const autoPayload = JSON.parse(autoTransport.lastBody());
if (autoPayload.events[0].type !== "span" || autoPayload.events[0].id !== "evt_fastify_request_001") {
  throw new Error(`unexpected auto request payload: ${autoTransport.lastBody()}`);
}
if (autoPayload.events[0].attributes.traceId !== "4bf92f3577b34da6a3ce929d0e0e4736") {
  throw new Error(`unexpected fastify trace id: ${autoTransport.lastBody()}`);
}
if (autoPayload.events[0].attributes.spanId !== "b7ad6b7169203331") {
  throw new Error(`unexpected fastify request span id: ${autoTransport.lastBody()}`);
}
if (activeTraceFromAuto?.spanId !== "b7ad6b7169203331") {
  throw new Error(`async trace context was not preserved: ${JSON.stringify(activeTraceFromAuto)}`);
}
if (autoPayload.events[0].attributes.metadata.path !== "/auto") {
  throw new Error(`request capture should omit query text: ${autoTransport.lastBody()}`);
}
const errorPayload = JSON.parse(errorTransport.lastBody());
if (errorPayload.events[0].type !== "issue" || errorPayload.events[0].id !== "evt_fastify_error_001") {
  throw new Error(`unexpected error payload: ${errorTransport.lastBody()}`);
}
if (errorPayload.events[0].attributes.metadata.path !== "/fail") {
  throw new Error(`error capture should omit query text: ${errorTransport.lastBody()}`);
}
if (errorPayload.events[0].attributes.metadata.traceId !== "4bf92f3577b34da6a3ce929d0e0e4736") {
  throw new Error(`error capture should include trace id: ${errorTransport.lastBody()}`);
}
if (errorPayload.events[0].attributes.metadata.spanId !== "b7ad6b7169203332") {
  throw new Error(`error capture should include request span id: ${errorTransport.lastBody()}`);
}
const errorPreview = createErrorEvent(new Error("manual failure"), { method: "POST", url: "/manual" }, {
  idFactory: () => "evt_fastify_error_preview",
  now: () => "2026-06-02T10:00:08Z"
});
if (errorPreview.attributes.title !== "POST /manual failed") {
  throw new Error(`unexpected error preview: ${JSON.stringify(errorPreview)}`);
}

console.log(okText);
console.error(JSON.stringify({
  ok: true,
  attempts: requestTransport.sentBodies.length,
  autoCaptured: autoPayload.events[0].attributes.name,
  autoTraceId: autoPayload.events[0].attributes.traceId,
  errorCaptured: errorPayload.events[0].attributes.title,
  errorTraceId: errorPayload.events[0].attributes.metadata.traceId,
  errorStatus: failResponse.status,
  events: 6,
  status: okResponse.status
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
  throw new Error("timed out waiting for Fastify capture");
}
