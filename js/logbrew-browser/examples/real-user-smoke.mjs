import { RecordingTransport } from "@logbrew/sdk";
import {
  captureBrowserAction,
  captureBrowserInteractionTiming,
  captureBrowserInteractionToNextPaint,
  captureBrowserNavigationTiming,
  captureBrowserNetwork,
  captureBrowserWebVital,
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
await captureBrowserWebVital(createWebVitalMetric(), logbrew, {
  flushOnCapture: false,
  now: nextTimestamp,
  randomValues: () => fillBytes(8, 0x66),
  webVitalPathTemplate: "/settings"
});
await captureBrowserInteractionTiming(createInteractionTimingEntry(), logbrew, {
  flushOnCapture: false,
  interactionPathTemplate: "/settings",
  now: nextTimestamp,
  randomValues: () => fillBytes(8, 0x77)
});
await captureBrowserInteractionTiming(createLongTaskEntry(), logbrew, {
  flushOnCapture: false,
  interactionPathTemplate: "/settings",
  now: nextTimestamp,
  randomValues: () => fillBytes(8, 0x88)
});
await captureBrowserInteractionTiming(createLongAnimationFrameEntry(), logbrew, {
  flushOnCapture: false,
  interactionPathTemplate: "/settings",
  now: nextTimestamp,
  randomValues: () => fillBytes(8, 0x99)
});
await captureBrowserInteractionToNextPaint(createInteractionToNextPaintEntries(), logbrew, {
  flushOnCapture: false,
  interactionCount: 55,
  interactionPathTemplate: "/settings",
  now: nextTimestamp,
  randomValues: () => fillBytes(8, 0xaa)
});

if (logbrew.client.pendingEvents() !== 12) {
  throw new Error(`expected 12 captured events, got ${logbrew.client.pendingEvents()}`);
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
const webVitalSpan = parsed.events.find((event) => event.type === "span" && event.attributes.metadata?.source === "browser.web_vital");
if (webVitalSpan?.attributes.name !== "browser.web_vital LCP /settings") {
  throw new Error(`expected Web Vital span, got ${payload}`);
}
if (webVitalSpan.attributes.traceId !== traceContext.traceId || webVitalSpan.attributes.parentSpanId !== traceContext.spanId) {
  throw new Error(`expected Web Vital child span trace correlation, got ${payload}`);
}
if (webVitalSpan.attributes.metadata.metricName !== "LCP" || webVitalSpan.attributes.metadata.metricValue !== 2480.456) {
  throw new Error(`expected Web Vital metric metadata, got ${payload}`);
}
if (payload.includes("hero.jpg") || payload.includes("button.checkout")) {
  throw new Error(`Web Vital metadata leaked attribution details: ${payload}`);
}
const interactionSpan = parsed.events.find((event) => event.type === "span" && event.attributes.metadata?.entryType === "event");
if (interactionSpan?.attributes.name !== "browser.interaction click /settings") {
  throw new Error(`expected interaction timing span, got ${payload}`);
}
if (interactionSpan.attributes.traceId !== traceContext.traceId || interactionSpan.attributes.parentSpanId !== traceContext.spanId) {
  throw new Error(`expected interaction child span trace correlation, got ${payload}`);
}
if (interactionSpan.attributes.metadata.interactionId !== 91 || interactionSpan.attributes.metadata.processingDurationMs !== 55) {
  throw new Error(`expected interaction timing metadata, got ${payload}`);
}
const longTaskSpan = parsed.events.find((event) => event.type === "span" && event.attributes.metadata?.entryType === "longtask");
if (longTaskSpan?.attributes.name !== "browser.long_task /settings") {
  throw new Error(`expected long-task span, got ${payload}`);
}
if (longTaskSpan.attributes.traceId !== traceContext.traceId || longTaskSpan.attributes.parentSpanId !== traceContext.spanId) {
  throw new Error(`expected long-task child span trace correlation, got ${payload}`);
}
const longAnimationFrameSpan = parsed.events.find((event) => event.type === "span" && event.attributes.metadata?.entryType === "long-animation-frame");
if (longAnimationFrameSpan?.attributes.name !== "browser.long_animation_frame /settings") {
  throw new Error(`expected long-animation-frame span, got ${payload}`);
}
if (longAnimationFrameSpan.attributes.traceId !== traceContext.traceId || longAnimationFrameSpan.attributes.parentSpanId !== traceContext.spanId) {
  throw new Error(`expected long-animation-frame child span trace correlation, got ${payload}`);
}
if (longAnimationFrameSpan.attributes.metadata.blockingDurationMs !== 45 || longAnimationFrameSpan.attributes.metadata.scriptCount !== 2) {
  throw new Error(`expected long-animation-frame timing metadata, got ${payload}`);
}
const inpSpan = parsed.events.find((event) => event.type === "span" && event.attributes.metadata?.source === "browser.interaction_to_next_paint");
if (inpSpan?.attributes.name !== "browser.interaction_to_next_paint /settings") {
  throw new Error(`expected interaction-to-next-paint span, got ${payload}`);
}
if (inpSpan.attributes.traceId !== traceContext.traceId || inpSpan.attributes.parentSpanId !== traceContext.spanId) {
  throw new Error(`expected interaction-to-next-paint child span trace correlation, got ${payload}`);
}
if (inpSpan.attributes.metadata.candidateRank !== 2 || inpSpan.attributes.metadata.interactionType !== "press") {
  throw new Error(`expected interaction-to-next-paint ranking metadata, got ${payload}`);
}
if (payload.includes("https://cdn.example.test/app.js") || payload.includes("iframe-private") || payload.includes("renderCheckout")) {
  throw new Error(`interaction timing metadata leaked attribution details: ${payload}`);
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
  interactionSpan: interactionSpan.attributes.name,
  inpSpan: inpSpan.attributes.name,
  longAnimationFrameSpan: longAnimationFrameSpan.attributes.name,
  longTaskSpan: longTaskSpan.attributes.name,
  networkAction: network.attributes.metadata.routeTemplate,
  pageView: parsed.events[0].attributes.name,
  pagehideFlushEvents: parsed.events.length,
  propagatedTraceparent: firstTraceparent,
  syncError: parsed.events[1].attributes.title,
  unhandledRejection: parsed.events[2].attributes.title,
  webVitalSpan: webVitalSpan.attributes.name
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

function createWebVitalMetric() {
  return {
    attribution: {
      element: "img.hero",
      elementRenderDelay: 40,
      interactionTarget: "button.checkout",
      loadState: "dom-interactive",
      resourceLoadDelay: 25,
      resourceLoadDuration: 175.125,
      timeToFirstByte: 121.5,
      url: "https://cdn.example.test/assets/hero.jpg?asset=masked"
    },
    delta: 120.25,
    id: "v4-123",
    name: "LCP",
    navigationType: "navigate",
    rating: "needs-improvement",
    value: 2480.456
  };
}

function createInteractionTimingEntry() {
  return {
    duration: 128,
    entryType: "event",
    interactionId: 91,
    name: "click",
    processingEnd: 275,
    processingStart: 220,
    startTime: 200,
    target: {
      id: "checkout",
      tagName: "BUTTON",
      textContent: "button.checkout"
    }
  };
}

function createLongTaskEntry() {
  return {
    attribution: [{
      containerName: "iframe-private",
      containerSrc: "https://cdn.example.test/app.js?sample=masked",
      entryType: "taskattribution",
      name: "script"
    }],
    duration: 72.5,
    entryType: "longtask",
    name: "self",
    startTime: 500
  };
}

function createLongAnimationFrameEntry() {
  return {
    blockingDuration: 45,
    duration: 120,
    entryType: "long-animation-frame",
    firstUIEventTimestamp: 640,
    name: "long-animation-frame",
    renderStart: 650,
    scripts: [
      {
        duration: 40,
        forcedStyleAndLayoutDuration: 6,
        invoker: "DOMWindow.onclick",
        invokerType: "event-listener",
        pauseDuration: 3,
        sourceFunctionName: "renderCheckout",
        sourceURL: "https://cdn.example.test/app.js?sample=masked",
        startTime: 615
      },
      {
        duration: 13,
        forcedStyleAndLayoutDuration: 2,
        invoker: "timer",
        pauseDuration: 2,
        sourceFunctionName: "hydratePrivateWidget",
        sourceURL: "https://cdn.example.test/vendor.js?sample=masked",
        startTime: 655
      }
    ],
    startTime: 600,
    styleAndLayoutStart: 675
  };
}

function createInteractionToNextPaintEntries() {
  return [
    {
      duration: 64,
      entryType: "event",
      interactionId: 1,
      name: "click",
      processingEnd: 230,
      processingStart: 190,
      startTime: 180,
      target: {
        selector: "button.checkout",
        textContent: "Pay with private card"
      }
    },
    {
      duration: 180,
      entryType: "event",
      interactionId: 7,
      name: "keydown",
      processingEnd: 520,
      processingStart: 450,
      startTime: 430,
      target: {
        selector: "input.card-number"
      }
    },
    {
      duration: 320,
      entryType: "first-input",
      interactionId: 42,
      name: "pointerdown",
      processingEnd: 950,
      processingStart: 860,
      startTime: 820
    }
  ];
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
