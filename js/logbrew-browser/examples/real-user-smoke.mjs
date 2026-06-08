import { RecordingTransport } from "@logbrew/sdk";
import {
  captureBrowserAction,
  captureBrowserNetwork,
  createBrowserTraceparent,
  createTraceparentFetch,
  installLogBrewBrowser,
  shouldPropagateTraceparent
} from "@logbrew/browser";

let tick = 0;
const transport = RecordingTransport.alwaysAccept();
const browserWindow = createExampleWindow("https://app.example.test/settings?email=dev@example.test#profile");
const logbrew = installLogBrewBrowser({
  clientKey: "LOGBREW_BROWSER_KEY",
  browserWindow,
  flushOnCapture: false,
  now: nextTimestamp,
  transport
});

browserWindow.dispatchEvent(createErrorEvent("Checkout exploded", "/assets/app.js", 12, 4));
browserWindow.dispatchEvent(createRejectionEvent(new Error("Async checkout failed")));
await captureBrowserAction({
  name: "checkout.clicked",
  status: "success",
  metadata: {
    funnel: "checkout",
    ignoredNested: { email: "dev@example.test" },
    routeTemplate: "/settings",
    sessionId: "sess_browser_001",
    step: 2
  }
}, logbrew, {
  flushOnCapture: false,
  now: nextTimestamp
});
await captureBrowserNetwork({
  method: "POST",
  routeTemplate: "/api/checkout?email=dev@example.test#retry",
  statusCode: 503,
  durationMs: 842,
  sessionId: "sess_browser_001",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  metadata: {
    funnel: "checkout",
    ignoredNested: { value: "nested" },
    retryAttempt: 1
  }
}, logbrew, {
  flushOnCapture: false,
  now: nextTimestamp
});

if (logbrew.client.pendingEvents() !== 5) {
  throw new Error(`expected 5 captured events, got ${logbrew.client.pendingEvents()}`);
}

logbrew.client.log("evt_browser_pagehide_001", nextTimestamp(), {
  message: "queued before pagehide",
  level: "info",
  logger: "browser.lifecycle"
});
browserWindow.dispatchEvent({ type: "pagehide" });
await waitFor(() => transport.sentBodies.length === 1);

logbrew.client.log("evt_browser_hidden_001", nextTimestamp(), {
  message: "queued before hidden visibility",
  level: "info",
  logger: "browser.lifecycle"
});
browserWindow.document.visibilityState = "hidden";
browserWindow.document.dispatchEvent({ type: "visibilitychange" });
await waitFor(() => transport.sentBodies.length === 2);

logbrew.uninstall();
browserWindow.dispatchEvent(createErrorEvent("After uninstall", "/assets/later.js", 2, 1));
browserWindow.dispatchEvent({ type: "pagehide" });
browserWindow.document.dispatchEvent({ type: "visibilitychange" });
await delay(10);
if (transport.sentBodies.length !== 2 || logbrew.client.pendingEvents() !== 0) {
  throw new Error("uninstall should remove browser listeners");
}

const payload = transport.sentBodies[0];
const parsed = JSON.parse(payload);
const paths = parsed.events
  .map((event) => event.attributes.metadata?.path)
  .filter((path) => path !== undefined);
if (paths.some((path) => path !== "/settings")) {
  throw new Error(`expected query/hash-free paths, got ${JSON.stringify(paths)}`);
}
const action = parsed.events.find((event) => event.type === "action");
if (action?.attributes.metadata?.sessionId !== "sess_browser_001") {
  throw new Error(`expected action session metadata, got ${payload}`);
}
if (action.attributes.metadata.ignoredNested !== undefined) {
  throw new Error(`nested action metadata should be dropped: ${payload}`);
}
const network = parsed.events.find((event) => event.type === "action" && event.attributes.metadata?.source === "browser.network");
if (network?.attributes.metadata?.routeTemplate !== "/api/checkout") {
  throw new Error(`expected query-free network route template, got ${payload}`);
}
if (network.attributes.metadata.statusCode !== 503 || network.attributes.status !== "failure") {
  throw new Error(`expected failed network metadata, got ${payload}`);
}
if (network.attributes.metadata.ignoredNested !== undefined) {
  throw new Error(`nested network metadata should be dropped: ${payload}`);
}
const visibilityPayload = JSON.parse(transport.sentBodies[1]);
if (visibilityPayload.events[0].id !== "evt_browser_hidden_001") {
  throw new Error(`expected hidden visibility flush, got ${transport.sentBodies[1]}`);
}

