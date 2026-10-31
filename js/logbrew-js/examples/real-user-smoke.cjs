const { LogBrewClient, RecordingTransport, createTraceContextHeaders, createTraceparentHeaders } = require("../index.cjs");
const { inspect } = require("node:util");
const process = require("node:process");

const QUEUED_EVENTS = 6;

const outgoingHeaders = createTraceparentHeaders({
  spanId: "b7ad6b7169203331",
  traceFlags: "01",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736"
});
if (outgoingHeaders.traceparent !== "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01") {
  throw new Error("createTraceparentHeaders produced an unexpected carrier");
}
const outgoingContextHeaders = createTraceContextHeaders({
  baggage: [{ key: "release", value: "checkout@1.2.3" }],
  spanId: "b7ad6b7169203331",
  traceFlags: "01",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  tracestate: [{ key: "rojo", value: "00f067aa0ba902b7" }]
});
if (
  outgoingContextHeaders.traceparent !== outgoingHeaders.traceparent
  || outgoingContextHeaders.tracestate !== "rojo=00f067aa0ba902b7"
  || outgoingContextHeaders.baggage !== "release=checkout%401.2.3"
) {
  throw new Error("createTraceContextHeaders produced an unexpected carrier");
}

const client = LogBrewClient.create({
  apiKey: "LOGBREW_API_KEY",
  sdkName: "smoke-app-cjs",
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

/**
 * @returns {Promise<void>}
 */
async function deliver() {
  try {
    const transport = RecordingTransport.alwaysAccept();
    const response = await client.shutdown(transport);
    process.stderr.write(`${JSON.stringify({
      ok: true,

      status: response.statusCode,

      attempts: response.attempts,

      events: QUEUED_EVENTS
    })}\n`);
  } catch (error) {
    process.stderr.write(`${inspect(error)}\n`);
    process.exitCode = 1;
  }
}

void deliver();
