import {
  getActiveLogBrewTrace,
  logbrewErrorHandler,
  logbrewMiddleware,
  withLogBrewExpressHandler
} from "@logbrew/express";
import { RecordingTransport } from "@logbrew/sdk";
import { setTimeout as delay } from "node:timers/promises";
import express from "express";
import { once } from "node:events";

/**
 * @import { NextFunction, Request, Response } from "express"
 * @import { LogBrewTraceContext } from "@logbrew/express"
 * @import { LogBrewClient } from "@logbrew/sdk"
 */

const ANY_PORT = 0;
const NO_PORT = 0;
const SERVER_ERROR = 500;
const WAIT_ATTEMPTS = 20;
const WAIT_STEP_MS = 10;
const NO_ATTEMPTS = 0;
const NO_ITEMS = 0;
const ONE = 1;
const LAST = -1;
const EVENT_COUNT = 6;
const SPAN_ID = "b7ad6b7169203331";
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const traceparent = `00-${TRACE_ID}-00f067aa0ba902b7-01`;

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
 * @param {() => boolean} predicate
 * @param {number} [remaining]
 * @returns {Promise<void>}
 */
async function waitFor(predicate, remaining = WAIT_ATTEMPTS) {
  if (remaining === NO_ATTEMPTS) {
    throw new Error("timed out waiting for Express error capture");
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
 * @param {unknown} value
 * @param {readonly string[]} path
 * @returns {unknown}
 */
function readPath(value, path) {
  const [key, ...rest] = path;
  if (key === undefined) {
    return value;
  }
  /** @type {unknown} */
  const field = typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
  return readPath(field, rest);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function hasItems(value) {
  return Array.isArray(value) && value.length > NO_ITEMS;
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

/** @type {(LogBrewTraceContext | undefined)[]} */
const activeTracesFromAsync = [];

/**
 * @returns {Promise<never>}
 */
async function failRoute() {
  await Promise.resolve();
  activeTracesFromAsync.push(getActiveLogBrewTrace());
  throw new Error("route exploded");
}

/**
 * @param {unknown} error
 * @param {Request} _req
 * @param {Response} res
 * @param {NextFunction} _next
 * @returns {void}
 */
function respondWithError(error, _req, res, _next) {
  res.status(SERVER_ERROR).json({ error: error instanceof Error ? error.message : "unknown error" });
}

/**
 * @param {unknown} issue
 * @param {string} body
 * @returns {void}
 */
function checkIssue(issue, body) {
  if (readPath(issue, ["type"]) !== "issue" || readPath(issue, ["id"]) !== "evt_express_error_001") {
    throw new Error(`unexpected error payload: ${body}`);
  }
  if (
    readPath(issue, ["attributes", "metadata", "routeTemplate"]) !== "/fail" ||
    readPath(issue, ["attributes", "exception", "mechanism", "type"]) !== "express.middleware" ||
    readPath(issue, ["attributes", "exception", "mechanism", "handled"]) !== false ||
    !hasItems(readPath(issue, ["attributes", "stackFrames"])) ||
    !hasItems(readPath(issue, ["attributes", "breadcrumbs"]))
  ) {
    throw new Error(`error capture should retain structured evidence without query text: ${body}`);
  }
  if (readPath(issue, ["attributes", "metadata", "traceId"]) !== TRACE_ID) {
    throw new Error(`error capture should include trace id: ${body}`);
  }
  if (readPath(issue, ["attributes", "metadata", "spanId"]) !== SPAN_ID) {
    throw new Error(`error capture should include request span id: ${body}`);
  }
}

const requestTransport = new RecordingTransport([{ statusCode: 503 }, { statusCode: 202 }]);
const errorTransport = RecordingTransport.alwaysAccept();
const app = express();

app.use("/logbrew", logbrewMiddleware({
  captureRequests: false,
  maxRetries: 1,
  sdkName: "logbrew-express-real-user-smoke",
  sdkVersion: "0.1.1",
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  transport: requestTransport
}));

app.get("/logbrew", sendBatch);

app.use("/fail", logbrewMiddleware({
  captureRequests: false,
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  spanIdFactory: () => SPAN_ID,
  transport: errorTransport
}));

app.get("/fail", withLogBrewExpressHandler(failRoute));

app.use(logbrewErrorHandler({
  idFactory: () => "evt_express_error_001",
  now: () => "2026-06-02T10:00:06Z",
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  transport: errorTransport
}));

app.use(respondWithError);

const server = app.listen(ANY_PORT);
await once(server, "listening");
const address = server.address();
const port = typeof address === "object" && address !== null ? address.port : NO_PORT;
const okResponse = await fetch(`http://127.0.0.1:${String(port)}/logbrew`);
const okText = await okResponse.text();
const failResponse = await fetch(`http://127.0.0.1:${String(port)}/fail?token=secret`, {
  headers: { traceparent }
});
await failResponse.json();
await waitFor(() => errorTransport.sentBodies.length === ONE);
server.close();
await once(server, "close");

const errorBody = lastBody(errorTransport);
/** @type {unknown} */
const errorPayload = JSON.parse(errorBody);
const issue = readPath(errorPayload, ["events", "0"]);
checkIssue(issue, errorBody);
const activeTraceFromAsync = activeTracesFromAsync.at(LAST);
if (activeTraceFromAsync?.spanId !== SPAN_ID) {
  throw new Error(`async trace context was not preserved: ${JSON.stringify(activeTraceFromAsync)}`);
}

process.stdout.write(`${okText}\n`);
process.stderr.write(
  `${JSON.stringify({
    ok: true,

    status: okResponse.status,

    attempts: requestTransport.sentBodies.length,
    errorStatus: failResponse.status,

    errorCaptured: readPath(issue, ["attributes", "title"]),
    errorTraceId: readPath(issue, ["attributes", "metadata", "traceId"]),
    events: EVENT_COUNT
  })}\n`
);
