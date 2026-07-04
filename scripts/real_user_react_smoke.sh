#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sdk_package_version="$(node -p "require('${repo_root}/js/logbrew-js/package.json').version")"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

core_pack_json="$tmp_dir/core-pack.json"
browser_pack_json="$tmp_dir/browser-pack.json"
react_pack_json="$tmp_dir/react-pack.json"
(cd "$repo_root/js/logbrew-js" && npm pack --json --pack-destination "$tmp_dir") > "$core_pack_json"
(cd "$repo_root/js/logbrew-browser" && npm pack --json --pack-destination "$tmp_dir") > "$browser_pack_json"
(cd "$repo_root/js/logbrew-react" && npm pack --json --pack-destination "$tmp_dir") > "$react_pack_json"

core_tgz="$(python3 - "$core_pack_json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
print(payload[0]["filename"])
PY
)"
react_tgz="$(python3 - "$react_pack_json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
print(payload[0]["filename"])
PY
)"
core_tgz="$tmp_dir/$core_tgz"
browser_tgz="$(python3 - "$browser_pack_json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
print(payload[0]["filename"])
PY
)"
browser_tgz="$tmp_dir/$browser_tgz"
react_tgz="$tmp_dir/$react_tgz"
test -f "$core_tgz"
test -f "$browser_tgz"
test -f "$react_tgz"

tar -tzf "$react_tgz" > "$tmp_dir/react-tarball.txt"
grep -q '^package/README.md$' "$tmp_dir/react-tarball.txt"
grep -q '^package/browser.js$' "$tmp_dir/react-tarball.txt"
grep -q '^package/browser.cjs$' "$tmp_dir/react-tarball.txt"
grep -q '^package/browser.d.ts$' "$tmp_dir/react-tarball.txt"
grep -q '^package/browser.d.cts$' "$tmp_dir/react-tarball.txt"
grep -q '^package/index.js$' "$tmp_dir/react-tarball.txt"
grep -q '^package/index.cjs$' "$tmp_dir/react-tarball.txt"
grep -q '^package/index.d.ts$' "$tmp_dir/react-tarball.txt"
grep -q '^package/index.d.cts$' "$tmp_dir/react-tarball.txt"
grep -q '^package/examples/index.mjs$' "$tmp_dir/react-tarball.txt"
grep -q '^package/examples/package.json$' "$tmp_dir/react-tarball.txt"
grep -q '^package/examples/react-router-route-spans.mjs$' "$tmp_dir/react-tarball.txt"
grep -q '^package/examples/readme-example.mjs$' "$tmp_dir/react-tarball.txt"
grep -q '^package/examples/real-user-smoke.mjs$' "$tmp_dir/react-tarball.txt"
tar -xOf "$react_tgz" package/README.md > "$tmp_dir/react-readme.md"
grep -q 'npm install @logbrew/sdk @logbrew/react react' "$tmp_dir/react-readme.md"
grep -q 'pnpm add @logbrew/sdk @logbrew/react react' "$tmp_dir/react-readme.md"
grep -q 'LOGBREW_CLIENT_KEY' "$tmp_dir/react-readme.md"
grep -q 'LogBrewProvider' "$tmp_dir/react-readme.md"
grep -q 'LogBrewErrorBoundary' "$tmp_dir/react-readme.md"
grep -q 'useLogBrewActions' "$tmp_dir/react-readme.md"
grep -q 'useLogBrewAction' "$tmp_dir/react-readme.md"
grep -q 'useLogBrewNetwork' "$tmp_dir/react-readme.md"
grep -q '@logbrew/react/browser' "$tmp_dir/react-readme.md"
grep -q 'useLogBrewBrowserInstrumentation' "$tmp_dir/react-readme.md"
grep -q 'captureReactError' "$tmp_dir/react-readme.md"
grep -q 'createTraceparentFetch' "$tmp_dir/react-readme.md"
grep -q 'createReactTraceparent' "$tmp_dir/react-readme.md"
grep -q 'useLogBrewReactRouterNavigation' "$tmp_dir/react-readme.md"
grep -q 'createReactRouterRouteTemplate' "$tmp_dir/react-readme.md"
grep -q 'tracePropagationTargets' "$tmp_dir/react-readme.md"

app_dir="$tmp_dir/react-smoke-app"
mkdir -p "$app_dir"
cd "$app_dir"
npm init -y >/dev/null
react_version="$(npm view react version)"
react_dom_version="$(npm view react-dom version)"
renderer_version="$(npm view react-test-renderer version)"
npm install --save-exact \
  "$core_tgz" \
  "$browser_tgz" \
  "$react_tgz" \
  "react@$react_version" \
  "react-dom@$react_dom_version" \
  "react-test-renderer@$renderer_version" \
  typescript \
  @types/react \
  @types/react-dom >/dev/null

grep -q '"@logbrew/sdk": "file:' package.json
grep -q '"@logbrew/browser": "file:' package.json
grep -q '"@logbrew/react": "file:' package.json
grep -q '"react":' package.json
grep -q '"react-dom":' package.json
grep -q '"react-test-renderer":' package.json
grep -q '"@logbrew/react"' package-lock.json
grep -q '"@logbrew/browser"' package-lock.json
grep -q '"@logbrew/sdk"' package-lock.json
npm ls @logbrew/sdk @logbrew/browser @logbrew/react react react-dom react-test-renderer >/dev/null
npm explain @logbrew/react > "$tmp_dir/npm-explain-react.txt"
grep -q '@logbrew/react@0.1.0' "$tmp_dir/npm-explain-react.txt"
npm list --depth=0 > "$tmp_dir/npm-list-depth0.txt"
grep -q '@logbrew/react@0.1.0' "$tmp_dir/npm-list-depth0.txt"
grep -q '@logbrew/browser@0.1.0' "$tmp_dir/npm-list-depth0.txt"
grep -q "@logbrew/sdk@${sdk_package_version}" "$tmp_dir/npm-list-depth0.txt"
npm list --json --depth=0 > "$tmp_dir/npm-list-depth0.json"
python3 - "$tmp_dir/npm-list-depth0.json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
deps = payload.get("dependencies", {})
for name in ("@logbrew/browser", "@logbrew/react", "@logbrew/sdk", "react", "react-dom", "react-test-renderer"):
    if name not in deps:
        raise SystemExit(f"missing npm dependency entry: {name}")
