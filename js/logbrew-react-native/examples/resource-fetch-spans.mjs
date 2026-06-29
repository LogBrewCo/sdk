import { RecordingTransport } from "@logbrew/sdk";
import {
  createLogBrewReactNativeClient,
  createReactNativeTraceContext
} from "@logbrew/react-native";
import { createReactNativeResourceFetch } from "@logbrew/react-native/resource-fetch";

const platform = {
  OS: "ios",
  Version: "18.5",
  isPad: false,
  constants: { isTesting: true }
};
const appState = { currentState: "active" };
const client = createLogBrewReactNativeClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "logbrew-react-native-resource-fetch-spans",
  sdkVersion: "0.1.0",
  maxRetries: 1
});
const trace = createReactNativeTraceContext({
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  spanId: "c2ad6b7169204442"
});
const requests = [];
const timestamps = [
  "2026-06-02T10:21:00Z",
  "2026-06-02T10:21:01Z"
];
const times = [1000, 1167, 2000, 2031];

const resourceFetch = createReactNativeResourceFetch(client, {
  fetchImpl: async (input, init = {}) => {
    requests.push({ input, init });
    if (String(input).includes("/api/fail")) {
      throw new TypeError("network request failed");
    }
    return { status: 202 };
  },
  metadata: { flow: "checkout", nested: { dropped: true } },
  metadataFactory({ routeTemplate }) {
    if (routeTemplate === "/api/checkout") {
      return {
        graphqlOperationName: "CheckoutSubmit",
        graphqlOperationType: "mutation",
        graphqlVariables: { dropped: true },
        requestBody: "dropped"
      };
    }
    return undefined;
  },
  now: () => timestamps.shift(),
  nowMs: () => times.shift(),
  platform,
  appState,
  screen: "Checkout",
  sessionId: "session_mobile_001",
  trace,
  tracePropagationTargets: ["https://api.example.test/"]
});

await resourceFetch("https://api.example.test/api/checkout?email=dev@example.test", {
  method: "POST",
  headers: { accept: "application/json" }
});
try {
  await resourceFetch("https://cdn.example.test/api/fail?debug=hidden", {
    method: "GET"
  });
} catch (error) {
  if (!(error instanceof TypeError)) {
    throw error;
  }
}

const events = JSON.parse(client.previewJson()).events;
if (events.length !== 2) {
  throw new Error(`expected two resource fetch spans, got ${events.length}`);
}
if (requests[0].init.headers.traceparent !== `00-${trace.traceId}-${trace.spanId}-01`) {
  throw new Error(`expected API request traceparent, got ${requests[0].init.headers.traceparent}`);
}
if (requests[1].init.headers?.traceparent !== undefined) {
  throw new Error("non-target resource fetch should not receive traceparent");
}
const success = events[0].attributes;
if (
  success.name !== "POST /api/checkout" ||
  success.status !== "ok" ||
  success.durationMs !== 167 ||
  success.metadata.routeTemplate !== "/api/checkout" ||
  success.metadata.graphqlOperationName !== "CheckoutSubmit" ||
  success.metadata.graphqlOperationType !== "mutation" ||
  success.metadata.graphqlVariables !== undefined ||
  success.metadata.requestBody !== undefined ||
  success.metadata.traceId !== trace.traceId ||
  success.metadata.nested !== undefined
) {
  throw new Error(`unexpected success resource span: ${JSON.stringify(success)}`);
}
const failure = events[1].attributes;
if (
  failure.name !== "GET /api/fail" ||
  failure.status !== "error" ||
  failure.durationMs !== 31 ||
  failure.metadata.routeTemplate !== "/api/fail" ||
  failure.metadata.fetchErrorName !== "TypeError" ||
  failure.metadata.traceId !== trace.traceId
) {
  throw new Error(`unexpected failed resource span: ${JSON.stringify(failure)}`);
}

const preview = client.previewJson();
const response = await client.shutdown(RecordingTransport.alwaysAccept());
console.log(preview);
console.error(JSON.stringify({
  ok: true,
  events: events.length,
  status: response.statusCode,
  successSpan: success.name,
  failureSpan: failure.name,
  propagatedTraceparent: requests[0].init.headers.traceparent,
  traceId: trace.traceId
}));
