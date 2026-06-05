import { createServer } from "node:http";
import { once } from "node:events";
import { RecordingTransport } from "@logbrew/sdk";
import {
  createHttpRequestEvent,
  createLogBrewNodeClient,
  withLogBrewHttpHandler
} from "@logbrew/node";

const transport = RecordingTransport.alwaysAccept();
const client = createLogBrewNodeClient({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "node-readme-example",
  sdkVersion: "0.1.0"
});

const server = createServer(withLogBrewHttpHandler((req, res, logbrew) => {
  addFullBatch(logbrew.client);
  const event = createHttpRequestEvent(req, res, {
    idFactory: () => "evt_node_request_001",
    now: () => "2026-06-02T10:00:06Z"
  });
  if (event.attributes.metadata.path !== "/readme") {
    throw new Error(`unexpected request event: ${JSON.stringify(event)}`);
  }
  res.end("ok");
}, {
  captureRequests: false,
  client,
  transport
}));

server.listen(0);
await once(server, "listening");
const port = server.address().port;
const response = await fetch(`http://127.0.0.1:${port}/readme`);
if (response.status !== 200) {
  throw new Error(`unexpected status: ${response.status}`);
}
const payload = client.previewJson();
await client.shutdown(transport);
server.close();
await once(server, "close");

console.log(payload);
console.error(JSON.stringify({
  ok: true,
  attempts: transport.sentBodies.length,
  events: JSON.parse(payload).events.length,
  requestHelper: "evt_node_request_001"
}));

function addFullBatch(logbrew) {
  logbrew.release("evt_release_001", "2026-06-02T10:00:00Z", {
    version: "1.2.3",
    commit: "abc123def456",
    notes: "Public release marker"
  });
  logbrew.environment("evt_environment_001", "2026-06-02T10:00:01Z", {
    name: "production",
    region: "global"
  });
  logbrew.issue("evt_issue_001", "2026-06-02T10:00:02Z", {
    title: "Checkout timeout",
    level: "error",
    message: "Request timed out after retry budget"
  });
  logbrew.log("evt_log_001", "2026-06-02T10:00:03Z", {
    message: "worker started",
    level: "info",
    logger: "job-runner"
  });
  logbrew.span("evt_span_001", "2026-06-02T10:00:04Z", {
    name: "GET /health",
    traceId: "trace_001",
    spanId: "span_001",
    status: "ok",
    durationMs: 12.5
  });
  logbrew.action("evt_action_001", "2026-06-02T10:00:05Z", {
    name: "deploy",
    status: "success"
  });
}
