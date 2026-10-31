import "reflect-metadata";
import { Controller, Get, Module, Req } from "@nestjs/common";
import {
  LogBrewInterceptor,
  createErrorEvent,
  createLogBrewNestClient,
  createLogBrewNestLogger,
  createRequestEvent
} from "@logbrew/nestjs";
import { NestFactory } from "@nestjs/core";
import { RecordingTransport } from "@logbrew/sdk";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

/**
 * @import { Request } from "express"
 * @import { LogBrewClient } from "@logbrew/sdk"
 */

const ANY_PORT = 0;
const REQUEST_ARGUMENT = 0;
const WAIT_ATTEMPTS = 20;
const WAIT_STEP_MS = 10;
const CAPTURED_EVENTS = 8;
const FIXED_NOW_MS = 100;
const NONE = 0;
const ONE = 1;

/**
 * @template {object} Instance
 * @param {{ new (): Instance, readonly prototype: Instance }} controller
 * @param {string} method
 * @param {string} path
 * @returns {void}
 */
function decorateGet(controller, method, path) {
  const descriptor = Object.getOwnPropertyDescriptor(controller.prototype, method);
  if (descriptor === undefined) {
    throw new Error(`missing controller method: ${method}`);
  }
  Controller()(controller);
  Get(path)(controller.prototype, method, descriptor);
  Req()(controller.prototype, method, REQUEST_ARGUMENT);
}

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
  if (remaining === NONE) {
    throw new Error("timed out waiting for NestJS capture");
  }
  if (predicate()) {
    return;
  }
  await delay(WAIT_STEP_MS);
  await waitFor(predicate, remaining - ONE);
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

/**
 * @param {unknown} value
 * @returns {value is readonly unknown[]}
 */
