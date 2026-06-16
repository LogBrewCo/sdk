import { RecordingTransport } from "@logbrew/sdk";
import {
  captureReactNativeAction,
  captureReactNativeError,
  captureReactNativeNetwork,
  captureScreenView,
  createLogBrewReactNativeClient,
  createReactNativeSpanAttributes,
  createReactNativeTraceContext,
  createTraceparentFetch,
  getActiveLogBrewTrace,
  withLogBrewTrace
} from "@logbrew/react-native";

const platform = {
  OS: "ios",
  Version: "18.0",
  isPad: false,
  constants: { isTesting: true }
};
const appState = { currentState: "active" };
const client = createLogBrewReactNativeClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "logbrew-react-native-trace-correlation",
  sdkVersion: "0.1.0",
  maxRetries: 1
});

const trace = createReactNativeTraceContext({
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  spanId: "b7ad6b7169203331"
});
const requests = [];
let tracedFetchPromise;

withLogBrewTrace(trace, (activeTrace) => {
  captureScreenView(client, "Checkout", {
    id: "evt_trace_screen_checkout",
    timestamp: "2026-06-02T10:10:00Z",
    platform,
    appState,
    metadata: { traceId: "spoofed_trace_id", flow: "checkout" }
  });
  captureReactNativeAction(client, {
    id: "evt_trace_action_submit",
    timestamp: "2026-06-02T10:10:01Z",
    platform,
    appState,
    name: "checkout.submit",
    screen: "Checkout"
  });
  captureReactNativeNetwork(client, {
    id: "evt_trace_network_checkout",
    timestamp: "2026-06-02T10:10:02Z",
    platform,
    appState,
    method: "post",
    routeTemplate: "/api/checkout?email=dev@example.test",
    statusCode: 202,
    durationMs: 128,
    screen: "Checkout"
  });
  captureReactNativeError(client, new Error("Checkout failed on device"), {
    id: "evt_trace_error_checkout",
    timestamp: "2026-06-02T10:10:03Z",
    platform,
    appState,
    screen: "Checkout"
  });
  client.span("evt_trace_span_checkout", "2026-06-02T10:10:04Z", createReactNativeSpanAttributes({
    name: "mobile.checkout",
    status: "ok",
    durationMs: 132.5,
    trace: activeTrace,
    metadata: { screen: "Checkout" }
  }));

  const tracedFetch = createTraceparentFetch({
    fetchImpl: async (input, init = {}) => {
      requests.push({ input, init });
      return { status: 204 };
    },
    tracePropagationTargets: ["https://api.example.test/"]
  });
  tracedFetchPromise = tracedFetch("https://api.example.test/checkout", {
    headers: { accept: "application/json" }
  });
});
await tracedFetchPromise;

const events = JSON.parse(client.previewJson()).events;
const propagatedTraceparent = requests[0]?.init?.headers?.traceparent;
if (getActiveLogBrewTrace() !== undefined) {
  throw new Error("active trace should be cleared after scope");
}
if (events.length !== 5) {
  throw new Error(`expected five trace-correlated events, got ${events.length}`);
}
for (const event of events) {
  const metadata = event.attributes.metadata ?? {};
  if (event.type === "span") {
    if (event.attributes.traceId !== trace.traceId || event.attributes.spanId !== trace.spanId) {
      throw new Error(`span was not correlated: ${JSON.stringify(event.attributes)}`);
    }
    continue;
  }
  if (metadata.traceId !== trace.traceId || metadata.spanId !== trace.spanId || metadata.parentSpanId !== trace.parentSpanId) {
    throw new Error(`event was not trace-correlated: ${JSON.stringify(event)}`);
  }
}
if (events[0].attributes.metadata.traceId === "spoofed_trace_id") {
  throw new Error("active trace metadata should overwrite spoofed trace keys");
}
if (events[2].attributes.metadata.routeTemplate !== "/api/checkout") {
  throw new Error("network route metadata should strip query text");
}
if (events[3].attributes.metadata.errorStack !== undefined) {
  throw new Error("React Native error stack should remain opt-in");
}
if (propagatedTraceparent !== "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01") {
  throw new Error(`unexpected outgoing traceparent: ${propagatedTraceparent}`);
}

const preview = client.previewJson();
const response = await client.shutdown(RecordingTransport.alwaysAccept());
console.log(preview);
console.error(JSON.stringify({
  ok: true,
  events: events.length,
  status: response.statusCode,
  traceId: trace.traceId,
  spanId: trace.spanId,
  parentSpanId: trace.parentSpanId,
  propagatedTraceparent
}));
