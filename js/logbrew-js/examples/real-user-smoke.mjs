const sdk = await import("@logbrew/sdk").catch(async (error) => {
  if (error && error.code === "ERR_MODULE_NOT_FOUND") {
    return import("../index.js");
  }
  throw error;
});

const { createTraceContextHeaders, createTraceparentHeaders, LogBrewClient, RecordingTransport } = sdk;

const outgoingHeaders = createTraceparentHeaders({
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "b7ad6b7169203331",
  traceFlags: "01"
});
if (outgoingHeaders.traceparent !== "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01") {
  throw new Error("createTraceparentHeaders produced an unexpected carrier");
}
const outgoingContextHeaders = createTraceContextHeaders({
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "b7ad6b7169203331",
  traceFlags: "01",
  tracestate: [{ key: "rojo", value: "00f067aa0ba902b7" }],
  baggage: [{ key: "release", value: "checkout@1.2.3" }]
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
  sdkName: "smoke-app",
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
const response = await client.shutdown(transport);
console.error(JSON.stringify({ ok: true, status: response.statusCode, attempts: response.attempts, events: 6 }));
