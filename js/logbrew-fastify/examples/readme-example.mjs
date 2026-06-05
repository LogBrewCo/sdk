import Fastify from "fastify";
import { RecordingTransport } from "@logbrew/sdk";
import { logbrewFastifyPlugin } from "@logbrew/fastify";

const transport = RecordingTransport.alwaysAccept();
const app = Fastify();

await app.register(logbrewFastifyPlugin, {
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  captureRequests: false,
  transport
});

app.get("/logbrew", async (request) => {
  addFullBatch(request.logbrew.client);
  const payload = request.logbrew.previewJson();
  await request.logbrew.shutdown();
  return JSON.parse(payload);
});

const address = await app.listen({ host: "127.0.0.1", port: 0 });
const response = await fetch(`${address}/logbrew`);
const payload = await response.text();
await app.close();

console.log(payload);
console.error(JSON.stringify({
  ok: true,
  attempts: transport.sentBodies.length,
  status: response.status
}));

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
