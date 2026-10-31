import { RecordingTransport } from "@logbrew/sdk";
import fastify from "fastify";
import { logbrewFastifyPlugin } from "@logbrew/fastify";

/** @import { LogBrewClient } from "@logbrew/sdk" */

const ANY_PORT = 0;

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

const transport = RecordingTransport.alwaysAccept();
const app = fastify();

await app.register(logbrewFastifyPlugin, {
  captureRequests: false,
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  transport
});

app.get("/logbrew", async (request) => {
  const context = request.logbrew;
  if (!context) {
    throw new Error("the LogBrew Fastify plugin is not registered");
  }
  addFullBatch(context.client);
  const payload = context.previewJson();
  await context.shutdown();
  return JSON.parse(payload);
});

const address = await app.listen({ host: "127.0.0.1", port: ANY_PORT });
const response = await fetch(`${address}/logbrew`);
const payload = await response.text();
await app.close();

process.stdout.write(`${payload}\n`);
process.stderr.write(
  `${JSON.stringify({
    ok: true,

    attempts: transport.sentBodies.length,
    status: response.status
  })}\n`
);
