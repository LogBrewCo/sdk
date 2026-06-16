import { RecordingTransport } from "@logbrew/sdk";
import {
  captureReactNativeResourceSpan,
  createLogBrewReactNativeClient,
  createReactNavigationSpanListener,
  createReactNativeResourceSpanEvent,
  createReactNativeTraceContext,
  withLogBrewTrace
} from "@logbrew/react-native";

const platform = {
  OS: "android",
  Version: "16",
  isPad: false,
  constants: { isTesting: true }
};
const appState = { currentState: "active" };
const client = createLogBrewReactNativeClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "logbrew-react-native-navigation-resource-spans",
  sdkVersion: "0.1.0",
  maxRetries: 1
});
const trace = createReactNativeTraceContext({
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  spanId: "c2ad6b7169204442"
});
const routeListeners = new Map();
const navigation = {
  route: { key: "Checkout-abc123", name: "Checkout", path: "/checkout?email=dev@example.test" },
  addListener(name, listener) {
    routeListeners.set(name, listener);
    return {
      remove() {
        routeListeners.delete(name);
      }
    };
  },
  getCurrentRoute() {
    return this.route;
  }
};
const timestamps = [
  "2026-06-02T10:20:00Z",
  "2026-06-02T10:20:01Z",
  "2026-06-02T10:20:02Z"
];
const timeMs = [1000, 1128, 1171];

withLogBrewTrace(trace, () => {
  const stopNavigation = createReactNavigationSpanListener(client, navigation, {
    captureInitialRoute: true,
    metadata: { flow: "checkout", nested: { dropped: true } },
    now: () => timestamps.shift(),
    nowMs: () => timeMs.shift(),
    platform,
    appState
  });

  routeListeners.get("__unsafe_action__")?.({ data: { action: { type: "NAVIGATE" } } });
  navigation.route = {
    key: "CheckoutComplete-def456",
    name: "CheckoutComplete",
    path: "/checkout/complete?email=dev@example.test#done"
  };
  routeListeners.get("state")?.();
  stopNavigation();

  captureReactNativeResourceSpan(client, {
    id: "evt_resource_checkout_post",
    timestamp: "2026-06-02T10:20:03Z",
    durationMs: 171,
    method: "post",
    routeTemplate: "/api/checkout?email=dev@example.test#pay",
    statusCode: 202,
    responseSizeBytes: 512,
    screen: "CheckoutComplete",
    sessionId: "session_mobile_001",
    platform,
    appState
  });
});

const directResource = createReactNativeResourceSpanEvent({
  id: "evt_resource_checkout_retry",
  timestamp: "2026-06-02T10:20:04Z",
  durationMs: 88,
  method: "get",
  routeTemplate: "/api/cart?itemId=123#items",
  statusCode: 503,
  screen: "Checkout",
  trace
});
client.span(directResource.id, directResource.timestamp, directResource.attributes);

const events = JSON.parse(client.previewJson()).events;
if (events.length !== 4) {
  throw new Error(`expected four span events, got ${events.length}`);
}
for (const event of events) {
  if (event.type !== "span") {
    throw new Error(`expected span event, got ${event.type}`);
  }
  if (event.attributes.traceId !== trace.traceId) {
    throw new Error(`span should share trace: ${JSON.stringify(event)}`);
  }
  const metadata = event.attributes.metadata ?? {};
  if (metadata.traceId !== trace.traceId || metadata.spanId !== trace.spanId) {
    throw new Error(`span metadata should include trace fields: ${JSON.stringify(metadata)}`);
  }
  if (metadata.routeKey !== undefined || metadata.previousRouteKey !== undefined) {
    throw new Error("route keys should be opt-in to avoid high-cardinality defaults");
  }
  if (metadata.nested !== undefined) {
    throw new Error("nested metadata should be dropped");
  }
}
const initialNavigation = events[0].attributes;
if (initialNavigation.name !== "navigation:Checkout" || initialNavigation.metadata.previousRouteName !== undefined) {
  throw new Error(`unexpected initial navigation span: ${JSON.stringify(initialNavigation)}`);
}
const changedNavigation = events[1].attributes;
if (
  changedNavigation.name !== "navigation:CheckoutComplete" ||
  changedNavigation.durationMs !== 128 ||
  changedNavigation.metadata.routePath !== "/checkout/complete" ||
  changedNavigation.metadata.actionType !== "NAVIGATE" ||
  changedNavigation.metadata.previousRouteName !== "Checkout"
) {
  throw new Error(`unexpected route change span: ${JSON.stringify(changedNavigation)}`);
}
const resourceSpan = events[2].attributes;
if (
  resourceSpan.name !== "POST /api/checkout" ||
  resourceSpan.status !== "ok" ||
  resourceSpan.metadata.routeTemplate !== "/api/checkout" ||
  resourceSpan.metadata.responseSizeBytes !== 512
) {
  throw new Error(`unexpected resource span: ${JSON.stringify(resourceSpan)}`);
}
const failedResourceSpan = events[3].attributes;
if (failedResourceSpan.name !== "GET /api/cart" || failedResourceSpan.status !== "error") {
  throw new Error(`unexpected failed resource span: ${JSON.stringify(failedResourceSpan)}`);
}

const preview = client.previewJson();
const response = await client.shutdown(RecordingTransport.alwaysAccept());
console.log(preview);
console.error(JSON.stringify({
  ok: true,
  events: events.length,
  status: response.statusCode,
  navigationSpan: changedNavigation.name,
  resourceSpan: resourceSpan.name,
  traceId: trace.traceId
}));