function isList(value) {
  return Array.isArray(value);
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
 * @param {string} body
 * @param {string} id
 * @returns {unknown}
 */
function findEvent(body, id) {
  /** @type {unknown} */
  const batch = JSON.parse(body);
  const events = readPath(batch, ["events"]);
  const event = isList(events) ? events.find((candidate) => readPath(candidate, ["id"]) === id) : undefined;
  if (event === undefined) {
    throw new Error(`missing event ${id}: ${body}`);
  }
  return event;
}

const requestTransport = new RecordingTransport([{ statusCode: 503 }, { statusCode: 202 }]);
const autoTransport = RecordingTransport.alwaysAccept();
const errorTransport = RecordingTransport.alwaysAccept();
const autoClient = createLogBrewNestClient({
  serverApiKey: "LOGBREW_SERVER_API_KEY",

  sdkName: "nestjs-auto-smoke",
  sdkVersion: "0.1.4"
});
const logbrewLogger = createLogBrewNestLogger({
  client: autoClient,
  idFactory: (level, _message, context) => `evt_nestjs_logger_${level}_${(context ?? "app").toLowerCase()}`,
  now: () => "2026-06-02T10:00:12Z"
});

const explicitClient = createLogBrewNestClient({
  serverApiKey: "LOGBREW_SERVER_API_KEY",

  sdkName: "nestjs-smoke-explicit",
  sdkVersion: "0.1.4"
});
if (explicitClient.pendingEvents() !== NONE) {
  throw new Error("expected empty explicit client");
}

class ManualController {
  /**
   * @param {Request} request
   * @returns {unknown}
   */
  logbrew(request) {
    const context = request.logbrew;
    if (!context) {
      throw new Error("the LogBrew NestJS interceptor is not installed");
    }
    addFullBatch(context.client);
    const payload = context.previewJson();
    void context.shutdown();
    return JSON.parse(payload);
  }
}
decorateGet(ManualController, "logbrew", "/logbrew");

class ManualModule {}
Module({ controllers: [ManualController] })(ManualModule);

const manualApp = await NestFactory.create(ManualModule, { logger: false });
manualApp.useGlobalInterceptors(
  new LogBrewInterceptor({
    serverApiKey: "LOGBREW_SERVER_API_KEY",

    captureRequests: false,
    maxRetries: 1,
    sdkName: "nestjs-smoke-app",
    sdkVersion: "0.1.4",
    transport: requestTransport
  })
);
await manualApp.listen(ANY_PORT, "127.0.0.1");
const okResponse = await fetch(`${await manualApp.getUrl()}/logbrew`);
const okText = await okResponse.text();
await manualApp.close();

class AutoController {
  /**
   * @returns {{ ok: boolean }}
   */
  auto() {
    logbrewLogger.log("auto route reached", "AutoController");
    return { ok: true };
  }

  /**
   * @returns {never}
   */
  fail() {
    logbrewLogger.error("route failed", undefined, "AutoController");
    throw new Error("route exploded");
  }
}
decorateGet(AutoController, "auto", "/auto");
decorateGet(AutoController, "fail", "/fail");

class AutoModule {}
Module({ controllers: [AutoController] })(AutoModule);

const autoApp = await NestFactory.create(AutoModule, { logger: false });
autoApp.useGlobalInterceptors(
  new LogBrewInterceptor({
    client: autoClient,
    errorEvent: (error, { request }) =>
      createErrorEvent(error, request, {
        idFactory: () => "evt_nestjs_error_001",
        now: () => "2026-06-02T10:00:07Z"
      }),
    now: () => "2026-06-02T10:00:06Z",
    nowMs: () => FIXED_NOW_MS,
    requestEvent: (request, response, { durationMs }) =>
      createRequestEvent(request, response, {
        durationMs,
        idFactory: () => "evt_nestjs_request_001",
        now: () => "2026-06-02T10:00:06Z"
      }),
    transport: ({ request }) => (request.url.startsWith("/fail") ? errorTransport : autoTransport)
  })
);

await autoApp.listen(ANY_PORT, "127.0.0.1");
const autoUrl = await autoApp.getUrl();
const autoResponse = await fetch(`${autoUrl}/auto`);
await autoResponse.json();
await waitFor(() => autoTransport.sentBodies.length === ONE);
const failResponse = await fetch(`${autoUrl}/fail?token=secret`);
await failResponse.json();
await waitFor(() => errorTransport.sentBodies.length === ONE);
await autoApp.close();

const autoBody = lastBody(autoTransport);
const autoRequestEvent = findEvent(autoBody, "evt_nestjs_request_001");
const autoLoggerEvent = findEvent(autoBody, "evt_nestjs_logger_info_autocontroller");
assert.equal(readPath(autoRequestEvent, ["type"]), "span", `unexpected auto request payload: ${autoBody}`);
assert.equal(readPath(autoLoggerEvent, ["type"]), "log", `unexpected auto logger payload: ${autoBody}`);
assert.equal(readPath(autoLoggerEvent, ["attributes", "level"]), "info", `unexpected auto logger payload: ${autoBody}`);
const errorBody = lastBody(errorTransport);
const errorEvent = findEvent(errorBody, "evt_nestjs_error_001");
const errorLoggerEvent = findEvent(errorBody, "evt_nestjs_logger_error_autocontroller");
assert.equal(readPath(errorEvent, ["type"]), "issue", `unexpected error payload: ${errorBody}`);
assert.equal(readPath(errorLoggerEvent, ["type"]), "issue", `unexpected error logger payload: ${errorBody}`);
assert.equal(readPath(errorLoggerEvent, ["attributes", "level"]), "error", `unexpected error logger payload: ${errorBody}`);
assert.equal(readPath(errorEvent, ["attributes", "metadata", "path"]), "/fail", `error capture should omit query text: ${errorBody}`);
const errorPreview = createErrorEvent(new Error("manual failure"), { method: "POST", originalUrl: "/manual" }, {
  idFactory: () => "evt_nestjs_error_preview",
  now: () => "2026-06-02T10:00:08Z"
});
assert.equal(errorPreview.attributes.title, "POST /manual failed", `unexpected error preview: ${JSON.stringify(errorPreview)}`);

process.stdout.write(`${okText}\n`);
process.stderr.write(
  `${JSON.stringify({
    ok: true,

    attempts: requestTransport.sentBodies.length,
    autoCaptured: readPath(autoRequestEvent, ["attributes", "name"]),
    loggerCaptured: readPath(autoLoggerEvent, ["attributes", "message"]),

    errorCaptured: readPath(errorEvent, ["attributes", "title"]),
    errorStatus: failResponse.status,
    events: CAPTURED_EVENTS,
    status: okResponse.status
  })}\n`
);
