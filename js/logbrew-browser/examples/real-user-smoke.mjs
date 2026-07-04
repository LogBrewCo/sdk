import { RecordingTransport } from "@logbrew/sdk";
import {
  captureBrowserAction,
  captureBrowserNavigationTiming,
  captureBrowserNetwork,
  createBrowserTraceContext,
  createLogBrewBrowserFetch,
  createTraceparentFetch,
  installLogBrewBrowser,
  shouldPropagateTraceparent
} from "@logbrew/browser";

let tick = 0;
const transport = RecordingTransport.alwaysAccept();
const browserWindow = createExampleWindow("https://app.example.test/settings?email=dev@example.test#profile");
const traceContext = createBrowserTraceContext({
  spanId: "00f067aa0ba902b7",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736"
});
const logbrew = installLogBrewBrowser({
  clientKey: "LOGBREW_BROWSER_KEY",
  browserWindow,
  flushOnCapture: false,
  now: nextTimestamp,
  traceContext,
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
  traceId: logbrew.traceContext.traceId,
  metadata: {
    funnel: "checkout",
    ignoredNested: { value: "nested" },
    retryAttempt: 1
  }
}, logbrew, {
  flushOnCapture: false,
  now: nextTimestamp
});

const fetchCalls = [];
const logbrewFetch = createLogBrewBrowserFetch(logbrew, {
  fetchImpl: async (input, init = {}) => {
    fetchCalls.push({ input, init });
    return {
      headers: new globalThis.Headers({ "content-length": "456" }),
      status: 503
    };
  },
  flushOnCapture: false,
  now: nextTimestamp,
  nowMs: sequenceNumbers([1000, 1033]),
  randomValues: () => fillBytes(8, 0x44),
  resourcePathTemplate: "/api/checkout/:id",
  tracePropagationTargets: [/^https:\/\/api\.example\.test\/api\//u]
});
await logbrewFetch("https://api.example.test/api/checkout/123?email=dev@example.test#retry", {
  body: "private body",
  headers: { accept: "application/json" },
  method: "POST"
});
await captureBrowserNavigationTiming(createNavigationTimingEntry(), logbrew, {
  flushOnCapture: false,
  navigationPathTemplate: "/settings",
  now: nextTimestamp,
  randomValues: () => fillBytes(8, 0x55)
});

if (logbrew.client.pendingEvents() !== 7) {
  throw new Error(`expected 7 captured events, got ${logbrew.client.pendingEvents()}`);
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
if (parsed.events[0].attributes.traceId !== traceContext.traceId || parsed.events[0].attributes.spanId !== traceContext.spanId) {
  throw new Error(`expected page view to use shared trace context, got ${payload}`);
}
const action = parsed.events.find((event) => event.type === "action");
if (action?.attributes.metadata?.sessionId !== "sess_browser_001") {
  throw new Error(`expected action session metadata, got ${payload}`);
}
if (action.attributes.metadata.traceId !== traceContext.traceId || action.attributes.metadata.spanId !== traceContext.spanId) {
  throw new Error(`expected action trace metadata, got ${payload}`);
}
if (action.attributes.metadata.ignoredNested !== undefined) {
  throw new Error(`nested action metadata should be dropped: ${payload}`);
}
const network = parsed.events.find((event) => event.type === "action" && event.attributes.metadata?.source === "browser.network");
if (network?.attributes.metadata?.routeTemplate !== "/api/checkout") {
  throw new Error(`expected query-free network route template, got ${payload}`);
}
if (network.attributes.metadata.traceId !== traceContext.traceId || network.attributes.metadata.spanId !== traceContext.spanId) {
  throw new Error(`expected network trace metadata, got ${payload}`);
}
if (network.attributes.metadata.statusCode !== 503 || network.attributes.status !== "failure") {
  throw new Error(`expected failed network metadata, got ${payload}`);
}
if (network.attributes.metadata.ignoredNested !== undefined) {
  throw new Error(`nested network metadata should be dropped: ${payload}`);
}
const fetchSpan = parsed.events.find((event) => event.type === "span" && event.attributes.metadata?.source === "browser.fetch");
if (fetchSpan?.attributes.name !== "browser.fetch POST /api/checkout/:id") {
  throw new Error(`expected fetch span route template, got ${payload}`);
}
if (fetchSpan.attributes.traceId !== traceContext.traceId || fetchSpan.attributes.parentSpanId !== traceContext.spanId) {
  throw new Error(`expected fetch child span trace correlation, got ${payload}`);
}
if (fetchSpan.attributes.metadata.statusCode !== 503 || fetchSpan.attributes.metadata.responseBodySize !== 456 || fetchSpan.attributes.durationMs !== 33) {
  throw new Error(`expected fetch status, size, and duration metadata, got ${payload}`);
}
if (fetchCalls[0].init.headers.traceparent !== `00-${traceContext.traceId}-4444444444444444-01`) {
  throw new Error(`unexpected fetch span traceparent: ${fetchCalls[0].init.headers.traceparent}`);
}
if (payload.includes("api.example.test") || payload.includes("email=dev@example.test") || payload.includes("#retry") || payload.includes("private body") || payload.includes("application/json")) {
  throw new Error(`fetch span metadata leaked request details: ${payload}`);
}
const documentSpan = parsed.events.find((event) => event.type === "span" && event.attributes.metadata?.source === "browser.document");
if (documentSpan?.attributes.name !== "browser.document /settings") {
  throw new Error(`expected document timing span, got ${payload}`);
}
if (documentSpan.attributes.traceId !== traceContext.traceId || documentSpan.attributes.parentSpanId !== traceContext.spanId) {
  throw new Error(`expected document timing child span trace correlation, got ${payload}`);
}
if (documentSpan.attributes.metadata.firstByteMs !== 120 || documentSpan.attributes.metadata.loadEventMs !== 384.123) {
  throw new Error(`expected document timing phase metadata, got ${payload}`);
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
  traceContext: logbrew.traceContext,
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
if (firstTraceparent !== `00-${traceContext.traceId}-${traceContext.spanId}-01`) {
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
  documentSpan: documentSpan.attributes.name,
  events: parsed.events.length,
  fetchSpan: fetchSpan.attributes.name,
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

function fillBytes(length, value) {
  return Array.from({ length }, () => value);
}

function sequenceNumbers(values) {
  let index = 0;
  return () => values[index++] ?? values.at(-1);
}

function createNavigationTimingEntry() {
  return {
    activationStart: 7,
    connectEnd: 70,
    connectStart: 40,
    decodedBodySize: 8192,
    domComplete: 360,
    domContentLoadedEventEnd: 310,
    domContentLoadedEventStart: 302,
    domInteractive: 270,
    domainLookupEnd: 40,
    domainLookupStart: 20,
    duration: 384.123,
    encodedBodySize: 2048,
    entryType: "navigation",
    fetchStart: 10,
    loadEventEnd: 384.123,
    loadEventStart: 380,
    name: "https://app.example.test/settings?email=dev@example.test#profile",
    redirectEnd: 10,
    redirectStart: 0,
    requestStart: 80,
    responseEnd: 270,
    responseStart: 120,
    responseStatus: 200,
    secureConnectionStart: 50,
    startTime: 0,
    transferSize: 4096,
    type: "navigate",
    workerStart: 5
  };
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