PY

cat > smoke.mjs <<'EOF'
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";
import { RecordingTransport } from "@logbrew/sdk";
import { createBrowserTraceContext } from "@logbrew/browser";
import {
  LogBrewErrorBoundary,
  LogBrewProvider,
  captureReactAction,
  captureReactError,
  captureReactNetwork,
  captureReactRouterNavigation,
  createLogBrewReactClient,
  createReactActionEvent,
  createReactErrorEvent,
  createReactNetworkEvent,
  createReactRouterNavigationSpanEvent,
  createReactRouterRouteTemplate,
  createReactTraceparent,
  createTraceparentFetch,
  shouldPropagateTraceparent,
  useLogBrew,
  useLogBrewAction,
  useLogBrewActions,
  useLogBrewReactRouterNavigation,
  useLogBrewNetwork
} from "@logbrew/react";
import { useLogBrewBrowserInstrumentation } from "@logbrew/react/browser";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const client = createLogBrewReactClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "react-smoke-app",
  sdkVersion: "0.1.0",
  maxRetries: 1
});

function SmokeComponent() {
  const logbrew = useLogBrew();
  const actions = useLogBrewActions();
  actions.release("evt_release_001", "2026-06-02T10:00:00Z", {
    version: "1.2.3",
    commit: "abc123def456",
    notes: "Public release marker"
  });
  actions.environment("evt_environment_001", "2026-06-02T10:00:01Z", {
    name: "production",
    region: "global"
  });
  actions.issue("evt_issue_001", "2026-06-02T10:00:02Z", {
    title: "Checkout timeout",
    level: "error",
    message: "Request timed out after retry budget"
  });
  actions.log("evt_log_001", "2026-06-02T10:00:03Z", {
    message: "worker started",
    level: "info",
    logger: "job-runner"
  });
  actions.span("evt_span_001", "2026-06-02T10:00:04Z", {
    name: "GET /health",
    traceId: "trace_001",
    spanId: "span_001",
    status: "ok",
    durationMs: 12.5
  });
  actions.action("evt_action_001", "2026-06-02T10:00:05Z", {
    name: "deploy",
    status: "success"
  });
  return React.createElement("output", { "data-pending": logbrew.pendingEvents() }, "ready");
}

function TimelineComponent() {
  const logbrew = useLogBrew();
  const captureAction = useLogBrewAction({
    metadata: {
      funnel: "checkout",
      routeTemplate: "/checkout",
      sessionId: "sess_123"
    },
    timestamp: "2026-06-02T10:00:06Z",
    traceId: "trace_001"
  });
  const captureNetwork = useLogBrewNetwork({
    routeTemplate: "/api/checkout?email=hidden#receipt",
    sessionId: "sess_123",
    timestamp: "2026-06-02T10:00:07Z",
    traceId: "trace_001"
  });
  captureAction({
    id: "evt_action_checkout_click",
    metadata: { ignoredNested: { value: "nested" }, step: "submit" },
    name: "checkout-click"
  });
  captureNetwork({
    durationMs: 124,
    id: "evt_action_checkout_api",
    method: "post",
    metadata: { ignoredNested: { value: "nested" } },
    statusCode: 503
  });
  return React.createElement("output", { "data-pending": logbrew.pendingEvents() }, "timeline");
}

const markup = renderToStaticMarkup(
  React.createElement(LogBrewProvider, { client }, React.createElement(SmokeComponent))
);
if (!markup.includes('data-pending="6"')) {
  throw new Error(`provider did not expose queued events: ${markup}`);
}

const timelineClient = createLogBrewReactClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "react-timeline-smoke-app",
  sdkVersion: "0.1.0",
  maxRetries: 1
});
const timelineMarkup = renderToStaticMarkup(
  React.createElement(LogBrewProvider, { client: timelineClient }, React.createElement(TimelineComponent))
);
if (!timelineMarkup.includes('data-pending="2"')) {
  throw new Error(`timeline hooks did not queue two events: ${timelineMarkup}`);
}
const timelinePreview = JSON.parse(timelineClient.previewJson());
if (timelinePreview.events.length !== 2) {
  throw new Error(`expected two timeline events, got ${timelinePreview.events.length}`);
}
const checkoutAction = timelinePreview.events.find((event) => event.id === "evt_action_checkout_click");
if (checkoutAction?.attributes.metadata.source !== "react.action") {
  throw new Error("expected React action source metadata");
}
if (checkoutAction.attributes.metadata.funnel !== "checkout" || checkoutAction.attributes.metadata.step !== "submit") {
  throw new Error("expected React action funnel and step metadata");
}
if ("ignoredNested" in checkoutAction.attributes.metadata) {
  throw new Error("expected React action helper to drop nested metadata");
}
const networkAction = timelinePreview.events.find((event) => event.id === "evt_action_checkout_api");
if (networkAction?.attributes.name !== "POST /api/checkout") {
  throw new Error(`unexpected React network action name: ${networkAction?.attributes.name}`);
}
if (networkAction.attributes.status !== "failure") {
  throw new Error("expected 5xx React network helper status to be failure");
}
if (networkAction.attributes.metadata.routeTemplate !== "/api/checkout") {
  throw new Error(`expected React network route without query/hash, got ${networkAction.attributes.metadata.routeTemplate}`);
}
if (networkAction.attributes.metadata.method !== "POST" || networkAction.attributes.metadata.durationMs !== 124) {
  throw new Error("expected React network method and duration metadata");
}
if ("ignoredNested" in networkAction.attributes.metadata) {
  throw new Error("expected React network helper to drop nested metadata");
}

const routerTraceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01";
const routerMatches = [
  { route: { path: "/" }, params: {} },
  { route: { path: "projects" }, params: {} },
  { route: { path: ":projectId" }, params: { projectId: "private-project-123" } },
  { route: { path: "settings?debug=true#panel" }, params: {} }
];
const routerRouteTemplate = createReactRouterRouteTemplate(routerMatches);
if (routerRouteTemplate !== "/projects/:projectId/settings") {
  throw new Error(`unexpected React Router template: ${routerRouteTemplate}`);
}
const directRouterSpan = createReactRouterNavigationSpanEvent({
  durationMs: 42,
  id: "evt_span_react_router_direct",
  location: {
    pathname: "/projects/private-project-123/settings",
    search: "?debug=true&email=hidden@example.test",
    hash: "#panel"
  },
  metadata: {
    ignoredNested: { value: "drop" },
    owner: "checkout-ui"
  },
  navigationType: "PUSH",
  routeMatches: routerMatches,
  timestamp: "2026-06-02T10:00:07Z",
  traceparent: routerTraceparent
});
if (directRouterSpan.attributes.name !== "react.route /projects/:projectId/settings") {
  throw new Error(`unexpected React Router span name: ${directRouterSpan.attributes.name}`);
}
if (directRouterSpan.attributes.traceId !== "4bf92f3577b34da6a3ce929d0e0e4736") {
  throw new Error("expected React Router span trace id from traceparent");
}
if (directRouterSpan.attributes.metadata.routeTemplate !== "/projects/:projectId/settings") {
  throw new Error("expected React Router route template metadata");
}
if (directRouterSpan.attributes.metadata.owner !== "checkout-ui") {
  throw new Error("expected primitive React Router metadata");
}
const directRouterBody = JSON.stringify(directRouterSpan);
if (
  directRouterBody.includes("private-project-123") ||
  directRouterBody.includes("hidden@example.test") ||
  directRouterBody.includes("#panel") ||
  directRouterBody.includes("ignoredNested")
) {
  throw new Error(`React Router span leaked route details: ${directRouterBody}`);
}

const routerClient = createLogBrewReactClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "react-router-smoke-app",
  sdkVersion: "0.1.0",
  maxRetries: 1
});
const routerEvents = [];
function RouterProbe({ location, navigationType }) {
  useLogBrewReactRouterNavigation({
    durationMs: 17,
    location,
    navigationType,
    onNavigation: (event) => {
      routerEvents.push(event.id);
    },
    routeMatches: routerMatches,
    timestamp: "2026-06-02T10:00:12Z",
    traceparent: routerTraceparent
  });
  return React.createElement("span", { "data-route": routerRouteTemplate }, "route");
}
let routerRenderer;
await act(async () => {
  routerRenderer = TestRenderer.create(
    React.createElement(
      LogBrewProvider,
      { client: routerClient },
      React.createElement(RouterProbe, {
        location: { pathname: "/projects/private-project-123/settings", search: "?debug=true", hash: "#panel" },
        navigationType: "PUSH"
      })
    )
  );
});
await act(async () => {
  routerRenderer.update(
    React.createElement(
      LogBrewProvider,
      { client: routerClient },
      React.createElement(RouterProbe, {
        location: { pathname: "/projects/private-project-123/settings", search: "?debug=false", hash: "#other" },
        navigationType: "PUSH"
      })
    )
  );
});
await act(async () => {
  routerRenderer.update(
    React.createElement(
      LogBrewProvider,
      { client: routerClient },
      React.createElement(RouterProbe, {
        location: { pathname: "/projects/private-project-456/settings", search: "?debug=true", hash: "#panel" },
        navigationType: "POP"
      })
    )
  );
});
const routerPreview = JSON.parse(routerClient.previewJson());
const routerBody = JSON.stringify(routerPreview);
if (routerPreview.events.length !== 2) {
  throw new Error(`expected two React Router spans for two concrete paths, got ${routerPreview.events.length}: ${routerBody}`);
}
if (routerEvents.length !== 2) {
  throw new Error(`expected two React Router navigation callbacks, got ${routerEvents.length}`);
}
for (const event of routerPreview.events) {
  if (event.type !== "span" || event.attributes.metadata.source !== "react.router") {
    throw new Error(`expected React Router span source metadata: ${routerBody}`);
  }
  if (event.attributes.metadata.routeTemplate !== "/projects/:projectId/settings") {
    throw new Error(`expected route-template metadata on React Router span: ${routerBody}`);
  }
}
if (
  routerBody.includes("private-project-123") ||
  routerBody.includes("private-project-456") ||
  routerBody.includes("debug=true") ||
  routerBody.includes("#panel")
) {
  throw new Error(`React Router hook leaked concrete route data: ${routerBody}`);
}

const routerLoadDrops = [];
const routerLoadClient = createLogBrewReactClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  maxQueueSize: 25,
  maxRetries: 1,
  onEventDropped: (drop) => {
    routerLoadDrops.push(drop);
  },
  sdkName: "react-router-load-smoke-app",
  sdkVersion: "0.1.0"
});
for (let index = 0; index < 80; index += 1) {
  captureReactRouterNavigation(routerLoadClient, {
    id: `evt_span_react_router_load_${index}`,
    routeTemplate: "/projects/:projectId/settings",
    spanId: (index + 1).toString(16).padStart(16, "0"),
    timestamp: "2026-06-02T10:00:14Z",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736"
  });
}
if (routerLoadClient.pendingEvents() !== 25) {
  throw new Error(`expected bounded React Router queue to retain 25 events, got ${routerLoadClient.pendingEvents()}`);
}
if (routerLoadClient.droppedEvents() !== 55 || routerLoadDrops.length !== 55) {
  throw new Error(`expected 55 dropped React Router spans, got ${routerLoadClient.droppedEvents()} drops and ${routerLoadDrops.length} callbacks`);
}
const lastRouterDrop = routerLoadDrops.at(-1);
if (
  lastRouterDrop.reason !== "queue_overflow" ||
  lastRouterDrop.eventType !== "span" ||
  lastRouterDrop.eventId !== "evt_span_react_router_load_79" ||
  lastRouterDrop.droppedEvents !== 55
) {
  throw new Error(`unexpected React Router load drop callback: ${JSON.stringify(lastRouterDrop)}`);
}
const routerLoadTransport = new RecordingTransport([{ statusCode: 503 }, { statusCode: 202 }]);
const routerLoadResponse = await routerLoadClient.shutdown(routerLoadTransport);
if (routerLoadResponse.statusCode !== 202 || routerLoadResponse.attempts !== 2) {
  throw new Error(`expected React Router load shutdown retry, got ${JSON.stringify(routerLoadResponse)}`);
}
if (routerLoadClient.pendingEvents() !== 0) {
  throw new Error("expected React Router load shutdown to clear retained spans");
}
const routerLoadBody = routerLoadTransport.lastBody() ?? "";
if (!routerLoadBody.includes("evt_span_react_router_load_24") || routerLoadBody.includes("evt_span_react_router_load_25")) {
  throw new Error(`expected React Router load body to keep only retained bounded events: ${routerLoadBody}`);
}

