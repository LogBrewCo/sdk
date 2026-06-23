import { RecordingTransport } from "@logbrew/sdk";
import {
  createLogBrewReactNativeClient,
  createReactNativeTraceContext
} from "@logbrew/react-native";
import { createLogBrewReactNativeInstrumentation } from "@logbrew/react-native/instrumentation";

const platform = {
  OS: "ios",
  Version: "18.5",
  isPad: false,
  constants: { isTesting: true }
};
const appStateListeners = new Set();
const appState = {
  currentState: "active",
  addEventListener(_type, listener) {
    appStateListeners.add(listener);
    return {
      remove() {
        appStateListeners.delete(listener);
      }
    };
  }
};
const navigationListeners = new Map();
const navigation = {
  route: { key: "Checkout-abc123", name: "Checkout", path: "/checkout?email=dev@example.test" },
  addListener(name, listener) {
    navigationListeners.set(name, listener);
    return {
      remove() {
        navigationListeners.delete(name);
      }
    };
  },
  getCurrentRoute() {
    return this.route;
  }
};
const nativeBridgeCalls = [];
const nativeBridge = {
  setLogBrewScope(scope) {
    nativeBridgeCalls.push({ kind: "set", scope });
  },
  clearLogBrewScope() {
    nativeBridgeCalls.push({ kind: "clear" });
  }
};
const requests = [];
const globalObject = {
  async fetch(input, init = {}) {
    requests.push({ input, init, source: "global" });
    return { status: 206 };
  }
};
const originalGlobalFetch = globalObject.fetch;
const client = createLogBrewReactNativeClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "logbrew-react-native-instrumentation-kit",
  sdkVersion: "0.1.0",
  maxRetries: 1
});
const trace = createReactNativeTraceContext({
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  spanId: "e2ad6b7169206664"
});
const timestamps = [
  "2026-06-02T10:40:00Z",
  "2026-06-02T10:40:01Z",
  "2026-06-02T10:40:02Z",
  "2026-06-02T10:40:03Z",
  "2026-06-02T10:40:04Z",
  "2026-06-02T10:40:05Z"
];
const times = [1000, 1125, 1300, 1380, 1600, 1775, 1900, 1945];

const instrumentation = createLogBrewReactNativeInstrumentation(client, {
  appState,
  captureInitialLifecycleState: true,
  captureInitialNavigationRoute: true,
  fetchImpl: async (input, init = {}) => {
    requests.push({ input, init, source: "resourceFetch" });
    return { status: 202 };
  },
  globalObject,
  instrumentGlobalFetch: true,
  logger: "NativeCheckout",
  metadata: { flow: "checkout", nested: { dropped: true }, traceId: "spoofed" },
  nativeBridge,
  navigationContainer: navigation,
  now: () => timestamps.shift(),
  nowMs: () => times.shift(),
  platform,
  screen: "Checkout",
  sessionId: "session_mobile_001",
  trace,
  tracePropagationTargets: ["https://api.example.test/"]
});

await instrumentation.withNativeBridgeScope(async (scope) => {
  client.log("evt_instrumentation_native_bridge", "2026-06-02T10:40:02Z", {
    message: "native bridge work started",
    level: "info",
    logger: "NativeCheckout",
    metadata: {
      ...scope.metadata,
      ...scope.trace
    }
  });
});

await instrumentation.resourceFetch("https://api.example.test/api/checkout?email=dev@example.test#pay", {
  method: "POST",
  headers: { accept: "application/json" }
});

navigationListeners.get("__unsafe_action__")?.({ data: { action: { type: "NAVIGATE" } } });
navigation.route = {
  key: "CheckoutComplete-def456",
  name: "CheckoutComplete",
  path: "/checkout/complete?email=dev@example.test#done"
};
navigationListeners.get("state")?.();

appState.currentState = "background";
for (const listener of appStateListeners) {
  listener("background");
}

if (globalObject.fetch === originalGlobalFetch) {
  throw new Error("instrumentGlobalFetch should patch the supplied global object");
}
await globalObject.fetch("https://api.example.test/api/global?email=dev@example.test#pay", {
  method: "GET"
});

