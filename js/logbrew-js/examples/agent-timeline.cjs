const {
  LogBrewClient,
  RecordingTransport,
  createNetworkMilestoneAttributes,
  createProductActionAttributes,
  createTraceparentHeaders
} = require("../index.cjs");
const { inspect } = require("node:util");
const process = require("node:process");

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const spanId = "b7ad6b7169203331";
const sessionId = "sess_checkout_001";
const timestamp = "2026-06-02T10:00:00Z";
const RETAINED_EVENTS = 2;

const client = LogBrewClient.create({
  apiKey: "LOGBREW_API_KEY",
  eventFilter(event) {
    return !(event.type === "log" && event.attributes.level === "info");
  },
  sdkName: "checkout-agent-timeline",
  sdkVersion: "1.0.0"
});

client.action("evt_checkout_started", timestamp, createProductActionAttributes({
  funnel: "checkout",
  metadata: {
    service: "checkout",

    plan: "pro"
  },
  name: "checkout.started",
  routeTemplate: "/checkout/:step?coupon=private#payment",
  sessionId,
  status: "success",
  step: "start",
  traceId
}));

client.action("evt_payment_api", "2026-06-02T10:00:01Z", createNetworkMilestoneAttributes({
  durationMs: 241.5,
  metadata: {
    service: "payments",

    retryable: true
  },
  method: "POST",
  routeTemplate: "https://api.example.invalid/payments/123?card=private#retry",
  sessionId,
  statusCode: 503,
  traceId
}));

client.log("evt_debug_noise", "2026-06-02T10:00:02Z", {
  level: "info",
  logger: "checkout",
  message: "debug heartbeat"
});

const headers = createTraceparentHeaders({
  spanId,
  traceFlags: "01",
  traceId
});

const preview = client.previewJson();
if (preview.includes("card=private") || preview.includes("coupon=private") || preview.includes("#payment")) {
  throw new Error("agent timeline leaked query or hash metadata");
}
if (client.pendingEvents() !== RETAINED_EVENTS) {
  throw new Error(`expected two retained timeline events, got ${String(client.pendingEvents())}`);
}

process.stdout.write(`${preview}\n`);

/**
 * @returns {Promise<void>}
 */
async function deliver() {
  try {
    const response = await client.shutdown(RecordingTransport.alwaysAccept());
    process.stderr.write(`${JSON.stringify({
      ok: true,

      events: RETAINED_EVENTS,

      traceparent: headers.traceparent,

      status: response.statusCode
    })}\n`);
  } catch (error) {
    process.stderr.write(`${inspect(error)}\n`);
    process.exitCode = 1;
  }
}

void deliver();