const browserInstrumentationClient = createLogBrewReactClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "react-browser-instrumentation-smoke-app",
  sdkVersion: "0.1.0",
  maxRetries: 1
});
const browserWindow = {
  document: {
    title: "Checkout receipt for hidden@example.test",
    visibilityState: "visible"
  },
  location: {
    hash: "#receipt",
    pathname: "/checkout/private-order-123",
    search: "?email=hidden@example.test"
  },
  navigator: {
    userAgent: "LogBrewReactSmoke/1.0"
  },
  addEventListener() {},
  removeEventListener() {}
};
const browserObserverCallbacks = new Map();
class FakePerformanceObserver {
  static supportedEntryTypes = ["event", "long-animation-frame"];

  constructor(callback) {
    this.callback = callback;
    this.disconnected = false;
    this.type = undefined;
  }

  observe(options) {
    this.type = options.type ?? options.entryTypes?.[0];
    browserObserverCallbacks.set(this.type, this);
  }

  disconnect() {
    this.disconnected = true;
  }

  emit(entries) {
    if (!this.disconnected) {
      this.callback({ getEntries: () => entries });
    }
  }
}
const webVitalCallbacks = {};
const fakeWebVitals = {
  onINP(callback) {
    webVitalCallbacks.INP = callback;
    return () => {
      delete webVitalCallbacks.INP;
    };
  }
};
const browserTraceContext = createBrowserTraceContext({
  spanId: "1111111111111111",
  traceId: "22222222222222222222222222222222"
});
const browserInstrumentationEvents = [];
function BrowserInstrumentationProbe() {
  useLogBrewBrowserInstrumentation({
    browserWindow,
    interactionTiming: {
      interactionPathTemplate: "/checkout/:orderId",
      now: () => "2026-06-02T10:00:15Z",
      performanceObserver: FakePerformanceObserver,
      randomValues: deterministicBytes
    },
    onCaptureError: (error) => {
      throw error;
    },
    onInstrumentation: (name) => {
      browserInstrumentationEvents.push(name);
    },
    traceContext: browserTraceContext,
    webVitals: {
      metricNames: ["INP"],
      now: () => "2026-06-02T10:00:16Z",
      randomValues: deterministicBytes,
      webVitals: fakeWebVitals,
      webVitalPathTemplate: "/checkout/:orderId"
    }
  });
  return React.createElement("span", null, "browser instrumentation");
}
let browserRenderer;
await act(async () => {
  browserRenderer = TestRenderer.create(
    React.createElement(
      LogBrewProvider,
      { client: browserInstrumentationClient },
      React.createElement(BrowserInstrumentationProbe)
    )
  );
});
if (!browserInstrumentationEvents.includes("interactionTiming") || !browserInstrumentationEvents.includes("webVitals")) {
  throw new Error(`expected React browser instrumentation callbacks, got ${browserInstrumentationEvents.join(",")}`);
}
browserObserverCallbacks.get("event")?.emit([{
  duration: 88,
  entryType: "event",
  interactionId: 123,
  name: "click",
  processingEnd: 148,
  processingStart: 118,
  startTime: 100
}]);
webVitalCallbacks.INP?.({
  attribution: {
    inputDelay: 18,
    presentationDelay: 40,
    processingDuration: 30
  },
  delta: 88,
  id: "v3-123",
  name: "INP",
  navigationType: "navigate",
  rating: "needs-improvement",
  value: 88
});
await act(async () => {});
await act(async () => {
  browserRenderer.unmount();
});
if (!browserObserverCallbacks.get("event")?.disconnected) {
  throw new Error("expected React browser interaction instrumentation to disconnect on unmount");
}
if (webVitalCallbacks.INP !== undefined) {
  throw new Error("expected React browser web vitals instrumentation to unregister on unmount");
}
const browserInstrumentationPreview = JSON.parse(browserInstrumentationClient.previewJson());
const browserInstrumentationBody = JSON.stringify(browserInstrumentationPreview);
if (browserInstrumentationPreview.events.length !== 2) {
  throw new Error(`expected two React browser instrumentation spans, got ${browserInstrumentationPreview.events.length}: ${browserInstrumentationBody}`);
}
const browserInteractionEvent = browserInstrumentationPreview.events.find((event) => event.attributes.metadata.source === "browser.interaction");
const browserWebVitalEvent = browserInstrumentationPreview.events.find((event) => event.attributes.metadata.source === "browser.web_vital");
if (!browserInteractionEvent || !browserWebVitalEvent) {
  throw new Error(`expected browser interaction and web vital spans: ${browserInstrumentationBody}`);
}
if (
  browserInteractionEvent.attributes.traceId !== browserTraceContext.traceId ||
  browserInteractionEvent.attributes.parentSpanId !== browserTraceContext.spanId ||
  browserWebVitalEvent.attributes.traceId !== browserTraceContext.traceId ||
  browserWebVitalEvent.attributes.parentSpanId !== browserTraceContext.spanId
) {
  throw new Error(`expected React browser spans to inherit the supplied trace context: ${browserInstrumentationBody}`);
}
if (
  browserInstrumentationBody.includes("hidden@example.test") ||
  browserInstrumentationBody.includes("private-order-123") ||
  browserInstrumentationBody.includes("#receipt")
) {
  throw new Error(`React browser instrumentation leaked concrete URL details: ${browserInstrumentationBody}`);
}

