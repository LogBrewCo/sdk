import "reflect-metadata";
import { Controller, Get, Module, Req } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { RecordingTransport } from "@logbrew/sdk";
import {
  createErrorEvent,
  createLogBrewNestLogger,
  createLogBrewNestClient,
  createRequestEvent,
  LogBrewInterceptor
} from "@logbrew/nestjs";

const requestTransport = new RecordingTransport([{ statusCode: 503 }, { statusCode: 202 }]);
const autoTransport = RecordingTransport.alwaysAccept();
const errorTransport = RecordingTransport.alwaysAccept();
const autoClient = createLogBrewNestClient({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "nestjs-auto-smoke",
  sdkVersion: "0.1.1"
});
const logbrewLogger = createLogBrewNestLogger({
  client: autoClient,
  idFactory: (level, _message, context) => `evt_nestjs_logger_${level}_${String(context ?? "app").toLowerCase()}`,
  now: () => "2026-06-02T10:00:12Z"
});

const explicitClient = createLogBrewNestClient({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "nestjs-smoke-explicit",
  sdkVersion: "0.1.1"
});
if (explicitClient.pendingEvents() !== 0) {
  throw new Error("expected empty explicit client");
}

class ManualController {
  logbrew(request) {
    addFullBatch(request.logbrew.client);
    const payload = request.logbrew.previewJson();
    void request.logbrew.shutdown();
    return JSON.parse(payload);
  }
}
decorateGet(ManualController, "logbrew", "/logbrew");

class ManualModule {}
Module({ controllers: [ManualController] })(ManualModule);

const manualApp = await NestFactory.create(ManualModule, { logger: false });
manualApp.useGlobalInterceptors(new LogBrewInterceptor({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  captureRequests: false,
  maxRetries: 1,
  sdkName: "nestjs-smoke-app",
  sdkVersion: "0.1.1",
  transport: requestTransport
}));
await manualApp.listen(0, "127.0.0.1");
const okResponse = await fetch(`${await manualApp.getUrl()}/logbrew`);
const okText = await okResponse.text();
await manualApp.close();

class AutoController {
  auto() {
    logbrewLogger.log("auto route reached", "AutoController");
    return { ok: true };
  }

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
autoApp.useGlobalInterceptors(new LogBrewInterceptor({
  client: autoClient,
  errorEvent(error, { request }) {
    return createErrorEvent(error, request, {
      idFactory: () => "evt_nestjs_error_001",
      now: () => "2026-06-02T10:00:07Z"
    });
  },
  now: () => "2026-06-02T10:00:06Z",
  nowMs: () => 100,
  requestEvent(request, response, { durationMs }) {
    return createRequestEvent(request, response, {
      durationMs,
      idFactory: () => "evt_nestjs_request_001",
      now: () => "2026-06-02T10:00:06Z"
    });
  },
  transport({ request }) {
    return request.url?.startsWith("/fail") ? errorTransport : autoTransport;
  }
}));

await autoApp.listen(0, "127.0.0.1");
const autoUrl = await autoApp.getUrl();
const autoResponse = await fetch(`${autoUrl}/auto`);
await autoResponse.json();
await waitFor(() => autoTransport.sentBodies.length === 1);
const failResponse = await fetch(`${autoUrl}/fail?token=secret`);
await failResponse.json();
await waitFor(() => errorTransport.sentBodies.length === 1);
await autoApp.close();

const autoPayload = JSON.parse(autoTransport.lastBody());
const autoRequestEvent = autoPayload.events.find((event) => event.id === "evt_nestjs_request_001");
const autoLoggerEvent = autoPayload.events.find((event) => event.id === "evt_nestjs_logger_info_autocontroller");
if (!autoRequestEvent || autoRequestEvent.type !== "log") {
  throw new Error(`unexpected auto request payload: ${autoTransport.lastBody()}`);
}
if (!autoLoggerEvent || autoLoggerEvent.type !== "log" || autoLoggerEvent.attributes.level !== "info") {
  throw new Error(`unexpected auto logger payload: ${autoTransport.lastBody()}`);
}
const errorPayload = JSON.parse(errorTransport.lastBody());
const errorEvent = errorPayload.events.find((event) => event.id === "evt_nestjs_error_001");
const errorLoggerEvent = errorPayload.events.find((event) => event.id === "evt_nestjs_logger_error_autocontroller");
if (!errorEvent || errorEvent.type !== "issue") {
  throw new Error(`unexpected error payload: ${errorTransport.lastBody()}`);
}
if (!errorLoggerEvent || errorLoggerEvent.type !== "issue" || errorLoggerEvent.attributes.level !== "error") {
  throw new Error(`unexpected error logger payload: ${errorTransport.lastBody()}`);
}
if (errorEvent.attributes.metadata.path !== "/fail") {
  throw new Error(`error capture should omit query text: ${errorTransport.lastBody()}`);
}
const errorPreview = createErrorEvent(new Error("manual failure"), { method: "POST", originalUrl: "/manual" }, {
  idFactory: () => "evt_nestjs_error_preview",
  now: () => "2026-06-02T10:00:08Z"
});
if (errorPreview.attributes.title !== "POST /manual failed") {
  throw new Error(`unexpected error preview: ${JSON.stringify(errorPreview)}`);
}

console.log(okText);
console.error(JSON.stringify({
  ok: true,
  attempts: requestTransport.sentBodies.length,
  autoCaptured: autoRequestEvent.attributes.message,
  loggerCaptured: autoLoggerEvent.attributes.message,
  errorCaptured: errorEvent.attributes.title,
  errorStatus: failResponse.status,
  events: 8,
  status: okResponse.status
}));

function decorateGet(controller, method, path) {
  Controller()(controller);
  Get(path)(controller.prototype, method, Object.getOwnPropertyDescriptor(controller.prototype, method));
  Req()(controller.prototype, method, 0);
}

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
  throw new Error("timed out waiting for NestJS capture");
}