instrumentation.remove();
navigation.route = { key: "Ignored-ghi789", name: "Ignored", path: "/ignored" };
navigationListeners.get("state")?.();
for (const listener of appStateListeners) {
  listener("active");
}
instrumentation.stop();
if (globalObject.fetch !== originalGlobalFetch) {
  throw new Error("instrumentation remove should put global fetch back");
}

const events = JSON.parse(client.previewJson()).events;
if (events.length !== 7) {
  throw new Error(`expected seven instrumentation events, got ${events.length}`);
}
if (requests[0].init.headers.traceparent !== `00-${trace.traceId}-${trace.spanId}-01`) {
  throw new Error(`expected propagated traceparent, got ${requests[0].init.headers.traceparent}`);
}
if (requests[1].init.headers.traceparent !== `00-${trace.traceId}-${trace.spanId}-01`) {
  throw new Error(`expected global fetch traceparent, got ${requests[1].init.headers.traceparent}`);
}
if (appStateListeners.size !== 0 || navigationListeners.size !== 0) {
  throw new Error("instrumentation remove should detach lifecycle and navigation listeners");
}
if (nativeBridgeCalls.map((call) => call.kind).join(",") !== "set,set,clear,clear") {
  throw new Error(`unexpected native bridge calls: ${JSON.stringify(nativeBridgeCalls)}`);
}
for (const event of events) {
  const metadata = event.attributes.metadata ?? {};
  if (event.type !== "span" && event.type !== "log") {
    throw new Error(`unexpected instrumentation event type: ${event.type}`);
  }
  if (metadata.traceId !== trace.traceId || metadata.spanId !== trace.spanId) {
    throw new Error(`instrumentation event should share trace metadata: ${JSON.stringify(event)}`);
  }
  if (metadata.nested !== undefined) {
    throw new Error(`nested metadata should be dropped: ${JSON.stringify(metadata)}`);
  }
}
const sources = events.map((event) => event.attributes.metadata?.source);
if (!sources.includes("react-native.lifecycle") || !sources.includes("react-native.navigation")) {
  throw new Error(`expected lifecycle and navigation sources: ${JSON.stringify(sources)}`);
}
if (!sources.includes("react-native.resource") || !sources.includes("react-native.instrumentation")) {
  throw new Error(`expected resource and instrumentation sources: ${JSON.stringify(sources)}`);
}
const resource = events.find((event) => event.attributes.metadata?.source === "react-native.resource")?.attributes;
if (resource?.name !== "POST /api/checkout" || resource.metadata.routeTemplate !== "/api/checkout") {
  throw new Error(`unexpected resource span: ${JSON.stringify(resource)}`);
}
const globalResource = events.find((event) => event.attributes.name === "GET /api/global")?.attributes;
if (globalResource?.metadata.routeTemplate !== "/api/global" || globalResource.metadata.statusCode !== 206) {
  throw new Error(`unexpected global fetch span: ${JSON.stringify(globalResource)}`);
}
const navigationSpan = events.find((event) => event.attributes.name === "navigation:CheckoutComplete")?.attributes;
if (navigationSpan?.durationMs !== 220 || navigationSpan.metadata.routePath !== "/checkout/complete") {
  throw new Error(`unexpected navigation span: ${JSON.stringify(navigationSpan)}`);
}
const lifecycleSpan = events.find((event) => event.attributes.name === "app_state:active->background")?.attributes;
if (lifecycleSpan?.durationMs !== 775 || lifecycleSpan.metadata.toAppState !== "background") {
  throw new Error(`unexpected lifecycle span: ${JSON.stringify(lifecycleSpan)}`);
}

const preview = client.previewJson();
const response = await client.shutdown(RecordingTransport.alwaysAccept());
console.log(preview);
console.error(JSON.stringify({
  ok: true,
  calls: nativeBridgeCalls.map((call) => call.kind),
  events: events.length,
  globalFetchPutBack: globalObject.fetch === originalGlobalFetch,
  propagatedTraceparent: requests[0].init.headers.traceparent,
  status: response.statusCode,
  traceId: trace.traceId
}));
