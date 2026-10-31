import { LogBrewClient, RecordingTransport } from "./index.js";

const QUEUED_EVENTS = 6;

const client = LogBrewClient.create({
  apiKey: "LOGBREW_API_KEY",
  sdkName: "logbrew-js",
  sdkVersion: "0.1.0"
});

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

process.stdout.write(`${client.previewJson()}\n`);

const transport = RecordingTransport.alwaysAccept();
const response = await client.shutdown(transport);
process.stderr.write(`${JSON.stringify({
  ok: true,

  status: response.statusCode,

  attempts: response.attempts,

  events: QUEUED_EVENTS
})}\n`);
