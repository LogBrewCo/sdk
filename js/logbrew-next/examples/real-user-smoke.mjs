import { RecordingTransport } from "@logbrew/sdk";
import { withLogBrewRouteHandler } from "@logbrew/next";

const transport = new RecordingTransport([{ statusCode: 503 }, { statusCode: 202 }]);

const POST = withLogBrewRouteHandler(
  async (_request, _context, { client }) => {
    addFullBatch(client);
    return Response.json(JSON.parse(client.previewJson()));
  },
  {
    serverApiKey: "LOGBREW_SERVER_API_KEY",
    captureRequests: false,
    sdkName: "logbrew-next-real-user-smoke",
    sdkVersion: "0.1.0",
    maxRetries: 1,
    transport
  }
);

const response = await POST(new Request("https://example.com/api/logbrew", { method: "POST" }), {});
console.log(await response.text());
console.error(JSON.stringify({ ok: true, status: response.status, attempts: transport.sentBodies.length, events: 6 }));

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