const browserLoadDrops = [];
const browserLoadClient = createLogBrewReactClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  maxQueueSize: 25,
  maxRetries: 1,
  onEventDropped: (drop) => {
    browserLoadDrops.push(drop);
  },
  sdkName: "react-browser-load-smoke-app",
  sdkVersion: "0.1.0"
});
browserObserverCallbacks.clear();
function BrowserInstrumentationLoadProbe() {
  useLogBrewBrowserInstrumentation({
    browserWindow,
    interactionTiming: {
      interactionPathTemplate: "/checkout/:orderId",
      performanceObserver: FakePerformanceObserver,
      randomValues: deterministicBytes
    },
    traceContext: browserTraceContext,
    webVitals: false
  });
  return React.createElement("span", null, "browser load");
}
let browserLoadRenderer;
await act(async () => {
  browserLoadRenderer = TestRenderer.create(
    React.createElement(
      LogBrewProvider,
      { client: browserLoadClient },
      React.createElement(BrowserInstrumentationLoadProbe)
    )
  );
});
browserObserverCallbacks.get("event")?.emit(
  Array.from({ length: 80 }, (_value, index) => ({
    duration: 80 + index,
    entryType: "event",
    interactionId: 500 + index,
    name: "click",
    processingEnd: 150 + index,
    processingStart: 120 + index,
    startTime: 100 + index
  }))
);
await act(async () => {});
await act(async () => {
  browserLoadRenderer.unmount();
});
if (browserLoadClient.pendingEvents() !== 25) {
  throw new Error(`expected bounded React browser load queue to retain 25 events, got ${browserLoadClient.pendingEvents()}`);
}
if (browserLoadClient.droppedEvents() !== 55 || browserLoadDrops.length !== 55) {
  throw new Error(`expected 55 React browser load drops, got ${browserLoadClient.droppedEvents()} drops and ${browserLoadDrops.length} callbacks`);
}
const lastBrowserLoadDrop = browserLoadDrops.at(-1);
if (
  lastBrowserLoadDrop.reason !== "queue_overflow" ||
  lastBrowserLoadDrop.eventType !== "span" ||
  lastBrowserLoadDrop.droppedEvents !== 55
) {
  throw new Error(`unexpected React browser load drop callback: ${JSON.stringify(lastBrowserLoadDrop)}`);
}
const browserLoadTransport = new RecordingTransport([{ statusCode: 503 }, { statusCode: 202 }]);
const browserLoadResponse = await browserLoadClient.shutdown(browserLoadTransport);
if (browserLoadResponse.statusCode !== 202 || browserLoadResponse.attempts !== 2) {
  throw new Error(`expected React browser load shutdown retry, got ${JSON.stringify(browserLoadResponse)}`);
}
if (browserLoadClient.pendingEvents() !== 0) {
  throw new Error("expected React browser load shutdown to clear retained spans");
}
const browserLoadBody = browserLoadTransport.lastBody() ?? "";
if (
  browserLoadBody.includes("hidden@example.test") ||
  browserLoadBody.includes("private-order-123") ||
  browserLoadBody.includes("#receipt")
) {
  throw new Error(`React browser load proof leaked concrete URL details: ${browserLoadBody}`);
}

const directClient = createLogBrewReactClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "react-direct-action-smoke-app",
  sdkVersion: "0.1.0",
  maxRetries: 1
});
const directAction = createReactActionEvent({
  id: "evt_action_direct",
  metadata: { step: "open" },
  name: "checkout-panel-opened",
  sessionId: "sess_456",
  timestamp: "2026-06-02T10:00:08Z"
});
if (directAction.attributes.metadata.source !== "react.action") {
  throw new Error("expected direct React action source metadata");
}
captureReactAction(directClient, {
  id: "evt_action_direct_capture",
  metadata: { step: "confirm" },
  name: "checkout-confirmed",
  timestamp: "2026-06-02T10:00:09Z"
});
const directNetwork = createReactNetworkEvent({
  id: "evt_action_direct_network",
  method: "GET",
  routeTemplate: "/api/orders?email=hidden",
  statusCode: 200,
  timestamp: "2026-06-02T10:00:10Z"
});
if (directNetwork.attributes.metadata.routeTemplate !== "/api/orders") {
  throw new Error("expected direct React network helper to strip query text");
}
captureReactNetwork(directClient, {
  id: "evt_action_direct_network_capture",
  method: "GET",
  routeTemplate: "/api/orders#receipt",
  statusCode: 200,
  timestamp: "2026-06-02T10:00:11Z"
});
const directPreview = JSON.parse(directClient.previewJson());
if (directPreview.events.length !== 2) {
  throw new Error(`expected two direct helper events, got ${directPreview.events.length}`);
}

try {
  renderToStaticMarkup(React.createElement(() => {
    useLogBrew();
    return React.createElement("span", null, "missing provider");
  }));
  throw new Error("expected missing provider to fail");
} catch (error) {
  if (error?.code !== "configuration_error") {
    throw error;
  }
}