const propagatedRequests = [];
const tracedFetch = createTraceparentFetch({
  fetchImpl: async (input, init = {}) => {
    propagatedRequests.push({ input, init });
    return { status: 204 };
  },
  traceparentFactory: () => createBrowserTraceparent({
    randomValues: deterministicBytes
  }),
  tracePropagationTargets: ["https://api.example.test/", /^\/internal\//u]
});
if (!shouldPropagateTraceparent("https://api.example.test/checkout", ["https://api.example.test/"])) {
  throw new Error("expected API request to match trace propagation target");
}
if (shouldPropagateTraceparent("https://cdn.example.test/app.js", ["https://api.example.test/"])) {
  throw new Error("expected CDN request not to match trace propagation target");
}
await tracedFetch("https://api.example.test/checkout?email=dev@example.test", {
  headers: { accept: "application/json" }
});
await tracedFetch("https://cdn.example.test/app.js", {
  headers: { accept: "text/javascript" }
});
await tracedFetch("/internal/ping");
if (propagatedRequests.length !== 3) {
  throw new Error(`expected three fetch calls, got ${propagatedRequests.length}`);
}
const firstTraceparent = propagatedRequests[0].init.headers.traceparent;
if (firstTraceparent !== "00-0102030405060708090a0b0c0d0e0f10-0102030405060708-01") {
  throw new Error(`unexpected propagated traceparent: ${firstTraceparent}`);
}
if (propagatedRequests[0].init.headers.accept !== "application/json") {
  throw new Error("expected traced fetch to preserve existing headers");
}
if (propagatedRequests[1].init.headers?.traceparent !== undefined) {
  throw new Error("unmatched requests should not receive traceparent");
}
if (propagatedRequests[2].init.headers.traceparent !== firstTraceparent) {
  throw new Error("relative matched requests should receive traceparent");
}

console.log(payload);
console.error(JSON.stringify({
  ok: true,
  events: parsed.events.length,
  hiddenFlushEvents: visibilityPayload.events.length,
  networkAction: network.attributes.metadata.routeTemplate,
  pageView: parsed.events[0].attributes.name,
  pagehideFlushEvents: parsed.events.length,
  propagatedTraceparent: firstTraceparent,
  syncError: parsed.events[1].attributes.title,
  unhandledRejection: parsed.events[2].attributes.title
}));

function nextTimestamp() {
  tick += 1;
  return `2026-06-02T10:00:0${tick}Z`;
}

function createErrorEvent(message, filename, lineno, colno) {
  let prevented = false;
  return {
    colno,
    error: new Error(message),
    filename,
    get defaultPrevented() {
      return prevented;
    },
    lineno,
    message,
    preventDefault() {
      prevented = true;
    },
    type: "error"
  };
}

function createRejectionEvent(reason) {
  let prevented = false;
  return {
    get defaultPrevented() {
      return prevented;
    },
    preventDefault() {
      prevented = true;
    },
    reason,
    type: "unhandledrejection"
  };
}

function createExampleWindow(href) {
  const listeners = new Map();
  const documentListeners = new Map();
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
      addEventListener(type, listener) {
        documentListeners.set(type, [...(documentListeners.get(type) ?? []), listener]);
      },
      dispatchEvent(event) {
        for (const listener of documentListeners.get(event.type) ?? []) {
          listener(event);
        }
      },
      removeEventListener(type, listener) {
        documentListeners.set(type, (documentListeners.get(type) ?? []).filter((candidate) => candidate !== listener));
      },
      title: "LogBrew Browser Smoke",
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

function deterministicBytes(length) {
  return Uint8Array.from({ length }, (_value, index) => index + 1);
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await delay(10);
  }
  throw new Error("timed out waiting for lifecycle flush");
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
