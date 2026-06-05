import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const sdk = await import("@logbrew/sdk").catch(async (error) => {
  if (error && error.code === "ERR_MODULE_NOT_FOUND") {
    return import("../../logbrew-js/index.js");
  }
  throw error;
});

const reactSdk = await import("@logbrew/react").catch(async (error) => {
  if (error && error.code === "ERR_MODULE_NOT_FOUND") {
    return import("../index.js");
  }
  throw error;
});

const { RecordingTransport } = sdk;
const { LogBrewProvider, createLogBrewReactClient, useLogBrew } = reactSdk;

const client = createLogBrewReactClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "logbrew-react",
  sdkVersion: "0.1.0"
});

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

function PendingEventsLabel() {
  const logbrew = useLogBrew();
  return React.createElement("span", { "data-logbrew-pending": logbrew.pendingEvents() }, "pending events");
}

const markup = renderToStaticMarkup(
  React.createElement(
    LogBrewProvider,
    { client },
    React.createElement(PendingEventsLabel)
  )
);
if (!markup.includes('data-logbrew-pending="6"')) {
  throw new Error(`expected provider hook to expose six pending events, got ${markup}`);
}

console.log(client.previewJson());

const transport = RecordingTransport.alwaysAccept();
const response = await client.shutdown(transport);
console.error(JSON.stringify({ ok: true, status: response.statusCode, attempts: response.attempts, events: 6, rendered: true }));
