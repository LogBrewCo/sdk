let sdk;
try {
  sdk = require("@logbrew/sdk");
} catch (error) {
  if (error && error.code === "MODULE_NOT_FOUND") {
    sdk = require("../index.cjs");
  } else {
    throw error;
  }
}

const { LogBrewClient, RecordingTransport } = sdk;

const client = LogBrewClient.create({
  apiKey: "LOGBREW_API_KEY",
  sdkName: "smoke-app-cjs",
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

console.log(client.previewJson());

const transport = RecordingTransport.alwaysAccept();
client.shutdown(transport).then((response) => {
  console.error(JSON.stringify({ ok: true, status: response.statusCode, attempts: response.attempts, events: 6 }));
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