const tracedFetchRequests = [];
const tracedFetch = createTraceparentFetch({
  fetchImpl: async (input, init = {}) => {
    tracedFetchRequests.push({ input, init });
    return { status: 204 };
  },
  traceparentFactory: () => createReactTraceparent({
    randomValues: deterministicBytes
  }),
  tracePropagationTargets: ["https://api.example.test/", /^\/api\//u]
});
if (!shouldPropagateTraceparent("https://api.example.test/checkout", ["https://api.example.test/"])) {
  throw new Error("expected API URL to match trace propagation target");
}
if (shouldPropagateTraceparent("https://cdn.example.test/app.js", ["https://api.example.test/"])) {
  throw new Error("expected CDN URL not to match trace propagation target");
}
if (shouldPropagateTraceparent("https://api.example.test.evil.test/checkout", ["https://api.example.test"])) {
  throw new Error("lookalike origin must not receive traceparent");
}
if (!shouldPropagateTraceparent("https://api.example.test/v1/orders", ["https://api.example.test/v1"])) {
  throw new Error("expected same-origin path prefix to match trace propagation target");
}
if (shouldPropagateTraceparent("https://api.example.test/v10/orders", ["https://api.example.test/v1"])) {
  throw new Error("path prefix must respect segment boundaries");
}
await tracedFetch("https://api.example.test/checkout?email=dev@example.test", {
  headers: { accept: "application/json", traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01" }
});
await tracedFetch("https://cdn.example.test/app.js", {
  headers: { accept: "text/javascript" }
});
await tracedFetch("/api/cart");
if (tracedFetchRequests.length !== 3) {
  throw new Error(`expected three traced fetch calls, got ${tracedFetchRequests.length}`);
}
const propagatedTraceparent = tracedFetchRequests[0].init.headers.traceparent;
if (propagatedTraceparent !== "00-0102030405060708090a0b0c0d0e0f10-0102030405060708-01") {
  throw new Error(`unexpected propagated traceparent: ${propagatedTraceparent}`);
}
if (tracedFetchRequests[0].init.headers.accept !== "application/json") {
  throw new Error("expected traced fetch to preserve existing headers");
}
if (tracedFetchRequests[1].init.headers?.traceparent !== undefined) {
  throw new Error("unmatched request should not receive traceparent");
}
if (tracedFetchRequests[2].init.headers.traceparent !== propagatedTraceparent) {
  throw new Error("relative target should receive traceparent");
}

const errorClient = createLogBrewReactClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "react-error-smoke-app",
  sdkVersion: "0.1.0",
  maxRetries: 1
});
let boundaryEvent = null;
let captureFailures = 0;
function BrokenCheckout() {
  throw new Error("Checkout boundary failed");
}
await act(async () => {
  TestRenderer.create(
    React.createElement(
      LogBrewProvider,
      { client: errorClient },
      React.createElement(
        LogBrewErrorBoundary,
        {
          fallback: ({ error }) => React.createElement(
            "strong",
            { role: "alert" },
            error instanceof Error ? error.message : "React error"
          ),
          metadata: { route: "checkout" },
          onCaptureError: () => {
            captureFailures += 1;
          },
          onError: (_error, _info, event) => {
            boundaryEvent = event;
          }
        },
        React.createElement(BrokenCheckout)
      )
    )
  );
});
if (captureFailures !== 0) {
  throw new Error(`expected no React boundary capture failures, got ${captureFailures}`);
}
if (!boundaryEvent) {
  throw new Error("expected React error boundary to capture an issue event");
}
const handledError = new Error("Manual React failure");
handledError.stack = "Error: Manual React failure\n    at ManualHandler";
captureReactError(errorClient, "non-error React failure", {
  id: "evt_issue_react_non_error",
  timestamp: "2026-06-02T10:00:06Z",
  level: "warning",
  metadata: { route: "checkout" }
});
const stackEvent = createReactErrorEvent(handledError, {
  id: "evt_issue_react_stack",
  timestamp: "2026-06-02T10:00:07Z",
  componentStack: "\n    at ManualHandler",
  includeStack: true
});
errorClient.issue(stackEvent.id, stackEvent.timestamp, stackEvent.attributes);
const errorPreview = JSON.parse(errorClient.previewJson());
if (errorPreview.events.length !== 3) {
  throw new Error(`expected three React error events, got ${errorPreview.events.length}`);
}
const [boundaryIssue, nonErrorIssue, stackIssue] = errorPreview.events;
if (boundaryIssue.id !== boundaryEvent.id) {
  throw new Error("expected boundary callback to receive the queued issue event");
}
if (boundaryIssue.attributes.title !== "React error: Checkout boundary failed") {
  throw new Error(`unexpected boundary issue title: ${boundaryIssue.attributes.title}`);
}
if (boundaryIssue.attributes.metadata.source !== "react.error") {
  throw new Error("expected boundary issue source metadata");
}
if (!boundaryIssue.attributes.metadata.componentStack.includes("BrokenCheckout")) {
  throw new Error("expected boundary issue to include React component stack");
}
if ("errorStack" in boundaryIssue.attributes.metadata) {
  throw new Error("expected boundary issue to omit raw error stack by default");
}
if (nonErrorIssue.attributes.level !== "warning" || nonErrorIssue.attributes.metadata.errorValueType !== "string") {
  throw new Error("expected non-Error capture to preserve warning level and value type");
}
if (stackIssue.attributes.metadata.errorStack !== handledError.stack) {
  throw new Error("expected includeStack to attach raw error stack");
}

const preview = client.previewJson();
const response = await client.shutdown(new RecordingTransport([{ statusCode: 503 }, { statusCode: 202 }]));
const errorResponse = await errorClient.shutdown(new RecordingTransport([{ statusCode: 503 }, { statusCode: 202 }]));
console.log(preview);
console.error(JSON.stringify({
  ok: true,
  status: response.statusCode,
  attempts: response.attempts,
  events: 6,
  errorAttempts: errorResponse.attempts,
  errorEvents: errorPreview.events.length,
  networkAction: networkAction.attributes.name,
  propagatedTraceparent,
  rendered: true
}));

function deterministicBytes(length) {
  return Uint8Array.from({ length }, (_value, index) => index + 1);
}
EOF

if ! node smoke.mjs > "$tmp_dir/react-smoke.stdout.json" 2> "$tmp_dir/react-smoke.stderr.json"; then
  cat "$tmp_dir/react-smoke.stderr.json" >&2
  exit 1
fi
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/react-smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/react-smoke.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/react-smoke.stderr.json"
grep -q '"attempts":2' "$tmp_dir/react-smoke.stderr.json"
grep -q '"errorAttempts":2' "$tmp_dir/react-smoke.stderr.json"
grep -q '"errorEvents":3' "$tmp_dir/react-smoke.stderr.json"
grep -q '"networkAction":"POST /api/checkout"' "$tmp_dir/react-smoke.stderr.json"
grep -q '"propagatedTraceparent":"00-0102030405060708090a0b0c0d0e0f10-0102030405060708-01"' "$tmp_dir/react-smoke.stderr.json"
grep -q '"rendered":true' "$tmp_dir/react-smoke.stderr.json"

cat > consumer.ts <<'EOF'
import React from "react";
import { RecordingTransport } from "@logbrew/sdk";
import {
  LogBrewErrorBoundary,
  LogBrewProvider,
  captureReactAction,
  captureReactError,
  captureReactNetwork,
  captureReactRouterNavigation,
  createLogBrewReactClient,
  createReactActionEvent,
  createReactErrorEvent,
  createReactNetworkEvent,
  createReactRouterNavigationSpanEvent,
  createReactRouterRouteTemplate,
  createReactTraceparent,
  createTraceparentFetch,
  useLogBrew,
  useLogBrewAction,
  useLogBrewActions,
  useLogBrewReactRouterNavigation,
  useLogBrewNetwork,
  type LogBrewActions,
  type ReactRouterNavigationSpanEvent,
  type ReactActionEvent,
  type ReactErrorEvent,
  type ReactNetworkInput,
  type TracePropagationTarget
} from "@logbrew/react";
import { useLogBrewBrowserInstrumentation, type LogBrewReactBrowserInstrumentationOptions } from "@logbrew/react/browser";

