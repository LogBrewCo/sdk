import { createIssueAttributesFromError, installLogBrewConsoleCapture, LogBrewClient } from "@logbrew/sdk";

const endpoint = process.env.LOGBREW_CAPTURE_ENDPOINT;
const transport = {
  async send(apiKey, body) {
    const response = await fetch(endpoint, { method: "POST", headers: { authorization: apiKey, "content-type": "application/json" }, body });
    return { statusCode: response.status, body: await response.text() };
  }
};
const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const client = LogBrewClient.create({
  apiKey: "LOGBREW_API_KEY",
  sdkName: "checkout-worker",
  sdkVersion: "1.2.3",
  context: {
    schemaVersion: 1,
    resource: { service: { name: "checkout-worker" }, deployment: { environment: "production", release: "checkout@1.2.3" } },
    subject: { kind: "user", id: "user_123" },
    session: { id: "sess_123" },
    trace: { traceId, spanId: "00f067aa0ba902b7" }
  }
});
const capture = installLogBrewConsoleCapture({ client, console, transport, levels: ["info", "warn", "error"], logger: "console" });
console.info("checkout started");
client.span("evt_span_001", new Date().toISOString(), { name: "checkout", traceId, spanId: "00f067aa0ba902b7", status: "error", durationMs: 12 });
client.metric("evt_metric_001", new Date().toISOString(), { name: "checkout.duration", kind: "histogram", temporality: "delta", value: 12, unit: "ms" });
try {
  throw new Error("payment declined");
} catch (error) {
  client.issue("evt_issue_001", new Date().toISOString(), createIssueAttributesFromError(error));
}
await capture.flush();
capture.uninstall();
await client.shutdown(transport);
