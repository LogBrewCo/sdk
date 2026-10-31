import "reflect-metadata";
import { Controller, Get, Module, Req } from "@nestjs/common";
import { LogBrewInterceptor } from "@logbrew/nestjs";
import { NestFactory } from "@nestjs/core";
import { RecordingTransport } from "@logbrew/sdk";

/**
 * @import { Request } from "express"
 * @import { LogBrewClient } from "@logbrew/sdk"
 */

const ANY_PORT = 0;
const REQUEST_ARGUMENT = 0;

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

class AppController {
  /**
   * @param {Request} request
   * @returns {Promise<unknown>}
   */
  async logbrew(request) {
    const context = request.logbrew;
    if (!context) {
      throw new Error("the LogBrew NestJS interceptor is not installed");
    }
    addFullBatch(context.client);
    const payload = context.previewJson();
    await context.shutdown();
    return JSON.parse(payload);
  }
}

decorateGet(AppController, "logbrew", "/logbrew");

class AppModule {}
Module({ controllers: [AppController] })(AppModule);

const transport = RecordingTransport.alwaysAccept();
const app = await NestFactory.create(AppModule, { logger: false });
app.useGlobalInterceptors(
  new LogBrewInterceptor({
    captureRequests: false,
    serverApiKey: "LOGBREW_SERVER_API_KEY",
    transport
  })
);

await app.listen(ANY_PORT, "127.0.0.1");
const response = await fetch(`${await app.getUrl()}/logbrew`);
const payload = await response.text();
await app.close();

process.stdout.write(`${payload}\n`);
process.stderr.write(
  `${JSON.stringify({
    ok: true,

    attempts: transport.sentBodies.length,
    mode: "local-preview",
    status: response.status
  })}\n`
);
