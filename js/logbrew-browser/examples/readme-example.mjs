import { RecordingTransport } from "@logbrew/sdk";
import { installLogBrewBrowser } from "@logbrew/browser";

const transport = RecordingTransport.alwaysAccept();
const browserWindow = createExampleWindow("https://app.example.test/dashboard?email=dev@example.test#section");
const logbrew = installLogBrewBrowser({
  clientKey: "LOGBREW_BROWSER_KEY",
  browserWindow,
  capturePageViews: false,
  flushOnCapture: false,
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

const payload = logbrew.previewJson();
const response = await logbrew.flush();
console.log(payload);
console.error(JSON.stringify({
  ok: response.statusCode === 202,
  attempts: response.attempts,
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
