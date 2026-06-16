import { RecordingTransport } from "@logbrew/sdk";
import {
  createLogBrewReactNativeClient,
  createReactNativeTraceContext
} from "@logbrew/react-native";
import { createAppStateLifecycleSpanListener } from "@logbrew/react-native/lifecycle";

const platform = {
  OS: "ios",
  Version: "18.0",
  isPad: false,
  constants: { isTesting: true }
};
const listeners = new Set();
const appState = {
  currentState: "active",
  addEventListener(type, listener) {
    if (type !== "change") {
      throw new Error(`unexpected listener type: ${type}`);
    }
    listeners.add(listener);
    return {
      remove() {
        listeners.delete(listener);
      }
    };
  }
};
const client = createLogBrewReactNativeClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "logbrew-react-native-lifecycle-spans",
  sdkVersion: "0.1.0",
  maxRetries: 1
});
const trace = createReactNativeTraceContext({
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  spanId: "c2ad6b7169204442"
});
const timestamps = [
  "2026-06-02T10:30:00Z",
  "2026-06-02T10:30:01Z",
  "2026-06-02T10:30:02Z",
  "2026-06-02T10:30:03Z"
];
const timeMs = [1000, 1120, 1400, 1415];

const stopLifecycle = createAppStateLifecycleSpanListener(client, appState, {
  captureInitialState: true,
  metadata: { flow: "checkout", nested: { dropped: true } },
  now: () => timestamps.shift(),
  nowMs: () => timeMs.shift(),
  platform,
  screen: "Checkout",
  sessionId: "session_mobile_001",
  trace
});

emitAppState("inactive");
emitAppState("background");
emitAppState("active");
stopLifecycle();
emitAppState("background");

const events = JSON.parse(client.previewJson()).events;
if (events.length !== 4) {
  throw new Error(`expected four lifecycle spans, got ${events.length}`);
}
for (const event of events) {
  if (event.type !== "span") {
    throw new Error(`expected span event, got ${event.type}`);
  }
  const metadata = event.attributes.metadata ?? {};
  if (event.attributes.traceId !== trace.traceId || metadata.traceId !== trace.traceId) {
    throw new Error(`lifecycle span should share trace: ${JSON.stringify(event)}`);
  }
  if (metadata.source !== "react-native.lifecycle" || metadata.screen !== "Checkout") {
    throw new Error(`unexpected lifecycle metadata: ${JSON.stringify(metadata)}`);
  }
  if (metadata.nested !== undefined) {
    throw new Error("nested lifecycle metadata should be dropped");
  }
}
const initial = events[0].attributes;
if (initial.name !== "app_state:active" || initial.metadata.toAppState !== "active") {
  throw new Error(`unexpected initial lifecycle span: ${JSON.stringify(initial)}`);
}
const inactive = events[1].attributes;
if (
  inactive.name !== "app_state:active->inactive" ||
  inactive.durationMs !== 120 ||
  inactive.metadata.fromAppState !== "active" ||
  inactive.metadata.toAppState !== "inactive"
) {
  throw new Error(`unexpected inactive lifecycle span: ${JSON.stringify(inactive)}`);
}
const background = events[2].attributes;
if (
  background.name !== "app_state:inactive->background" ||
  background.durationMs !== 280 ||
  background.metadata.appState !== "background"
) {
  throw new Error(`unexpected background lifecycle span: ${JSON.stringify(background)}`);
}
const foreground = events[3].attributes;
if (
  foreground.name !== "app_state:background->active" ||
  foreground.durationMs !== 15 ||
  foreground.metadata.appState !== "active"
) {
  throw new Error(`unexpected foreground lifecycle span: ${JSON.stringify(foreground)}`);
}

const preview = client.previewJson();
const response = await client.shutdown(RecordingTransport.alwaysAccept());
console.log(preview);
console.error(JSON.stringify({
  ok: true,
  events: events.length,
  status: response.statusCode,
  inactiveSpan: inactive.name,
  backgroundSpan: background.name,
  listenerRemoved: listeners.size === 0,
  traceId: trace.traceId
}));

function emitAppState(state) {
  appState.currentState = state;
  for (const listener of Array.from(listeners)) {
    listener(state);
  }
}