const client = createLogBrewReactClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "typed-react-smoke",
  sdkVersion: "0.1.0"
});
const traceTargets: TracePropagationTarget[] = ["https://api.example.test/", /^\/api\//u];
const tracedFetch = createTraceparentFetch({
  fetchImpl: async () => ({ status: 204 }),
  traceparentFactory: () => createReactTraceparent({
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "b7ad6b7169203331"
  }),
  tracePropagationTargets: traceTargets
});
void tracedFetch("/api/ping");
const typedErrorEvent: ReactErrorEvent = createReactErrorEvent(new Error("typed react error"), {
  componentStack: "\n    at Component"
});
const typedActionEvent: ReactActionEvent = createReactActionEvent({
  id: "evt_action_typed",
  name: "typed-action",
  timestamp: "2026-06-02T10:00:08Z"
});
const typedNetworkInput: ReactNetworkInput = {
  method: "POST",
  routeTemplate: "/api/typed?email=hidden",
  statusCode: 202
};
const typedNetworkEvent: ReactActionEvent = createReactNetworkEvent(typedNetworkInput);
const typedLoadClient = createLogBrewReactClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  eventFilter: (event) => event.id !== "evt_react_router_filtered",
  maxQueueSize: 3,
  onEventDropped: (drop) => {
    void drop.droppedEvents;
  }
});
const typedRouterSpan: ReactRouterNavigationSpanEvent = createReactRouterNavigationSpanEvent({
  routeMatches: [{ route: { path: "/typed" } }, { route: { path: ":id" } }],
  spanId: "b7ad6b7169203331",
  timestamp: "2026-06-02T10:00:10Z",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736"
});
const typedBrowserInstrumentationOptions: LogBrewReactBrowserInstrumentationOptions = {
  browserWindow: undefined,
  enabled: false,
  interactionTiming: false,
  traceContext: {
    sampled: true,
    spanId: "b7ad6b7169203331",
    traceFlags: "01",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736"
  },
  webVitals: false
};
const typedRouteTemplate: string | undefined = createReactRouterRouteTemplate([
  { route: { path: "/typed" } },
  { route: { path: ":id" } }
]);
captureReactRouterNavigation(typedLoadClient, typedRouterSpan);
captureReactError(client, new Error("typed handled error"), {
  componentStack: "\n    at Component"
});
captureReactAction(client, {
  name: typedActionEvent.attributes.name,
  timestamp: "2026-06-02T10:00:09Z"
});
captureReactNetwork(client, {
  ...typedNetworkInput,
  timestamp: "2026-06-02T10:00:10Z"
});

function Component(): React.ReactElement {
  const directClient = useLogBrew();
  const actions: LogBrewActions = useLogBrewActions();
  const captureAction = useLogBrewAction({ sessionId: "sess_typed" });
  const captureNetwork = useLogBrewNetwork({ routeTemplate: "/api/typed" });
  const dropped: number = actions.droppedEvents();
  useLogBrewReactRouterNavigation({
    location: { pathname: "/typed/private-id" },
    routeMatches: [{ route: { path: "/typed" } }, { route: { path: ":id" } }],
    spanId: "b7ad6b7169203332",
    timestamp: "2026-06-02T10:00:13Z",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736"
  });
  useLogBrewBrowserInstrumentation(typedBrowserInstrumentationOptions);
  actions.log("evt_log_001", "2026-06-02T10:00:03Z", {
    message: "worker started",
    level: "info"
  });
  captureAction({
    name: "typed-hook-action",
    timestamp: "2026-06-02T10:00:11Z"
  });
  captureNetwork({
    method: "GET",
    statusCode: 200,
    timestamp: "2026-06-02T10:00:12Z"
  });
  actions.captureReactError(new Error("typed hook error"), {
    componentStack: "\n    at Component"
  });
  void actions.flush(RecordingTransport.alwaysAccept());
  return React.createElement(
    "span",
    {
      "data-network": typedNetworkEvent.id,
      "data-pending": directClient.pendingEvents(),
      "data-event": typedErrorEvent.id,
      "data-route": typedRouteTemplate,
      "data-router-dropped": dropped,
      "data-router-span": typedRouterSpan.id
    },
    "typed"
  );
}

export const app = React.createElement(
  LogBrewProvider,
  { client },
  React.createElement(
    LogBrewErrorBoundary,
    { fallback: React.createElement("span", null, "typed fallback") },
    React.createElement(Component)
  )
);
EOF
cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022",
    "strict": true,
    "jsx": "react-jsx",
    "skipLibCheck": false,
    "noEmit": true
  },
  "include": ["consumer.ts"]
}
EOF
npx tsc --project tsconfig.json

cat > cjs-smoke.cjs <<'EOF'
const react = require("@logbrew/react");
const reactBrowser = require("@logbrew/react/browser");

