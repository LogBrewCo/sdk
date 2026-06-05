import "reflect-metadata";
import { Controller, Get, Module, Req } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { RecordingTransport } from "@logbrew/sdk";
import { LogBrewInterceptor } from "@logbrew/nestjs";

const transport = RecordingTransport.alwaysAccept();

class AppController {
  logbrew(request) {
    addFullBatch(request.logbrew.client);
    const payload = request.logbrew.previewJson();
    void request.logbrew.shutdown();
    return JSON.parse(payload);
  }
}

decorateGet(AppController, "logbrew", "/logbrew");

class AppModule {}
Module({ controllers: [AppController] })(AppModule);

const app = await NestFactory.create(AppModule, { logger: false });
app.useGlobalInterceptors(new LogBrewInterceptor({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  captureRequests: false,
  transport
}));

await app.listen(0, "127.0.0.1");
const response = await fetch(`${await app.getUrl()}/logbrew`);
const payload = await response.text();
await app.close();

console.log(payload);
console.error(JSON.stringify({
  ok: true,
  attempts: transport.sentBodies.length,
  status: response.status
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
