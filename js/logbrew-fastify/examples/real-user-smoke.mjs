import {
  createErrorEvent,
  createLogBrewFastifyClient,
  createRequestEvent,
  getActiveLogBrewTrace,
  logbrewFastifyPlugin
} from "@logbrew/fastify";
import { RecordingTransport } from "@logbrew/sdk";
import { setTimeout as delay } from "node:timers/promises";
import fastify from "fastify";

/**
 * @import { FastifyRequest } from "fastify"
 * @import { LogBrewFastifyContext, LogBrewTraceContext } from "@logbrew/fastify"
 * @import { LogBrewClient } from "@logbrew/sdk"
 */

const ANY_PORT = 0;
const SERVER_ERROR = 500;
const WAIT_ATTEMPTS = 20;
const WAIT_STEP_MS = 10;
const NO_EVENTS = 0;
const ONE = 1;
const FIXED_NOW_MS = 100;
const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

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
 * @param {FastifyRequest} request
 * @returns {LogBrewFastifyContext}
 */
function requireContext(request) {
  const context = request.logbrew;
  if (!context) {
    throw new Error("the LogBrew Fastify plugin is not registered");
  }
  return context;
}

/**
 * @param {() => boolean} predicate
 * @param {number} [remaining]
 * @returns {Promise<void>}
 */
async function waitFor(predicate, remaining = WAIT_ATTEMPTS) {
  if (remaining === NO_EVENTS) {
    throw new Error("timed out waiting for Fastify capture");
  }
  if (predicate()) {
    return;
  }
  await delay(WAIT_STEP_MS);
  await waitFor(predicate, remaining - ONE);
}

/**
 * @param {RecordingTransport} transport
 * @returns {string}
 */
function lastBody(transport) {
  const body = transport.lastBody();
  if (body === null) {
    throw new Error("the transport recorded no request body");
  }
  return body;
}

/**
 * @param {string} text
 * @returns {unknown}
 */
function parseJson(text) {
  return JSON.parse(text);
}

/**
 * @param {unknown} value
 * @param {readonly string[]} path
 * @returns {unknown}
 */
function readPath(value, path) {
  let current = value;
  for (const key of path) {
    current = typeof current === "object" && current !== null ? Object.getOwnPropertyDescriptor(current, key)?.value : undefined;
  }
  return current;
}

const requestTransport = new RecordingTransport([{ statusCode: 503 }, { statusCode: 202 }]);
const autoTransport = RecordingTransport.alwaysAccept();
const errorTransport = RecordingTransport.alwaysAccept();
const app = fastify();
/** @type {(LogBrewTraceContext | undefined)[]} */
const activeTracesFromAuto = [];

const explicitClient = createLogBrewFastifyClient({
  sdkName: "fastify-smoke-explicit",
  sdkVersion: "0.1.1",
  serverApiKey: "LOGBREW_SERVER_API_KEY"
});
if (explicitClient.pendingEvents() !== NO_EVENTS) {
  throw new Error("expected empty explicit client");
}

await app.register(async (scope) => {
  await scope.register(logbrewFastifyPlugin, {
    captureRequests: false,
    maxRetries: 1,
    sdkName: "fastify-smoke-app",
    sdkVersion: "0.1.1",
    serverApiKey: "LOGBREW_SERVER_API_KEY",
    transport: requestTransport
  });

  scope.get("/logbrew", async (request) => {
    const context = requireContext(request);
    addFullBatch(context.client);
    const payload = context.previewJson();
    await context.shutdown();
    return parseJson(payload);
  });
});

await app.register(async (scope) => {
  await scope.register(logbrewFastifyPlugin, {
    now: () => "2026-06-02T10:00:06Z",
    nowMs: () => FIXED_NOW_MS,
    requestEvent(request, reply, { durationMs }) {
      return createRequestEvent(request, reply, {
        durationMs,
        idFactory: () => "evt_fastify_request_001",
        now: () => "2026-06-02T10:00:06Z"
      });
    },
    sdkName: "fastify-auto-smoke",
    sdkVersion: "0.1.1",
    serverApiKey: "LOGBREW_SERVER_API_KEY",
    spanIdFactory: () => "b7ad6b7169203331",
    transport: autoTransport
  });

  scope.get("/auto", async (request) => {
    await Promise.resolve();
    activeTracesFromAuto.push(getActiveLogBrewTrace());
    const { trace } = requireContext(request);
    if (trace?.traceId !== "4bf92f3577b34da6a3ce929d0e0e4736") {
      throw new Error(`missing Fastify request trace context: ${JSON.stringify(trace)}`);
    }
    return { ok: true };
  });
});