if (typeof react.createLogBrewReactClient !== "function") {
  throw new Error("missing CommonJS React client helper");
}
if (typeof react.createTraceparentFetch !== "function" || typeof react.createReactTraceparent !== "function") {
  throw new Error("missing CommonJS React trace helpers");
}
if (typeof react.LogBrewErrorBoundary !== "function") {
  throw new Error("missing CommonJS React error boundary");
}
if (typeof react.captureReactError !== "function" || typeof react.createReactErrorEvent !== "function") {
  throw new Error("missing CommonJS React error helpers");
}
if (typeof react.captureReactAction !== "function" || typeof react.createReactActionEvent !== "function") {
  throw new Error("missing CommonJS React action helpers");
}
if (typeof react.captureReactNetwork !== "function" || typeof react.createReactNetworkEvent !== "function") {
  throw new Error("missing CommonJS React network helpers");
}
if (typeof react.createReactRouterRouteTemplate !== "function" || typeof react.createReactRouterNavigationSpanEvent !== "function") {
  throw new Error("missing CommonJS React Router helpers");
}
if (typeof react.captureReactRouterNavigation !== "function") {
  throw new Error("missing CommonJS React Router capture helper");
}
if (typeof reactBrowser.useLogBrewBrowserInstrumentation !== "function") {
  throw new Error("missing CommonJS React browser instrumentation helper");
}
if (!react.shouldPropagateTraceparent("https://api.example.test/ping", ["https://api.example.test/"])) {
  throw new Error("CommonJS trace target helper did not match");
}
const cjsClient = react.createLogBrewReactClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "cjs-react-smoke",
  sdkVersion: "0.1.0"
});
const cjsEvent = react.captureReactError(cjsClient, new Error("cjs react error"), {
  componentStack: "\n    at CjsComponent"
});
if (cjsEvent.attributes.metadata.source !== "react.error") {
  throw new Error("CommonJS React error helper did not attach source metadata");
}
const cjsAction = react.captureReactAction(cjsClient, {
  id: "evt_action_cjs",
  name: "cjs-action",
  timestamp: "2026-06-02T10:00:08Z"
});
if (cjsAction.attributes.metadata.source !== "react.action") {
  throw new Error("CommonJS React action helper did not attach source metadata");
}
const cjsNetwork = react.captureReactNetwork(cjsClient, {
  id: "evt_action_cjs_network",
  method: "POST",
  routeTemplate: "/api/cjs?email=hidden#receipt",
  statusCode: 503,
  timestamp: "2026-06-02T10:00:09Z"
});
if (cjsNetwork.attributes.metadata.routeTemplate !== "/api/cjs" || cjsNetwork.attributes.status !== "failure") {
  throw new Error("CommonJS React network helper did not sanitize route/status metadata");
}
EOF
node cjs-smoke.cjs

node node_modules/@logbrew/react/examples/index.mjs --help > "$tmp_dir/launcher-help.txt"
grep -q 'node node_modules/@logbrew/react/examples/index.mjs readme-example' "$tmp_dir/launcher-help.txt"
grep -q 'node node_modules/@logbrew/react/examples/index.mjs react-router-route-spans' "$tmp_dir/launcher-help.txt"
node node_modules/@logbrew/react/examples/index.mjs --list > "$tmp_dir/launcher-list.txt"
grep -q 'react-router-route-spans -> node node_modules/@logbrew/react/examples/index.mjs react-router-route-spans' "$tmp_dir/launcher-list.txt"
grep -q 'real-user-smoke -> node node_modules/@logbrew/react/examples/index.mjs real-user-smoke' "$tmp_dir/launcher-list.txt"
node node_modules/@logbrew/react/examples/index.mjs react-router-route-spans > "$tmp_dir/example-router.stdout.json" 2> "$tmp_dir/example-router.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/example-router.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/example-router.stderr.json"
grep -q '"attempts":2' "$tmp_dir/example-router.stderr.json"
grep -q '"routeTemplate":"/projects/:projectId/settings"' "$tmp_dir/example-router.stderr.json"
node node_modules/@logbrew/react/examples/index.mjs readme-example > "$tmp_dir/example-readme.stdout.json" 2> "$tmp_dir/example-readme.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/example-readme.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/example-readme.stdout.json" >/dev/null
grep -q '"rendered":true' "$tmp_dir/example-readme.stderr.json"
node node_modules/@logbrew/react/examples/index.mjs > "$tmp_dir/example-default.stdout.json" 2> "$tmp_dir/example-default.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/example-default.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/example-default.stdout.json" >/dev/null
grep -q '"attempts":2' "$tmp_dir/example-default.stderr.json"
grep -q '"manualErrorAttempts":2' "$tmp_dir/example-default.stderr.json"
grep -q '"manualErrorEvents":3' "$tmp_dir/example-default.stderr.json"
grep -q '"propagatedTraceparent":"00-0102030405060708090a0b0c0d0e0f10-0102030405060708-01"' "$tmp_dir/example-default.stderr.json"
npm --prefix node_modules/@logbrew/react/examples run list > "$tmp_dir/npm-helper-list.txt"
grep -q 'react-router-route-spans -> node node_modules/@logbrew/react/examples/index.mjs react-router-route-spans' "$tmp_dir/npm-helper-list.txt"
grep -q 'readme-example -> node node_modules/@logbrew/react/examples/index.mjs readme-example' "$tmp_dir/npm-helper-list.txt"
npm --prefix node_modules/@logbrew/react/examples run help > "$tmp_dir/npm-helper-help.txt"
grep -q 'npm --prefix node_modules/@logbrew/react/examples run react-router-route-spans' "$tmp_dir/npm-helper-help.txt"
grep -q 'npm --prefix node_modules/@logbrew/react/examples run real-user-smoke' "$tmp_dir/npm-helper-help.txt"
npm --prefix node_modules/@logbrew/react/examples run --silent react-router-route-spans > "$tmp_dir/npm-helper-router.stdout.json" 2> "$tmp_dir/npm-helper-router.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/npm-helper-router.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/npm-helper-router.stderr.json"
grep -q '"routeTemplate":"/projects/:projectId/settings"' "$tmp_dir/npm-helper-router.stderr.json"
npm --prefix node_modules/@logbrew/react/examples run --silent real-user-smoke > "$tmp_dir/npm-helper-smoke.stdout.json" 2> "$tmp_dir/npm-helper-smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/npm-helper-smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/npm-helper-smoke.stdout.json" >/dev/null
grep -q '"attempts":2' "$tmp_dir/npm-helper-smoke.stderr.json"
grep -q '"manualErrorAttempts":2' "$tmp_dir/npm-helper-smoke.stderr.json"
grep -q '"manualErrorEvents":3' "$tmp_dir/npm-helper-smoke.stderr.json"
grep -q '"propagatedTraceparent":"00-0102030405060708090a0b0c0d0e0f10-0102030405060708-01"' "$tmp_dir/npm-helper-smoke.stderr.json"

echo "react real-user smoke passed with react@$react_version react-dom@$react_dom_version react-test-renderer@$renderer_version"
