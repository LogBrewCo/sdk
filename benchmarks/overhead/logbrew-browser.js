// LogBrew browser SDK with its transport replaced by an in-memory stub.
import { captureBrowserError, createBrowserTraceContext, installLogBrewBrowser } from "@logbrew/browser";

const bodies = [];
const transport = {
  async send(_key, body) {
    bodies.push(body);
    return { statusCode: 202, attempts: 1 };
  }
};
let logbrew;

globalThis.bench = {
  init() {
    logbrew = installLogBrewBrowser({ clientKey: "LOGBREW_BROWSER_KEY", transport });
  },
  error(error) {
    void captureBrowserError(error, logbrew);
  },
  span(name) {
    const trace = createBrowserTraceContext();
    const start = performance.now();
    logbrew.client.span(crypto.randomUUID(), new Date().toISOString(), {
      name,
      traceId: trace.traceId,
      spanId: trace.spanId,
      status: "ok",
      durationMs: performance.now() - start
    });
  },
  flush: () => logbrew.flush(),
  delivered: (signal) =>
    bodies.reduce((count, body) => count + JSON.parse(body).events.filter((event) => counted(event, signal)).length, 0)
};

// The benchmark's own error events or spans; the initial page view is not counted.
const counted = (event, signal) =>
  signal === "error" ? event.type === "issue" : event.type === "span" && event.attributes.name === "checkout.step";