await app.register(async (scope) => {
  await scope.register(logbrewFastifyPlugin, {
    captureRequests: false,
    errorEvent(error, { request }) {
      return createErrorEvent(error, request, {
        idFactory: () => "evt_fastify_error_001",
        now: () => "2026-06-02T10:00:07Z"
      });
    },
    sdkName: "fastify-error-smoke",
    sdkVersion: "0.1.1",
    serverApiKey: "LOGBREW_SERVER_API_KEY",
    spanIdFactory: () => "b7ad6b7169203332",
    transport: errorTransport
  });

  scope.get("/fail", async () => {
    throw new Error("route exploded");
  });

  scope.setErrorHandler(async (error, _request, reply) => {
    await reply.code(SERVER_ERROR).send({ error: error instanceof Error ? error.message : String(error) });
  });
});

const address = await app.listen({ host: "127.0.0.1", port: ANY_PORT });
const okResponse = await fetch(`${address}/logbrew`);
const okText = await okResponse.text();
const autoResponse = await fetch(`${address}/auto?token=secret`, {
  headers: { traceparent }
});
await autoResponse.json();
await waitFor(() => autoTransport.sentBodies.length === ONE);
const failResponse = await fetch(`${address}/fail?token=secret`, {
  headers: { traceparent }
});
await failResponse.json();
await waitFor(() => errorTransport.sentBodies.length === ONE);
await app.close();

const autoEvent = readPath(parseJson(lastBody(autoTransport)), ["events", "0"]);
if (readPath(autoEvent, ["type"]) !== "span" || readPath(autoEvent, ["id"]) !== "evt_fastify_request_001") {
  throw new Error(`unexpected auto request payload: ${lastBody(autoTransport)}`);
}
if (readPath(autoEvent, ["attributes", "traceId"]) !== "4bf92f3577b34da6a3ce929d0e0e4736") {
  throw new Error(`unexpected fastify trace id: ${lastBody(autoTransport)}`);
}
if (readPath(autoEvent, ["attributes", "spanId"]) !== "b7ad6b7169203331") {
  throw new Error(`unexpected fastify request span id: ${lastBody(autoTransport)}`);
}
const [activeTraceFromAuto] = activeTracesFromAuto;
if (activeTraceFromAuto?.spanId !== "b7ad6b7169203331") {
  throw new Error(`async trace context was not preserved: ${JSON.stringify(activeTraceFromAuto)}`);
}
if (readPath(autoEvent, ["attributes", "metadata", "path"]) !== "/auto") {
  throw new Error(`request capture should omit query text: ${lastBody(autoTransport)}`);
}
const errorEvent = readPath(parseJson(lastBody(errorTransport)), ["events", "0"]);
if (readPath(errorEvent, ["type"]) !== "issue" || readPath(errorEvent, ["id"]) !== "evt_fastify_error_001") {
  throw new Error(`unexpected error payload: ${lastBody(errorTransport)}`);
}
if (readPath(errorEvent, ["attributes", "metadata", "path"]) !== "/fail") {
  throw new Error(`error capture should omit query text: ${lastBody(errorTransport)}`);
}
if (readPath(errorEvent, ["attributes", "metadata", "traceId"]) !== "4bf92f3577b34da6a3ce929d0e0e4736") {
  throw new Error(`error capture should include trace id: ${lastBody(errorTransport)}`);
}
if (readPath(errorEvent, ["attributes", "metadata", "spanId"]) !== "b7ad6b7169203332") {
  throw new Error(`error capture should include request span id: ${lastBody(errorTransport)}`);
}
const errorPreview = createErrorEvent(
  new Error("manual failure"),
  { method: "POST", url: "/manual" },
  {
    idFactory: () => "evt_fastify_error_preview",
    now: () => "2026-06-02T10:00:08Z"
  }
);
if (errorPreview.attributes.title !== "POST /manual failed") {
  throw new Error(`unexpected error preview: ${JSON.stringify(errorPreview)}`);
}

process.stdout.write(`${okText}\n`);
process.stderr.write(
  `${JSON.stringify({
    ok: true,

    attempts: requestTransport.sentBodies.length,
    autoCaptured: readPath(autoEvent, ["attributes", "name"]),
    autoTraceId: readPath(autoEvent, ["attributes", "traceId"]),
    errorCaptured: readPath(errorEvent, ["attributes", "title"]),
    errorTraceId: readPath(errorEvent, ["attributes", "metadata", "traceId"]),

    errorStatus: failResponse.status,
    events: 6,
    status: okResponse.status
  })}\n`
);
