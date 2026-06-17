import { RecordingTransport } from "@logbrew/sdk";
import {
  createLogBrewReactNativeClient,
  createReactNativeTraceContext
} from "@logbrew/react-native";
import {
  createLogBrewNativeBridgeScope,
  syncLogBrewNativeBridgeScope,
  withLogBrewNativeBridgeScope
} from "@logbrew/react-native/native-bridge";

const client = createLogBrewReactNativeClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "logbrew-react-native-native-bridge",
  sdkVersion: "0.1.0",
  maxRetries: 1
});
const trace = createReactNativeTraceContext({
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  spanId: "d2ad6b7169205553"
});
const calls = [];
const nativeBridge = {
  currentScope: undefined,
  setLogBrewScope(scope) {
    calls.push({ kind: "set", scope });
    this.currentScope = scope;
  },
  clearLogBrewScope() {
    calls.push({ kind: "clear" });
    this.currentScope = undefined;
  }
};

const previewScope = createLogBrewNativeBridgeScope({
  logger: "NativeCheckout",
  metadata: { routeTemplate: "/native/checkout", nested: { dropped: true }, traceId: "spoofed" },
  screen: "Checkout",
  sessionId: "session_mobile_001",
  trace
});
if (previewScope.trace.traceId !== trace.traceId || previewScope.trace.spanId !== trace.spanId) {
  throw new Error(`unexpected preview trace scope: ${JSON.stringify(previewScope)}`);
}
if (previewScope.metadata.nested !== undefined || previewScope.metadata.traceId !== undefined) {
  throw new Error(`bridge preview metadata should be primitive-only: ${JSON.stringify(previewScope.metadata)}`);
}

const syncedScope = syncLogBrewNativeBridgeScope(nativeBridge, {
  logger: "NativeCheckout",
  metadata: { routeTemplate: "/native/preview" },
  screen: "Checkout",
  trace
});
if (nativeBridge.currentScope?.trace?.traceId !== trace.traceId) {
  throw new Error("native bridge should receive synced trace scope");
}
if (syncedScope.metadata.routeTemplate !== "/native/preview") {
  throw new Error(`unexpected synced scope metadata: ${JSON.stringify(syncedScope.metadata)}`);
}

await withLogBrewNativeBridgeScope(nativeBridge, {
  logger: "NativeCheckout",
  metadata: { routeTemplate: "/native/checkout", nested: { dropped: true } },
  screen: "Checkout",
  sessionId: "session_mobile_001",
  trace
}, async (scope) => {
  if (nativeBridge.currentScope?.trace?.spanId !== trace.spanId) {
    throw new Error("native bridge scope should be active during async callback");
  }
  client.log("evt_native_bridge_scope", "2026-06-02T10:30:00Z", {
    message: "native bridge scope synced",
    level: "info",
    logger: "NativeCheckout",
    metadata: {
      ...scope.metadata,
      ...scope.trace
    }
  });
});
if (nativeBridge.currentScope !== undefined) {
  throw new Error("native bridge scope should be cleared after callback");
}
const events = JSON.parse(client.previewJson()).events;
const event = events[0]?.attributes;
if (
  events.length !== 1 ||
  event.metadata.traceId !== trace.traceId ||
  event.metadata.spanId !== trace.spanId ||
  event.metadata.parentSpanId !== trace.parentSpanId ||
  event.metadata.nested !== undefined
) {
  throw new Error(`unexpected native bridge event: ${JSON.stringify(events)}`);
}

const preview = client.previewJson();
const response = await client.shutdown(RecordingTransport.alwaysAccept());
console.log(preview);
console.error(JSON.stringify({
  ok: true,
  calls: calls.map((call) => call.kind),
  events: events.length,
  status: response.statusCode,
  traceId: trace.traceId,
  spanId: trace.spanId
}));
