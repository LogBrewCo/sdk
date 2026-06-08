import { RecordingTransport } from "@logbrew/sdk";
import {
  captureReactNativeAction,
  captureReactNativeError,
  captureReactNativeNetwork,
  captureScreenView,
  createAppStateListener,
  createLogBrewReactNativeClient,
  createReactNativeTraceparent,
  createTraceparentFetch,
  shouldPropagateTraceparent
} from "@logbrew/react-native";

const fakePlatform = {
  OS: "android",
  Version: 35,
  isPad: false,
  constants: { isTesting: true }
};
let appStateListener = null;
const fakeAppState = {
  currentState: "active",
  addEventListener(_type, listener) {
    appStateListener = listener;
    return {
      remove() {
        appStateListener = null;
      }
    };
  }
};

const client = createLogBrewReactNativeClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "logbrew-react-native-real-user-smoke",
  sdkVersion: "0.1.0",
  maxRetries: 1
});

addCoreEvents(client);
captureScreenView(client, "Checkout", {
  id: "evt_action_001",
  timestamp: "2026-06-02T10:00:05Z",
  platform: fakePlatform,
  appState: fakeAppState,
  metadata: { flow: "checkout" }
});
const stopListening = createAppStateListener(client, fakeAppState, {
  id: "evt_action_app_state_background",
  timestamp: "2026-06-02T10:00:06Z",
  platform: fakePlatform
});
appStateListener("background");
stopListening();
const handledError = new Error("Checkout failed on device");
captureReactNativeError(client, handledError, {
  id: "evt_issue_react_native_error",
  timestamp: "2026-06-02T10:00:07Z",
  platform: fakePlatform,
  appState: fakeAppState,
  screen: "Checkout",
  metadata: { flow: "checkout", handled: true }
});

const propagatedRequests = [];
const tracedFetch = createTraceparentFetch({
  fetchImpl: async (input, init = {}) => {
    propagatedRequests.push({ input, init });
    return { status: 204 };
  },
  traceparentFactory: () => createReactNativeTraceparent({
    randomValues: deterministicBytes
  }),
  tracePropagationTargets: ["https://api.example.test/", /^\/mobile-api\//u]
});
if (!shouldPropagateTraceparent("https://api.example.test/checkout", ["https://api.example.test/"])) {
  throw new Error("expected API request to match trace propagation target");
}
if (shouldPropagateTraceparent("https://cdn.example.test/app.js", ["https://api.example.test/"])) {
  throw new Error("expected CDN request not to match trace propagation target");
}
await tracedFetch("https://api.example.test/checkout", {
  headers: { accept: "application/json", traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01" }
});
await tracedFetch("https://cdn.example.test/app.js", {
  headers: { accept: "text/javascript" }
});
await tracedFetch("/mobile-api/cart");
const propagatedTraceparent = propagatedRequests[0].init.headers.traceparent;
if (propagatedTraceparent !== "00-0102030405060708090a0b0c0d0e0f10-0102030405060708-01") {
  throw new Error(`unexpected propagated traceparent: ${propagatedTraceparent}`);
}
if (propagatedRequests[0].init.headers.accept !== "application/json") {
  throw new Error("expected traced fetch to preserve existing headers");
}
if (propagatedRequests[1].init.headers?.traceparent !== undefined) {
  throw new Error("unmatched requests should not receive traceparent");
}
if (propagatedRequests[2].init.headers.traceparent !== propagatedTraceparent) {
  throw new Error("relative matched requests should receive traceparent");
}

const timelineClient = createLogBrewReactNativeClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "logbrew-react-native-timeline-smoke",
  sdkVersion: "0.1.0",
  maxRetries: 1
});
captureReactNativeAction(timelineClient, {
  id: "evt_native_action_checkout_submit",
  timestamp: "2026-06-02T10:00:08Z",
  platform: fakePlatform,
  appState: fakeAppState,
  name: "checkout.submit",
  screen: "Checkout",
  sessionId: "session_mobile_001",
  traceId: "trace_mobile_001",
  metadata: {
    funnel: "checkout",
    step: "submit",
    nested: { dropped: true }
  }
});
captureReactNativeNetwork(timelineClient, {
  id: "evt_native_network_checkout",
  timestamp: "2026-06-02T10:00:09Z",
  platform: fakePlatform,
  appState: fakeAppState,
  method: "post",
  routeTemplate: "/api/checkout?email=dev@example.test#pay",
  statusCode: 503,
  durationMs: 241,
  screen: "Checkout",
  sessionId: "session_mobile_001",
  traceId: "trace_mobile_001"
});
const timelineEvents = JSON.parse(timelineClient.previewJson()).events;
if (timelineEvents.length !== 2) {
  throw new Error(`expected two timeline events, got ${timelineEvents.length}`);
}
const timelineAction = timelineEvents[0].attributes;
if (timelineAction.metadata.source !== "react-native.action" || timelineAction.metadata.nested !== undefined) {
  throw new Error(`unexpected action timeline metadata: ${JSON.stringify(timelineAction.metadata)}`);
}
const timelineNetwork = timelineEvents[1].attributes;
if (timelineNetwork.name !== "POST /api/checkout" || timelineNetwork.status !== "failure") {
  throw new Error(`unexpected network timeline event: ${JSON.stringify(timelineNetwork)}`);
}
if (timelineNetwork.metadata.routeTemplate !== "/api/checkout" || timelineNetwork.metadata.method !== "POST") {
  throw new Error(`expected sanitized network metadata: ${JSON.stringify(timelineNetwork.metadata)}`);
}

const preview = client.previewJson();
const transport = new RecordingTransport([{ statusCode: 503 }, { statusCode: 202 }]);
const response = await client.shutdown(transport);
console.log(preview);
console.error(JSON.stringify({
  ok: true,
  status: response.statusCode,
  attempts: response.attempts,
  events: 8,
  listenerRemoved: appStateListener === null,
  timelineEvents: timelineEvents.length,
  networkAction: timelineNetwork.name,
  propagatedTraceparent
}));

function addCoreEvents(client) {
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
}

function deterministicBytes(length) {
  return Uint8Array.from({ length }, (_value, index) => index + 1);
}
