import { createServer } from "node:http";
import { once } from "node:events";
import {
  createNetworkMilestoneAttributes,
  createProductActionAttributes,
  createTraceparentHeaders,
  parseTraceparent,
  RecordingTransport
} from "@logbrew/sdk";
import {
  createLogBrewNodeClient,
  withLogBrewHttpHandler
} from "@logbrew/node";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const inboundHeaders = createTraceparentHeaders({
  traceId,
  spanId: "00f067aa0ba902b7"
});
const routeTemplate = "/checkout/:cartId";
const transport = RecordingTransport.alwaysAccept();
const startupClient = createLogBrewNodeClient({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "checkout-api",
  sdkVersion: "1.4.0"
});

startupClient.release("evt_release_checkout_api", "2026-06-15T08:00:00Z", {
  version: "1.4.0",
  commit: "abc123def456",
  metadata: {
    service: "checkout-api"
  }
});
startupClient.environment("evt_environment_checkout_api", "2026-06-15T08:00:01Z", {
  name: "production",
  region: "us-east-1"
});
await startupClient.flush(transport);

let monotonicMs = 0;
const server = createServer(withLogBrewHttpHandler((req, res, logbrew) => {
  const requestTraceId = traceIdFromRequest(req);
  logbrew.client.log("evt_log_checkout_received", "2026-06-15T08:00:02Z", {
    message: "checkout request accepted",
    level: "info",
    logger: "checkout-api",
    metadata: {
      method: "POST",
      routeTemplate,
      traceId: requestTraceId
    }
  });
  logbrew.client.action(
    "evt_action_checkout_started",
    "2026-06-15T08:00:03Z",
    createProductActionAttributes({
      name: "checkout started",
      status: "running",
      sessionId: "sess_checkout_123",
      traceId: requestTraceId,
      routeTemplate,
      funnel: "checkout",
      step: "payment"
    })
  );
  logbrew.client.action(
    "evt_network_payment_authorized",
    "2026-06-15T08:00:04Z",
    createNetworkMilestoneAttributes({
      routeTemplate: "/payments/:paymentId",
      method: "POST",
      status: "success",
      statusCode: 202,
      durationMs: 43,
      sessionId: "sess_checkout_123",
      traceId: requestTraceId
    })
  );
  logbrew.client.metric("evt_metric_checkout_duration", "2026-06-15T08:00:05Z", {
    name: "checkout.duration",
    kind: "histogram",
    value: 128,
    unit: "ms",
    temporality: "delta",
    metadata: {
      routeTemplate,
      traceId: requestTraceId
    }
  });
  res.statusCode = 202;
  res.end("accepted");
}, {
  idFactory: () => "evt_span_checkout_request",
  now: () => "2026-06-15T08:00:06Z",
  nowMs: () => {
    monotonicMs += 17;
    return monotonicMs;
  },
  sdkName: "checkout-api",
  sdkVersion: "1.4.0",
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  spanIdFactory: () => "b7ad6b7169203331",
  transport
}));

server.listen(0);
await once(server, "listening");
const port = server.address().port;
const response = await fetch(`http://127.0.0.1:${port}/checkout/123?coupon=summer`, {
  headers: inboundHeaders,
  method: "POST"
});
if (response.status !== 202) {
  throw new Error(`unexpected checkout status: ${response.status}`);
}
await waitFor(() => transport.sentBodies.length === 2);
await closeServer(server);

const batches = transport.sentBodies.map((body) => JSON.parse(body));
const payload = {
  sdk: batches[0].sdk,
  events: batches.flatMap((batch) => batch.events)
};
const eventIds = payload.events.map((event) => event.id);
if (eventIds.length !== 7) {
  throw new Error(`unexpected event count: ${eventIds.join(",")}`);
}
const requestSpan = payload.events.find((event) => event.id === "evt_span_checkout_request");
if (!requestSpan || requestSpan.type !== "span") {
  throw new Error(`missing request span: ${JSON.stringify(payload)}`);
}
if (requestSpan.attributes.traceId !== traceId || requestSpan.attributes.parentSpanId !== "00f067aa0ba902b7") {
  throw new Error(`unexpected trace context: ${JSON.stringify(requestSpan)}`);
}
if (requestSpan.attributes.metadata.path !== "/checkout/123") {
  throw new Error(`request path should omit query text: ${JSON.stringify(requestSpan)}`);
}
const networkEvent = payload.events.find((event) => event.id === "evt_network_payment_authorized");
if (networkEvent?.attributes.metadata.routeTemplate !== "/payments/:paymentId") {
  throw new Error(`missing network milestone route template: ${JSON.stringify(networkEvent)}`);
}

console.log(JSON.stringify(payload, null, 2));
console.error(JSON.stringify({
  ok: true,
  events: eventIds.length,
  requestSpan: requestSpan.attributes.name,
  networkMilestone: networkEvent.attributes.name,
  traceId: requestSpan.attributes.traceId
}));

function traceIdFromRequest(req) {
  const value = req.headers.traceparent;
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    return parseTraceparent(value).traceId;
  } catch {
    return undefined;
  }
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error("timed out waiting for Node.js telemetry");
}

async function closeServer(serverToClose) {
  await new Promise((resolve, reject) => {
    serverToClose.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
