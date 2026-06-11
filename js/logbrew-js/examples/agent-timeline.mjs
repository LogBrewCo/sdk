const sdk = await import("@logbrew/sdk").catch(async (error) => {
  if (error && error.code === "ERR_MODULE_NOT_FOUND") {
    return import("../index.js");
  }
  throw error;
});

const {
  createNetworkMilestoneAttributes,
  createProductActionAttributes,
  createTraceparentHeaders,
  LogBrewClient,
  RecordingTransport
} = sdk;

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const spanId = "b7ad6b7169203331";
const sessionId = "sess_checkout_001";
const timestamp = "2026-06-02T10:00:00Z";

const client = LogBrewClient.create({
  apiKey: "LOGBREW_API_KEY",
  sdkName: "checkout-agent-timeline",
  sdkVersion: "1.0.0",
  eventFilter(event) {
    return !(event.type === "log" && event.attributes.level === "info");
  }
});

client.action("evt_checkout_started", timestamp, createProductActionAttributes({
  name: "checkout.started",
  status: "success",
  sessionId,
  traceId,
  routeTemplate: "/checkout/:step?coupon=private#payment",
  funnel: "checkout",
  step: "start",
  metadata: { service: "checkout", plan: "pro" }
}));

client.action("evt_payment_api", "2026-06-02T10:00:01Z", createNetworkMilestoneAttributes({
  routeTemplate: "https://api.example.invalid/payments/123?card=private#retry",
  method: "POST",
  statusCode: 503,
  durationMs: 241.5,
  sessionId,
  traceId,
  metadata: { service: "payments", retryable: true }
}));

client.log("evt_debug_noise", "2026-06-02T10:00:02Z", {
  message: "debug heartbeat",
  level: "info",
  logger: "checkout"
});

const headers = createTraceparentHeaders({
  traceId,
  spanId,
  traceFlags: "01"
});

const preview = client.previewJson();
if (preview.includes("card=private") || preview.includes("coupon=private") || preview.includes("#payment")) {
  throw new Error("agent timeline leaked query or hash metadata");
}
if (client.pendingEvents() !== 2) {
  throw new Error(`expected two retained timeline events, got ${client.pendingEvents()}`);
}

console.log(preview);

const response = await client.shutdown(RecordingTransport.alwaysAccept());
console.error(JSON.stringify({
  ok: true,
  events: 2,
  traceparent: headers.traceparent,
  status: response.statusCode
}));
