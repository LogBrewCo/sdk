import { RecordingTransport } from "@logbrew/sdk";
import {
  captureBrowserAction,
  captureBrowserInteractionTiming,
  captureBrowserNetwork,
  captureBrowserWebVital,
  createBrowserTraceContext,
  installLogBrewBrowser
} from "@logbrew/browser";

const transport = RecordingTransport.alwaysAccept();
const browserWindow = createExampleWindow("https://app.example.test/dashboard?email=dev@example.test#section");
const traceContext = createBrowserTraceContext({
  spanId: "00f067aa0ba902b7",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736"
});
const logbrew = installLogBrewBrowser({
  clientKey: "LOGBREW_BROWSER_KEY",
  browserWindow,
  capturePageViews: false,
  flushOnCapture: false,
  traceContext,
  transport
});

logbrew.client.log("evt_log_001", "2026-06-02T10:00:00Z", {
  message: "browser app started",
  level: "info",
  logger: "browser",
  metadata: {
    path: browserWindow.location.pathname
  }
});

await captureBrowserAction({
  name: "checkout.clicked",
  status: "success",
  metadata: {
    funnel: "checkout",
    routeTemplate: "/dashboard",
    sessionId: "sess_browser_001",
    step: 2
  }
}, logbrew, {
  flushOnCapture: false
});

await captureBrowserNetwork({
  method: "POST",
  routeTemplate: "/api/checkout",
  statusCode: 503,
  durationMs: 842,
  sessionId: "sess_browser_001",
  traceId: traceContext.traceId,
  metadata: {
    funnel: "checkout",
    retryAttempt: 1
  }
}, logbrew, {
  flushOnCapture: false
});

await captureBrowserWebVital({
  name: "LCP",
  rating: "needs-improvement",
  value: 2480.456
}, logbrew, {
  flushOnCapture: false,
  webVitalPathTemplate: "/dashboard"
});

await captureBrowserInteractionTiming({
  duration: 128,
  entryType: "event",
  interactionId: 91,
  name: "click",
  processingEnd: 275,
  processingStart: 220,
  startTime: 200
}, logbrew, {
  flushOnCapture: false,
  interactionPathTemplate: "/dashboard"
});

const payload = logbrew.previewJson();
const response = await logbrew.flush();
console.log(payload);
console.error(JSON.stringify({
  ok: response.statusCode === 202,
  attempts: response.attempts,
  events: JSON.parse(payload).events.length,
  path: JSON.parse(payload).events[0].attributes.metadata.path
}));

function createExampleWindow(href) {
  const listeners = new Map();
  const url = new URL(href);
  return {
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) ?? []) {
        listener(event);
      }
    },
    document: {
      title: "LogBrew Browser Example",
      visibilityState: "visible"
    },
    location: url,
    navigator: {
      userAgent: "LogBrewExample/0.1.0"
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) ?? []).filter((candidate) => candidate !== listener));
    }
  };
}
