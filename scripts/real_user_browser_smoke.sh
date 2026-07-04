#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sdk_package_version="$(node -p "require('${repo_root}/js/logbrew-js/package.json').version")"
tmp_dir="$(mktemp -d)"

remove_tmp_dir() {
  rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT

core_pack_json="$tmp_dir/core-pack.json"
browser_pack_json="$tmp_dir/browser-pack.json"
(cd "$repo_root/js/logbrew-js" && npm pack --json --pack-destination "$tmp_dir") > "$core_pack_json"
(cd "$repo_root/js/logbrew-browser" && npm pack --json --pack-destination "$tmp_dir") > "$browser_pack_json"

core_tgz="$(python3 - "$core_pack_json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
print(payload[0]["filename"])
PY
)"
browser_tgz="$(python3 - "$browser_pack_json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
print(payload[0]["filename"])
PY
)"
core_tgz="$tmp_dir/$core_tgz"
browser_tgz="$tmp_dir/$browser_tgz"
test -f "$core_tgz"
test -f "$browser_tgz"

tar -tzf "$browser_tgz" > "$tmp_dir/browser-tarball.txt"
grep -q '^package/README.md$' "$tmp_dir/browser-tarball.txt"
grep -q '^package/beacon-transport.js$' "$tmp_dir/browser-tarball.txt"
grep -q '^package/beacon-transport.cjs$' "$tmp_dir/browser-tarball.txt"
grep -q '^package/fetch-spans.js$' "$tmp_dir/browser-tarball.txt"
grep -q '^package/fetch-spans.cjs$' "$tmp_dir/browser-tarball.txt"
grep -q '^package/interaction-timing.js$' "$tmp_dir/browser-tarball.txt"
grep -q '^package/interaction-timing.cjs$' "$tmp_dir/browser-tarball.txt"
grep -q '^package/index.js$' "$tmp_dir/browser-tarball.txt"
grep -q '^package/index.cjs$' "$tmp_dir/browser-tarball.txt"
grep -q '^package/navigation-timing.js$' "$tmp_dir/browser-tarball.txt"
grep -q '^package/navigation-timing.cjs$' "$tmp_dir/browser-tarball.txt"
grep -q '^package/persistence.js$' "$tmp_dir/browser-tarball.txt"
grep -q '^package/persistence.cjs$' "$tmp_dir/browser-tarball.txt"
grep -q '^package/resource-timing.js$' "$tmp_dir/browser-tarball.txt"
grep -q '^package/resource-timing.cjs$' "$tmp_dir/browser-tarball.txt"
grep -q '^package/trace-context.js$' "$tmp_dir/browser-tarball.txt"
grep -q '^package/trace-context.cjs$' "$tmp_dir/browser-tarball.txt"
grep -q '^package/web-vitals.js$' "$tmp_dir/browser-tarball.txt"
grep -q '^package/web-vitals.cjs$' "$tmp_dir/browser-tarball.txt"
grep -q '^package/xhr-spans.js$' "$tmp_dir/browser-tarball.txt"
grep -q '^package/xhr-spans.cjs$' "$tmp_dir/browser-tarball.txt"
grep -q '^package/index.d.ts$' "$tmp_dir/browser-tarball.txt"
grep -q '^package/index.d.cts$' "$tmp_dir/browser-tarball.txt"
grep -q '^package/examples/index.mjs$' "$tmp_dir/browser-tarball.txt"
grep -q '^package/examples/package.json$' "$tmp_dir/browser-tarball.txt"
grep -q '^package/examples/readme-example.mjs$' "$tmp_dir/browser-tarball.txt"
grep -q '^package/examples/real-user-smoke.mjs$' "$tmp_dir/browser-tarball.txt"
tar -xOf "$browser_tgz" package/README.md > "$tmp_dir/browser-readme.md"
grep -q 'npm install @logbrew/sdk @logbrew/browser' "$tmp_dir/browser-readme.md"
grep -q 'pnpm add @logbrew/sdk @logbrew/browser' "$tmp_dir/browser-readme.md"
grep -q 'LOGBREW_BROWSER_KEY' "$tmp_dir/browser-readme.md"
grep -q 'installLogBrewBrowser' "$tmp_dir/browser-readme.md"
grep -q 'installLogBrewBrowserNavigationInstrumentation' "$tmp_dir/browser-readme.md"
grep -q 'flushOnPageHide' "$tmp_dir/browser-readme.md"
grep -q 'flushOnVisibilityHidden' "$tmp_dir/browser-readme.md"
grep -q 'sanitizeMetadata' "$tmp_dir/browser-readme.md"
grep -q 'query string or hash' "$tmp_dir/browser-readme.md"
grep -q 'captureBrowserAction' "$tmp_dir/browser-readme.md"
grep -q 'captureBrowserNetwork' "$tmp_dir/browser-readme.md"
grep -q 'captureBrowserResourceTiming' "$tmp_dir/browser-readme.md"
grep -q 'installLogBrewBrowserResourceTimingInstrumentation' "$tmp_dir/browser-readme.md"
grep -q 'PerformanceObserver' "$tmp_dir/browser-readme.md"
grep -q 'captureBrowserNavigationTiming' "$tmp_dir/browser-readme.md"
grep -q 'installLogBrewBrowserNavigationTimingInstrumentation' "$tmp_dir/browser-readme.md"
grep -q 'PerformanceNavigationTiming' "$tmp_dir/browser-readme.md"
grep -q 'captureBrowserWebVital' "$tmp_dir/browser-readme.md"
grep -q 'installLogBrewBrowserWebVitalsInstrumentation' "$tmp_dir/browser-readme.md"
grep -q 'web-vitals' "$tmp_dir/browser-readme.md"
grep -q 'captureBrowserInteractionTiming' "$tmp_dir/browser-readme.md"
grep -q 'installLogBrewBrowserInteractionTimingInstrumentation' "$tmp_dir/browser-readme.md"
grep -q 'Interaction, Long-Task, and Long-Animation-Frame Timing Spans' "$tmp_dir/browser-readme.md"
grep -q 'long-animation-frame' "$tmp_dir/browser-readme.md"
grep -q 'createBeaconTransport' "$tmp_dir/browser-readme.md"
grep -q 'createPersistentBrowserTransport' "$tmp_dir/browser-readme.md"
grep -q 'persistOffline' "$tmp_dir/browser-readme.md"
grep -q 'sessionId' "$tmp_dir/browser-readme.md"
grep -q 'createTraceparentFetch' "$tmp_dir/browser-readme.md"
grep -q 'createLogBrewBrowserFetch' "$tmp_dir/browser-readme.md"
grep -q 'installLogBrewBrowserFetchInstrumentation' "$tmp_dir/browser-readme.md"
grep -q 'captureBrowserXhrSpan' "$tmp_dir/browser-readme.md"
grep -q 'installLogBrewBrowserXhrInstrumentation' "$tmp_dir/browser-readme.md"
grep -q 'createBrowserTraceContext' "$tmp_dir/browser-readme.md"
grep -q 'tracePropagationTargets' "$tmp_dir/browser-readme.md"
grep -q 'traceContext: () => logbrew.traceContext' "$tmp_dir/browser-readme.md"
grep -q 'history.pushState' "$tmp_dir/browser-readme.md"

app_dir="$tmp_dir/browser-smoke-app"
mkdir -p "$app_dir"
cd "$app_dir"
npm init -y >/dev/null
npm pkg set type=module >/dev/null
npm install \
  --save-exact \
  --no-audit \
  --fund=false \
  "$core_tgz" \
  "$browser_tgz" \
  happy-dom@20.10.1 \
  typescript \
  >/dev/null

grep -q '"@logbrew/sdk": "file:' package.json
grep -q '"@logbrew/browser": "file:' package.json
grep -q '"happy-dom":' package.json
grep -q '"@logbrew/browser"' package-lock.json
grep -q '"@logbrew/sdk"' package-lock.json
npm ls @logbrew/sdk @logbrew/browser happy-dom >/dev/null
npm explain @logbrew/browser > "$tmp_dir/npm-explain-browser.txt"
grep -q '@logbrew/browser@0.1.0' "$tmp_dir/npm-explain-browser.txt"
npm list --depth=0 > "$tmp_dir/npm-list-depth0.txt"
grep -q '@logbrew/browser@0.1.0' "$tmp_dir/npm-list-depth0.txt"
grep -q "@logbrew/sdk@${sdk_package_version}" "$tmp_dir/npm-list-depth0.txt"
npm list --json --depth=0 > "$tmp_dir/npm-list-depth0.json"
python3 - "$tmp_dir/npm-list-depth0.json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
deps = payload.get("dependencies", {})
for name in ("@logbrew/browser", "@logbrew/sdk", "happy-dom"):
    if name not in deps:
        raise SystemExit(f"missing npm dependency entry: {name}")
PY

cat > smoke.mjs <<'EOF'
import { Window } from "happy-dom";
import { RecordingTransport } from "@logbrew/sdk";
import {
  captureBrowserAction,
  captureBrowserInteractionTiming,
  captureBrowserNavigationTiming,
  captureBrowserXhrSpan,
  createLogBrewBrowserFetch,
  captureBrowserNetwork,
  captureBrowserResourceTiming,
  captureBrowserWebVital,
  createBrowserNavigationTimingEvent,
  createBrowserTraceContext,
  createBrowserXhrSpanEvent,
  createBeaconTransport,
  createFetchTransport,
  createLogBrewBrowserClient,
  createPersistentBrowserTransport,
  createTraceparentFetch,
  installLogBrewBrowser,
  installLogBrewBrowserFetchInstrumentation,
  installLogBrewBrowserInteractionTimingInstrumentation,
  installLogBrewBrowserNavigationInstrumentation,
  installLogBrewBrowserNavigationTimingInstrumentation,
  installLogBrewBrowserResourceTimingInstrumentation,
  installLogBrewBrowserWebVitalsInstrumentation,
  installLogBrewBrowserXhrInstrumentation,
  shouldPropagateTraceparent
} from "@logbrew/browser";

const browserWindow = new Window({
  url: "https://app.example.test/dashboard?email=dev@example.test#section"
});
browserWindow.document.title = "LogBrew Browser Smoke";

let tick = 0;
const transport = RecordingTransport.alwaysAccept();
const flushed = [];
const traceContext = createBrowserTraceContext({
  spanId: "00f067aa0ba902b7",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736"
});
const logbrew = installLogBrewBrowser({
  clientKey: "LOGBREW_BROWSER_KEY",
  browserWindow,
  now: nextTimestamp,
  onFlush(response) {
    flushed.push(response);
  },
  traceContext,
  transport
});

await waitFor(() => transport.sentBodies.length === 1);
const pagePayload = JSON.parse(transport.sentBodies[0]);
assertPathOnly(pagePayload, "/dashboard");
if (pagePayload.events[0].type !== "span") {
  throw new Error(`expected page view span: ${transport.sentBodies[0]}`);
}
if (pagePayload.events[0].attributes.metadata.documentTitle !== undefined) {
  throw new Error("document title should be opt-in");
}
if (pagePayload.events[0].attributes.metadata.userAgent !== undefined) {
  throw new Error("user agent should be opt-in");
}
if (pagePayload.events[0].attributes.traceId !== traceContext.traceId || pagePayload.events[0].attributes.spanId !== traceContext.spanId) {
  throw new Error(`expected shared page trace context: ${transport.sentBodies[0]}`);
}

await captureBrowserAction({
  name: "checkout.clicked",
  status: "success",
  metadata: {
    funnel: "checkout",
    ignoredNested: { email: "dev@example.test" },
    routeTemplate: "/dashboard",
    sessionId: "sess_browser_001",
    step: 2,
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736"
  }
}, logbrew);
await waitFor(() => transport.sentBodies.length === 2);
const actionPayload = JSON.parse(transport.sentBodies[1]);
assertPathOnly(actionPayload, "/dashboard");
if (actionPayload.events[0].type !== "action") {
  throw new Error(`expected browser action: ${transport.sentBodies[1]}`);
}
if (actionPayload.events[0].attributes.metadata.sessionId !== "sess_browser_001") {
  throw new Error(`expected session correlation metadata: ${transport.sentBodies[1]}`);
}
if (actionPayload.events[0].attributes.metadata.traceId !== traceContext.traceId || actionPayload.events[0].attributes.metadata.spanId !== traceContext.spanId) {
  throw new Error(`expected action trace correlation metadata: ${transport.sentBodies[1]}`);
}
if (actionPayload.events[0].attributes.metadata.ignoredNested !== undefined) {
  throw new Error(`nested action metadata should be dropped: ${transport.sentBodies[1]}`);
}

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
}, logbrew);
await waitFor(() => transport.sentBodies.length === 3);
const networkPayload = JSON.parse(transport.sentBodies[2]);
assertPathOnly(networkPayload, "/dashboard");
if (networkPayload.events[0].type !== "action") {
  throw new Error(`expected browser network action: ${transport.sentBodies[2]}`);
}
if (networkPayload.events[0].attributes.status !== "failure") {
  throw new Error(`expected failed network action: ${transport.sentBodies[2]}`);
}
if (networkPayload.events[0].attributes.metadata.routeTemplate !== "/api/checkout") {
  throw new Error(`expected query-free route template: ${transport.sentBodies[2]}`);
}
if (networkPayload.events[0].attributes.metadata.durationMs !== 842) {
  throw new Error(`expected network duration metadata: ${transport.sentBodies[2]}`);
}
if (networkPayload.events[0].attributes.metadata.traceId !== traceContext.traceId || networkPayload.events[0].attributes.metadata.spanId !== traceContext.spanId) {
  throw new Error(`expected network trace correlation metadata: ${transport.sentBodies[2]}`);
}
if (networkPayload.events[0].attributes.metadata.ignoredNested !== undefined) {
  throw new Error(`nested network metadata should be dropped: ${transport.sentBodies[2]}`);
}

const syncEvent = new browserWindow.ErrorEvent("error", {
  colno: 8,
  error: new Error("Checkout exploded"),
  filename: "https://cdn.example.test/assets/app.js?debug=1",
  lineno: 42,
  message: "Checkout exploded"
});
browserWindow.dispatchEvent(syncEvent);
await waitFor(() => transport.sentBodies.length === 4);
const syncPayload = JSON.parse(transport.sentBodies[3]);
assertPathOnly(syncPayload, "/dashboard");
if (syncPayload.events[0].attributes.metadata.sourcePath !== "/assets/app.js") {
  throw new Error(`source path should be sanitized: ${transport.sentBodies[3]}`);
}
if (syncEvent.defaultPrevented) {
  throw new Error("browser error default handling should remain enabled by default");
}

const rejectionEvent = new browserWindow.Event("unhandledrejection", { cancelable: true });
Object.defineProperty(rejectionEvent, "reason", {
  value: new Error("Async checkout failed")
});
browserWindow.dispatchEvent(rejectionEvent);
await waitFor(() => transport.sentBodies.length === 5);
const rejectionPayload = JSON.parse(transport.sentBodies[4]);
assertPathOnly(rejectionPayload, "/dashboard");
if (!rejectionPayload.events[0].attributes.title.includes("Unhandled promise rejection")) {
  throw new Error(`unexpected rejection title: ${transport.sentBodies[4]}`);
}
if (rejectionEvent.defaultPrevented) {
  throw new Error("unhandled rejection default handling should remain enabled by default");
}

logbrew.client.log("evt_browser_pagehide_001", "2026-06-02T10:00:04Z", {
  message: "queued before pagehide",
  level: "info",
  logger: "browser.lifecycle"
});
browserWindow.dispatchEvent(new browserWindow.Event("pagehide"));
await waitFor(() => transport.sentBodies.length === 6);
const pagehidePayload = JSON.parse(transport.sentBodies[5]);
if (pagehidePayload.events[0].id !== "evt_browser_pagehide_001") {
  throw new Error(`pagehide did not flush the queued event: ${transport.sentBodies[5]}`);
}

logbrew.client.log("evt_browser_hidden_001", "2026-06-02T10:00:05Z", {
  message: "queued before hidden visibility",
  level: "info",
  logger: "browser.lifecycle"
});
setVisibilityState(browserWindow.document, "hidden");
browserWindow.document.dispatchEvent(new browserWindow.Event("visibilitychange"));
await waitFor(() => transport.sentBodies.length === 7);
const hiddenPayload = JSON.parse(transport.sentBodies[6]);
if (hiddenPayload.events[0].id !== "evt_browser_hidden_001") {
  throw new Error(`hidden visibility did not flush the queued event: ${transport.sentBodies[6]}`);
}

logbrew.uninstall();
browserWindow.dispatchEvent(new browserWindow.ErrorEvent("error", {
  error: new Error("After uninstall"),
  message: "After uninstall"
}));
logbrew.client.log("evt_browser_after_uninstall_001", "2026-06-02T10:00:06Z", {
  message: "queued after uninstall",
  level: "info",
  logger: "browser.lifecycle"
});
browserWindow.dispatchEvent(new browserWindow.Event("pagehide"));
browserWindow.document.dispatchEvent(new browserWindow.Event("visibilitychange"));
await delay(10);
if (transport.sentBodies.length !== 7) {
  throw new Error("uninstall should remove browser listeners");
}
if (logbrew.client.pendingEvents() !== 1) {
  throw new Error("removed lifecycle listeners should leave manually queued events pending");
}
const afterUninstallResponse = await logbrew.flush();
if (afterUninstallResponse.statusCode !== 202 || transport.sentBodies.length !== 8) {
  throw new Error("manual flush after uninstall did not deliver pending work");
}
if (flushed.length !== 5) {
  throw new Error(`expected five lifecycle/capture flush callbacks, got ${flushed.length}`);
}

const fetchRequests = [];
const fetchTransport = createFetchTransport({
  endpoint: "https://api.logbrew.com/v1/events",
  fetchImpl: async (endpoint, init) => {
    fetchRequests.push({ endpoint, init });
    return { status: 202 };
  }
});
const fetchClient = createLogBrewBrowserClient({
  clientKey: "LOGBREW_BROWSER_KEY",
  sdkName: "browser-fetch-smoke",
  sdkVersion: "0.1.0"
});
fetchClient.log("evt_fetch_log_001", "2026-06-02T10:00:08Z", {
  message: "fetch transport ready",
  level: "info",
  logger: "browser"
});
const fetchResponse = await fetchClient.flush(fetchTransport);
if (fetchResponse.statusCode !== 202 || fetchRequests.length !== 1) {
  throw new Error("fetch transport did not return the expected response");
}
if (fetchRequests[0].init.method !== "POST" || fetchRequests[0].init.keepalive !== true) {
  throw new Error(`unexpected fetch options: ${JSON.stringify(fetchRequests[0].init)}`);
}
if (fetchRequests[0].init.headers.authorization !== "Bearer LOGBREW_BROWSER_KEY") {
  throw new Error("fetch transport did not attach the expected auth header");
}

const beaconCalls = [];
const beaconTransport = createBeaconTransport({
  endpoint: "https://app.example.test/logbrew/browser-beacon",
  fetchImpl: async () => {
    throw new Error("queued beacon smoke should not call fetch fallback");
  },
  sendBeacon(endpoint, payload) {
    beaconCalls.push({ endpoint, payload });
    return true;
  }
});
const beaconClient = createLogBrewBrowserClient({
  clientKey: "LOGBREW_BROWSER_KEY",
  sdkName: "browser-beacon-smoke",
  sdkVersion: "0.1.0"
});
beaconClient.log("evt_beacon_log_001", "2026-06-02T10:00:08Z", {
  message: "beacon transport ready",
  level: "info",
  logger: "browser"
});
const beaconResponse = await beaconClient.flush(beaconTransport);
const beaconPayload = await readBeaconPayload(beaconCalls[0].payload);
if (beaconResponse.statusCode !== 202 || beaconCalls.length !== 1) {
  throw new Error("beacon transport did not queue the expected response");
}
if (beaconCalls[0].endpoint !== "https://app.example.test/logbrew/browser-beacon") {
  throw new Error(`unexpected beacon endpoint: ${beaconCalls[0].endpoint}`);
}
if (beaconPayload.ingest_key !== "LOGBREW_BROWSER_KEY") {
  throw new Error("beacon envelope did not carry the expected browser key");
}
if (beaconPayload.envelope.events[0].id !== "evt_beacon_log_001") {
  throw new Error(`unexpected beacon envelope: ${JSON.stringify(beaconPayload)}`);
}

const directPersistentStorage = createMemoryStorage();
let directPersistentStatus = 503;
const directPersistentSends = [];
const directPersistentTransport = createPersistentBrowserTransport({
  storage: directPersistentStorage,
  transport: {
    async send(apiKey, body) {
      directPersistentSends.push({ apiKey, body });
      return { statusCode: directPersistentStatus };
    }
  }
});
const directPersistentBody = JSON.stringify({
  events: [{ id: "evt_browser_persisted_direct_001", type: "log" }],
  sdk: { name: "logbrew-browser", version: "0.1.0" }
});
await directPersistentTransport.send("LOGBREW_BROWSER_KEY", directPersistentBody);
const storedDirectPayload = directPersistentStorage.getItem("logbrew:browser:persisted-batches");
if (!storedDirectPayload || storedDirectPayload.includes("LOGBREW_BROWSER_KEY")) {
  throw new Error("persistent browser storage must retain the batch without storing the browser key");
}
directPersistentStatus = 202;
const directPersistentReplay = await directPersistentTransport.replayStoredBatches("LOGBREW_BROWSER_KEY");
if (directPersistentReplay.delivered !== 1 || directPersistentTransport.pendingStoredBatches() !== 0) {
  throw new Error(`direct persistent replay failed: ${JSON.stringify(directPersistentReplay)}`);
}

const persistentWindow = new Window({
  url: "https://app.example.test/offline?email=dev@example.test#retry"
});
const persistentStorage = createMemoryStorage();
let persistentStatus = 503;
const persistentSends = [];
const failingPersistentLogbrew = installLogBrewBrowser({
  browserWindow: persistentWindow,
  capturePageViews: false,
  clientKey: "LOGBREW_BROWSER_KEY",
  flushOnCapture: false,
  maxRetries: 0,
  persistOffline: {
    storage: persistentStorage
  },
  replayPersistedOnInstall: false,
  transport: {
    async send(apiKey, body) {
      persistentSends.push({ apiKey, body });
      return { statusCode: persistentStatus };
    }
  }
});
failingPersistentLogbrew.client.log("evt_browser_persisted_offline_001", "2026-06-02T10:00:09Z", {
  message: "queued before offline navigation",
  level: "warning",
  logger: "browser.offline",
  metadata: {
    routeTemplate: "/offline"
  }
});
await failingPersistentLogbrew.flush().catch((error) => {
  if (error?.code !== "transport_error") {
    throw error;
  }
});
failingPersistentLogbrew.uninstall();
const storedOnlinePayload = persistentStorage.getItem("logbrew:browser:persisted-batches");
if (!storedOnlinePayload || storedOnlinePayload.includes("LOGBREW_BROWSER_KEY")) {
  throw new Error("online replay storage must not contain the browser key");
}
persistentStatus = 202;
const onlinePersistentLogbrew = installLogBrewBrowser({
  browserWindow: persistentWindow,
  capturePageViews: false,
  clientKey: "LOGBREW_BROWSER_KEY",
  flushOnCapture: false,
  maxRetries: 0,
  persistOffline: {
    storage: persistentStorage
  },
  replayPersistedOnInstall: false,
  transport: {
    async send(apiKey, body) {
      persistentSends.push({ apiKey, body });
      return { statusCode: persistentStatus };
    }
  }
});
onlinePersistentLogbrew.client.log("evt_browser_after_online_001", "2026-06-02T10:00:10Z", {
  message: "queued after browser comes online",
  level: "info",
  logger: "browser.offline"
});
persistentWindow.dispatchEvent(new persistentWindow.Event("online"));
await waitFor(() => persistentSends.length === 3);
if (JSON.parse(persistentSends[1].body).events[0].id !== "evt_browser_persisted_offline_001") {
  throw new Error("online replay should deliver persisted batch before live queue");
}
if (JSON.parse(persistentSends[2].body).events[0].id !== "evt_browser_after_online_001") {
  throw new Error("online replay should flush the live queue after persisted batches");
}
if (persistentStorage.getItem("logbrew:browser:persisted-batches") !== null) {
  throw new Error("persistent browser storage should clear after successful replay");
}
onlinePersistentLogbrew.uninstall();

const tracedFetchRequests = [];
const tracedFetch = createTraceparentFetch({
  fetchImpl: async (input, init = {}) => {
    tracedFetchRequests.push({ input, init });
    return { status: 204 };
  },
  traceContext: logbrew.traceContext,
  tracePropagationTargets: ["https://api.example.test/", /^\/internal\//u]
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
await tracedFetch("/internal/ping");
if (tracedFetchRequests.length !== 3) {
  throw new Error(`expected three traced fetch calls, got ${tracedFetchRequests.length}`);
}
const propagatedTraceparent = tracedFetchRequests[0].init.headers.traceparent;
if (propagatedTraceparent !== `00-${traceContext.traceId}-${traceContext.spanId}-01`) {
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

const browserFetchWindow = new Window({
  url: "https://app.example.test/fetch?email=dev@example.test#panel"
});
const browserFetchTraceContext = createBrowserTraceContext({
  spanId: "00f067aa0ba902b7",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736"
});
const browserFetchContext = installLogBrewBrowser({
  browserWindow: browserFetchWindow,
  capturePageViews: false,
  clientKey: "LOGBREW_BROWSER_KEY",
  flushOnCapture: false,
  traceContext: browserFetchTraceContext,
  transport: RecordingTransport.alwaysAccept()
});
const browserFetchCalls = [];
const browserFetch = createLogBrewBrowserFetch(browserFetchContext, {
  fetchImpl: async (input, init = {}) => {
    browserFetchCalls.push({ input, init });
    return {
      headers: new Headers({ "content-length": "456" }),
      status: 503
    };
  },
  flushOnCapture: false,
  now: () => "2026-06-02T10:00:11Z",
  nowMs: sequenceNumbers([1000, 1088.5]),
  randomValues: () => fillBytes(8, 0x99),
  resourcePathTemplate: "/api/orders/:id",
  tracePropagationTargets: [/^https:\/\/api\.example\.test\/api\//u]
});
await browserFetch("https://api.example.test/api/orders/123?email=dev@example.test#fragment", {
  body: "masked body",
  headers: { accept: "application/json" },
  method: "POST"
});
const browserFetchPayload = JSON.parse(browserFetchContext.previewJson());
const browserFetchBody = JSON.stringify(browserFetchPayload);
const browserFetchSpan = browserFetchPayload.events[0];
if (browserFetchCalls[0].init.headers.traceparent !== `00-${browserFetchTraceContext.traceId}-9999999999999999-01`) {
  throw new Error(`expected fetch span traceparent, got ${browserFetchCalls[0].init.headers.traceparent}`);
}
if (browserFetchSpan.attributes.name !== "browser.fetch POST /api/orders/:id") {
  throw new Error(`unexpected fetch span name: ${browserFetchBody}`);
}
if (browserFetchSpan.attributes.traceId !== browserFetchTraceContext.traceId || browserFetchSpan.attributes.parentSpanId !== browserFetchTraceContext.spanId) {
  throw new Error(`expected fetch child span correlation, got ${browserFetchBody}`);
}
if (browserFetchSpan.attributes.status !== "error" || browserFetchSpan.attributes.metadata.statusCode !== 503) {
  throw new Error(`expected failed fetch status metadata, got ${browserFetchBody}`);
}
if (browserFetchSpan.attributes.metadata.responseBodySize !== 456 || browserFetchSpan.attributes.durationMs !== 88.5) {
  throw new Error(`expected bounded fetch timing and size metadata, got ${browserFetchBody}`);
}
if (browserFetchBody.includes("api.example.test") || browserFetchBody.includes("email=dev@example.test") || browserFetchBody.includes("#fragment") || browserFetchBody.includes("masked body") || browserFetchBody.includes("application/json")) {
  throw new Error(`fetch span metadata leaked request details: ${browserFetchBody}`);
}

let browserFetchFailureCaptured = false;
const browserFetchFailureError = new TypeError("Failed to fetch hidden query");
const failingBrowserFetch = createLogBrewBrowserFetch(browserFetchContext, {
  fetchImpl: async () => {
    throw browserFetchFailureError;
  },
  flushOnCapture: false,
  now: () => "2026-06-02T10:00:12Z",
  nowMs: sequenceNumbers([2000, 2007]),
  randomValues: () => fillBytes(8, 0x98)
});
try {
  await failingBrowserFetch("/api/profile/42?sample=hidden", { method: "PATCH" });
} catch (error) {
  browserFetchFailureCaptured = error === browserFetchFailureError;
}
if (!browserFetchFailureCaptured) {
  throw new Error("fetch wrapper should rethrow the original network error");
}
const browserFetchFailureBody = JSON.stringify(JSON.parse(browserFetchContext.previewJson()).events.at(-1));
if (!browserFetchFailureBody.includes('"errorType":"TypeError"') || browserFetchFailureBody.includes("sample=hidden") || browserFetchFailureBody.includes("hidden query")) {
  throw new Error(`fetch failure span should keep only the error type: ${browserFetchFailureBody}`);
}

const originalWindowFetch = async () => ({ headers: new Headers(), status: 202 });
browserFetchWindow.fetch = originalWindowFetch;
const browserFetchInstrumentation = installLogBrewBrowserFetchInstrumentation(browserFetchContext, {
  flushOnCapture: false,
  now: () => "2026-06-02T10:00:13Z",
  nowMs: sequenceNumbers([3000, 3012]),
  randomValues: () => fillBytes(8, 0x97),
  resourcePathTemplate({ path }) {
    return path.replace(/\/\d+$/u, "/:id");
  }
});
if (browserFetchWindow.fetch === originalWindowFetch) {
  throw new Error("fetch instrumentation should patch only after explicit install");
}
await browserFetchWindow.fetch("/api/accounts/123", { method: "GET" });
browserFetchInstrumentation.uninstall();
if (browserFetchWindow.fetch !== originalWindowFetch) {
  throw new Error("fetch instrumentation should restore the original fetch");
}
if (!JSON.stringify(JSON.parse(browserFetchContext.previewJson()).events.at(-1)).includes("browser.fetch GET /api/accounts/:id")) {
  throw new Error("fetch instrumentation did not capture the route-templated fetch span");
}

const browserXhrWindow = new Window({
  url: "https://app.example.test/xhr?email=dev@example.test#panel"
});
const BrowserSmokeXhr = createFakeXMLHttpRequestClass();
browserXhrWindow.XMLHttpRequest = BrowserSmokeXhr;
const browserXhrTraceContext = createBrowserTraceContext({
  spanId: "00f067aa0ba902b7",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736"
});
const browserXhrContext = installLogBrewBrowser({
  browserWindow: browserXhrWindow,
  capturePageViews: false,
  clientKey: "LOGBREW_BROWSER_KEY",
  flushOnCapture: false,
  traceContext: browserXhrTraceContext,
  transport: RecordingTransport.alwaysAccept()
});
const originalXhrOpen = BrowserSmokeXhr.prototype.open;
const originalXhrSend = BrowserSmokeXhr.prototype.send;
const browserXhrInstrumentation = installLogBrewBrowserXhrInstrumentation(browserXhrContext, {
  flushOnCapture: false,
  now: () => "2026-06-02T10:00:14Z",
  nowMs: sequenceNumbers([4000, 4014.5]),
  randomValues: () => fillBytes(8, 0x96),
  resourcePathTemplate: "/api/orders/:id",
  tracePropagationTargets: [/^https:\/\/api\.example\.test\/api\//u],
  XMLHttpRequest: BrowserSmokeXhr
});
const browserXhr = new browserXhrWindow.XMLHttpRequest();
browserXhr.open("POST", "https://api.example.test/api/orders/123?email=dev@example.test#fragment");
browserXhr.setRequestHeader("accept", "application/json");
browserXhr.send("masked body");
browserXhr.status = 503;
browserXhr.setResponseHeader("content-length", "456");
browserXhr.dispatchEvent({ type: "load" });
const browserXhrPayload = JSON.parse(browserXhrContext.previewJson());
const browserXhrBody = JSON.stringify(browserXhrPayload);
const browserXhrSpan = browserXhrPayload.events[0];
if (browserXhr.requestHeaders.traceparent !== `00-${browserXhrTraceContext.traceId}-9696969696969696-01`) {
  throw new Error(`expected XHR span traceparent, got ${browserXhr.requestHeaders.traceparent}`);
}
if (browserXhrSpan.attributes.name !== "browser.xhr POST /api/orders/:id") {
  throw new Error(`unexpected XHR span name: ${browserXhrBody}`);
}
if (browserXhrSpan.attributes.traceId !== browserXhrTraceContext.traceId || browserXhrSpan.attributes.parentSpanId !== browserXhrTraceContext.spanId) {
  throw new Error(`expected XHR child span correlation, got ${browserXhrBody}`);
}
if (browserXhrSpan.attributes.status !== "error" || browserXhrSpan.attributes.metadata.statusCode !== 503) {
  throw new Error(`expected failed XHR status metadata, got ${browserXhrBody}`);
}
if (browserXhrSpan.attributes.metadata.responseBodySize !== 456 || browserXhrSpan.attributes.durationMs !== 14.5) {
  throw new Error(`expected bounded XHR timing and size metadata, got ${browserXhrBody}`);
}
if (browserXhrBody.includes("api.example.test") || browserXhrBody.includes("email=dev@example.test") || browserXhrBody.includes("#fragment") || browserXhrBody.includes("masked body") || browserXhrBody.includes("application/json")) {
  throw new Error(`XHR span metadata leaked request details: ${browserXhrBody}`);
}
const browserXhrFailure = new browserXhrWindow.XMLHttpRequest();
browserXhrFailure.open("PATCH", "/api/profile/42?sample=hidden");
browserXhrFailure.send("hidden body");
browserXhrFailure.dispatchEvent({ type: "timeout" });
const browserXhrFailureBody = JSON.stringify(JSON.parse(browserXhrContext.previewJson()).events.at(-1));
if (!browserXhrFailureBody.includes('"errorType":"timeout"') || browserXhrFailureBody.includes("sample=hidden") || browserXhrFailureBody.includes("hidden body")) {
  throw new Error(`XHR failure span should keep only the event type: ${browserXhrFailureBody}`);
}
browserXhrInstrumentation.uninstall();
if (BrowserSmokeXhr.prototype.open !== originalXhrOpen || BrowserSmokeXhr.prototype.send !== originalXhrSend) {
  throw new Error("XHR instrumentation should restore the original methods");
}
const browserXhrDirect = createBrowserXhrSpanEvent({
  durationMs: 11,
  method: "GET",
  statusCode: 202,
  url: "https://api.example.test/api/accounts/123?sample=hidden"
}, browserXhrWindow, {
  resourcePathTemplate: "/api/accounts/:id"
});
if (browserXhrDirect.attributes.name !== "browser.xhr GET /api/accounts/:id") {
  throw new Error(`unexpected direct XHR span: ${JSON.stringify(browserXhrDirect)}`);
}
await captureBrowserXhrSpan({
  durationMs: 9,
  method: "DELETE",
  statusCode: 204,
  url: "/api/accounts/123?sample=hidden"
}, browserXhrContext, {
  flushOnCapture: false,
  resourcePathTemplate: ({ path }) => path.replace(/\/\d+$/u, "/:id")
});
if (!JSON.stringify(JSON.parse(browserXhrContext.previewJson()).events.at(-1)).includes("browser.xhr DELETE /api/accounts/:id")) {
  throw new Error("direct XHR capture did not capture the route-templated span");
}

const resourceWindow = new Window({
  url: "https://app.example.test/resources?email=dev@example.test#panel"
});
const resourceTraceContext = createBrowserTraceContext({
  spanId: "00f067aa0ba902b7",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736"
});
const resourceContext = installLogBrewBrowser({
  browserWindow: resourceWindow,
  capturePageViews: false,
  clientKey: "LOGBREW_BROWSER_KEY",
  flushOnCapture: false,
  traceContext: resourceTraceContext,
  transport: RecordingTransport.alwaysAccept()
});
await captureBrowserResourceTiming(createResourceTimingEntry(), resourceContext, {
  flushOnCapture: false,
  now: () => "2026-06-02T10:00:11Z",
  randomValues: () => fillBytes(8, 0x77),
  resourcePathTemplate: "/api/orders/:id"
});
const fakeResourceObserver = createFakePerformanceObserver();
const resourceInstrumentation = installLogBrewBrowserResourceTimingInstrumentation(resourceContext, {
  flushOnCapture: false,
  now: () => "2026-06-02T10:00:12Z",
  performanceObserver: fakeResourceObserver.PerformanceObserver,
  randomValues: () => fillBytes(8, 0x88),
  resourcePathTemplate: ({ path }) => path.replace(/\/\d+$/u, "/:id")
});
fakeResourceObserver.emit([createResourceTimingEntry(), { entryType: "mark", name: "ignore-me" }]);
resourceInstrumentation.uninstall();
const resourcePayload = JSON.parse(resourceContext.previewJson());
const resourceBody = JSON.stringify(resourcePayload);
const resourceSpans = resourcePayload.events.filter((event) => event.type === "span");
if (resourceSpans.length !== 2) {
  throw new Error(`expected direct and observed resource spans, got ${resourceBody}`);
}
if (fakeResourceObserver.observedOptions().type !== "resource" || fakeResourceObserver.disconnected() !== true) {
  throw new Error("resource timing observer should be opt-in and reversible");
}
if (resourceBody.includes("api.example.test") || resourceBody.includes("sample=masked") || resourceBody.includes("#fragment")) {
  throw new Error(`resource timing metadata leaked URL details: ${resourceBody}`);
}
if (resourceSpans[0].attributes.name !== "browser.resource fetch /api/orders/:id") {
  throw new Error(`unexpected resource span name: ${resourceBody}`);
}
if (resourceSpans[0].attributes.traceId !== resourceTraceContext.traceId || resourceSpans[0].attributes.parentSpanId !== resourceTraceContext.spanId) {
  throw new Error(`expected resource child span correlation, got ${resourceBody}`);
}
if (resourceSpans[0].attributes.status !== "error" || resourceSpans[0].attributes.metadata.statusCode !== 503) {
  throw new Error(`expected failed resource timing status metadata, got ${resourceBody}`);
}
if (resourceSpans[0].attributes.metadata.lookupMs !== 5 || resourceSpans[0].attributes.metadata.responseMs !== 50) {
  throw new Error(`expected bounded resource phase timings, got ${resourceBody}`);
}

const documentTimingWindow = new Window({
  url: "https://app.example.test/products/42?email=dev@example.test#reviews"
});
Object.defineProperty(documentTimingWindow.document, "readyState", {
  configurable: true,
  value: "complete"
});
const documentTimingTraceContext = createBrowserTraceContext({
  spanId: "00f067aa0ba902b7",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736"
});
const documentTimingContext = installLogBrewBrowser({
  browserWindow: documentTimingWindow,
  capturePageViews: false,
  clientKey: "LOGBREW_BROWSER_KEY",
  flushOnCapture: false,
  traceContext: documentTimingTraceContext,
  transport: RecordingTransport.alwaysAccept()
});
const documentTimingEvent = createBrowserNavigationTimingEvent(createNavigationTimingEntry(), documentTimingWindow, {
  navigationPathTemplate: "/products/:id",
  randomValues: () => fillBytes(8, 0x33),
  traceContext: documentTimingTraceContext
});
if (documentTimingEvent.attributes.name !== "browser.document /products/:id") {
  throw new Error(`unexpected document timing event name: ${JSON.stringify(documentTimingEvent)}`);
}
await captureBrowserNavigationTiming(createNavigationTimingEntry(), documentTimingContext, {
  flushOnCapture: false,
  navigationPathTemplate: "/products/:id",
  now: () => "2026-06-02T10:00:13Z",
  randomValues: () => fillBytes(8, 0x33)
});
const documentTimingInstrumentation = installLogBrewBrowserNavigationTimingInstrumentation(documentTimingContext, {
  deferAfterLoad: false,
  entry: createNavigationTimingEntry({
    name: "https://app.example.test/products/99?sample=masked#details"
  }),
  flushOnCapture: false,
  navigationPathTemplate({ path }) {
    return path.replace(/\/\d+$/u, "/:id");
  },
  now: () => "2026-06-02T10:00:14Z",
  randomValues: () => fillBytes(8, 0x44)
});
documentTimingInstrumentation.uninstall();
const documentTimingPayload = JSON.parse(documentTimingContext.previewJson());
const documentTimingBody = JSON.stringify(documentTimingPayload);
const documentTimingSpans = documentTimingPayload.events.filter((event) => event.type === "span");
if (documentTimingSpans.length !== 2) {
  throw new Error(`expected direct and installed document timing spans, got ${documentTimingBody}`);
}
if (documentTimingBody.includes("app.example.test") || documentTimingBody.includes("email=dev@example.test") || documentTimingBody.includes("sample=masked") || documentTimingBody.includes("#reviews")) {
  throw new Error(`document timing metadata leaked URL details: ${documentTimingBody}`);
}
if (documentTimingSpans[0].attributes.traceId !== documentTimingTraceContext.traceId || documentTimingSpans[0].attributes.parentSpanId !== documentTimingTraceContext.spanId) {
  throw new Error(`expected document timing child span correlation, got ${documentTimingBody}`);
}
if (documentTimingSpans[0].attributes.metadata.firstByteMs !== 120 || documentTimingSpans[0].attributes.metadata.loadEventMs !== 384.123) {
  throw new Error(`expected document timing phase metadata, got ${documentTimingBody}`);
}

const webVitalWindow = new Window({
  url: "https://app.example.test/checkout/42?email=dev@example.test#pay"
});
const webVitalTraceContext = createBrowserTraceContext({
  spanId: "00f067aa0ba902b7",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736"
});
const webVitalContext = installLogBrewBrowser({
  browserWindow: webVitalWindow,
  capturePageViews: false,
  clientKey: "LOGBREW_BROWSER_KEY",
  flushOnCapture: false,
  traceContext: webVitalTraceContext,
  transport: RecordingTransport.alwaysAccept()
});
await captureBrowserWebVital(createWebVitalMetric(), webVitalContext, {
  flushOnCapture: false,
  now: () => "2026-06-02T10:00:15Z",
  randomValues: () => fillBytes(8, 0x66),
  webVitalPathTemplate: "/checkout/:id"
});
const webVitalCallbacks = {};
const webVitalUnregistered = [];
const webVitalInstrumentation = installLogBrewBrowserWebVitalsInstrumentation(webVitalContext, {
  flushOnCapture: false,
  metricNames: ["CLS"],
  now: () => "2026-06-02T10:00:16Z",
  randomValues: () => fillBytes(8, 0x77),
  webVitalPathTemplate: "/checkout/:id",
  webVitals: {
    onCLS(callback) {
      webVitalCallbacks.CLS = callback;
      return () => webVitalUnregistered.push("CLS");
    }
  }
});
webVitalCallbacks.CLS({
  attribution: {
    largestShiftTarget: "main form",
    loadState: "complete"
  },
  delta: 0.02,
  id: "v4-cls",
  name: "CLS",
  navigationType: "navigate",
  rating: "poor",
  value: 0.12345
});
webVitalInstrumentation.uninstall();
webVitalCallbacks.CLS({
  id: "after-uninstall",
  name: "CLS",
  value: 0.3
});
const webVitalPayload = JSON.parse(webVitalContext.previewJson());
const webVitalBody = JSON.stringify(webVitalPayload);
const webVitalSpans = webVitalPayload.events.filter((event) => event.type === "span");
if (webVitalSpans.length !== 2) {
  throw new Error(`expected direct and installed Web Vital spans, got ${webVitalBody}`);
}
if (webVitalSpans[0].attributes.name !== "browser.web_vital LCP /checkout/:id") {
  throw new Error(`unexpected Web Vital LCP span name: ${webVitalBody}`);
}
if (webVitalSpans[0].attributes.traceId !== webVitalTraceContext.traceId || webVitalSpans[0].attributes.parentSpanId !== webVitalTraceContext.spanId) {
  throw new Error(`expected Web Vital child span correlation, got ${webVitalBody}`);
}
if (webVitalSpans[0].attributes.metadata.metricValue !== 2480.456 || webVitalSpans[0].attributes.metadata.timeToFirstByteMs !== 121.5) {
  throw new Error(`expected Web Vital metric metadata, got ${webVitalBody}`);
}
if (webVitalSpans[1].attributes.name !== "browser.web_vital CLS /checkout/:id") {
  throw new Error(`unexpected Web Vital CLS span name: ${webVitalBody}`);
}
if (webVitalSpans[1].attributes.durationMs !== undefined || webVitalSpans[1].attributes.metadata.metricUnit !== "score") {
  throw new Error(`expected unitless CLS metadata, got ${webVitalBody}`);
}
if (webVitalUnregistered.length !== 1 || webVitalUnregistered[0] !== "CLS") {
  throw new Error("Web Vital instrumentation should call app-owned unregister callbacks");
}
if (webVitalBody.includes("cdn.example.test") || webVitalBody.includes("email=dev@example.test") || webVitalBody.includes("hero.jpg") || webVitalBody.includes("main form") || webVitalBody.includes("after-uninstall")) {
  throw new Error(`Web Vital metadata leaked private attribution details: ${webVitalBody}`);
}

const interactionWindow = new Window({
  url: "https://app.example.test/products/42?email=dev@example.test#reviews"
});
const interactionTraceContext = createBrowserTraceContext({
  spanId: "00f067aa0ba902b7",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736"
});
const interactionContext = installLogBrewBrowser({
  browserWindow: interactionWindow,
  capturePageViews: false,
  clientKey: "LOGBREW_BROWSER_KEY",
  flushOnCapture: false,
  traceContext: interactionTraceContext,
  transport: RecordingTransport.alwaysAccept()
});
await captureBrowserInteractionTiming(createInteractionTimingEntry(), interactionContext, {
  flushOnCapture: false,
  interactionPathTemplate: "/products/:id",
  now: () => "2026-06-02T10:00:17Z",
  randomValues: () => fillBytes(8, 0x88)
});
await captureBrowserInteractionTiming(createLongAnimationFrameEntry(), interactionContext, {
  flushOnCapture: false,
  interactionPathTemplate: "/products/:id",
  now: () => "2026-06-02T10:00:17Z",
  randomValues: () => fillBytes(8, 0x89)
});
const fakeInteractionObserver = createFakePerformanceObserver();
const interactionInstrumentation = installLogBrewBrowserInteractionTimingInstrumentation(interactionContext, {
  flushOnCapture: false,
  interactionPathTemplate: "/products/:id",
  now: () => "2026-06-02T10:00:18Z",
  performanceObserver: fakeInteractionObserver.PerformanceObserver,
  randomValues: sequenceRandomValues([
    fillBytes(8, 0x99),
    fillBytes(8, 0xaa)
  ])
});
const interactionObservedOptions = fakeInteractionObserver.observedOptionsList();
if (interactionObservedOptions.length !== 2 || interactionObservedOptions[0].type !== "event" || interactionObservedOptions[0].durationThreshold !== 40 || interactionObservedOptions[1].type !== "longtask") {
  throw new Error(`unexpected interaction timing observer options: ${JSON.stringify(interactionObservedOptions)}`);
}
fakeInteractionObserver.emit([createInteractionTimingEntry(), createLongTaskEntry(), { entryType: "resource", name: "ignore-me" }]);
interactionInstrumentation.uninstall();
fakeInteractionObserver.emit([createInteractionTimingEntry()]);
if (fakeInteractionObserver.disconnectedCount() !== 2) {
  throw new Error("interaction timing instrumentation should disconnect both observers");
}
const interactionPayload = JSON.parse(interactionContext.previewJson());
const interactionBody = JSON.stringify(interactionPayload);
const interactionSpans = interactionPayload.events.filter((event) => event.type === "span");
if (interactionSpans.length !== 4) {
  throw new Error(`expected direct interaction, direct LoAF, observed interaction, and long-task spans, got ${interactionBody}`);
}
if (interactionSpans[0].attributes.name !== "browser.interaction click /products/:id") {
  throw new Error(`unexpected direct interaction span name: ${interactionBody}`);
}
if (interactionSpans[0].attributes.traceId !== interactionTraceContext.traceId || interactionSpans[0].attributes.parentSpanId !== interactionTraceContext.spanId) {
  throw new Error(`expected direct interaction child span correlation, got ${interactionBody}`);
}
if (interactionSpans[0].attributes.metadata.interactionId !== 91 || interactionSpans[0].attributes.metadata.inputDelayMs !== 20) {
  throw new Error(`expected interaction timing metadata, got ${interactionBody}`);
}
if (interactionSpans[1].attributes.name !== "browser.long_animation_frame /products/:id") {
  throw new Error(`expected long-animation-frame span name, got ${interactionBody}`);
}
if (interactionSpans[1].attributes.metadata.blockingDurationMs !== 45 || interactionSpans[1].attributes.metadata.scriptCount !== 2) {
  throw new Error(`expected long-animation-frame aggregate metadata, got ${interactionBody}`);
}
if (interactionSpans[3].attributes.name !== "browser.long_task /products/:id" || interactionSpans[3].attributes.metadata.taskName !== "self") {
  throw new Error(`expected long-task timing metadata, got ${interactionBody}`);
}
if (interactionBody.includes("button.checkout") || interactionBody.includes("cdn.example.test") || interactionBody.includes("iframe-private") || interactionBody.includes("renderCheckout") || interactionBody.includes("email=dev@example.test") || interactionBody.includes("#reviews")) {
  throw new Error(`interaction timing metadata leaked private attribution details: ${interactionBody}`);
}

const navigationWindow = new Window({
  url: "https://app.example.test/start?sample=1#hash"
});
const navigationContext = installLogBrewBrowser({
  browserWindow: navigationWindow,
  capturePageViews: false,
  clientKey: "LOGBREW_BROWSER_KEY",
  flushOnCapture: false,
  traceContext: createBrowserTraceContext({
    spanId: "00f067aa0ba902b7",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736"
  }),
  transport: RecordingTransport.alwaysAccept()
});
const navigationInstrumentation = installLogBrewBrowserNavigationInstrumentation(navigationContext, {
  flushOnCapture: false,
  randomValues: sequenceRandomValues([
    fillBytes(8, 0x22),
    fillBytes(16, 0x11)
  ])
});
navigationWindow.history.pushState({ marker: "drop" }, "", "/account?sample=1#panel");
await captureBrowserAction({
  name: "account.loaded",
  metadata: {
    ignoredNested: { marker: "drop" },
    routeTemplate: "/account"
  }
}, navigationContext, {
  flushOnCapture: false
});
const navigationRequests = [];
const navigationFetch = createTraceparentFetch({
  fetchImpl: async (input, init = {}) => {
    navigationRequests.push({ input, init });
    return { status: 204 };
  },
  traceContext: () => navigationContext.traceContext,
  tracePropagationTargets: [/^\/api\//u]
});
await navigationFetch("/api/account?sample=1");
navigationInstrumentation.uninstall();
navigationWindow.history.pushState({}, "", "/after-uninstall?sample=1#hash");
const navigationPayload = JSON.parse(navigationContext.previewJson());
const navigationSpan = navigationPayload.events.find((event) => event.type === "span");
const navigationAction = navigationPayload.events.find((event) => event.type === "action");
const navigationBody = JSON.stringify(navigationPayload);
if (navigationPayload.events.length !== 2) {
  throw new Error(`expected navigation span plus action only: ${navigationBody}`);
}
if (navigationBody.includes("sample=1") || navigationBody.includes("#panel")) {
  throw new Error(`navigation instrumentation leaked URL details: ${navigationBody}`);
}
if (navigationSpan.attributes.metadata.path !== "/account") {
  throw new Error(`expected navigation path, got ${navigationBody}`);
}
if (navigationSpan.attributes.metadata.previousPath !== "/start") {
  throw new Error(`expected previous navigation path, got ${navigationBody}`);
}
if (navigationSpan.attributes.metadata.navigationType !== "pushState") {
  throw new Error(`expected pushState navigation metadata, got ${navigationBody}`);
}
if (navigationSpan.attributes.traceId !== "11111111111111111111111111111111" || navigationSpan.attributes.spanId !== "2222222222222222") {
  throw new Error(`expected renewed navigation trace context, got ${navigationBody}`);
}
if (navigationAction.attributes.metadata.traceId !== navigationSpan.attributes.traceId || navigationAction.attributes.metadata.spanId !== navigationSpan.attributes.spanId) {
  throw new Error(`expected action to use route trace context, got ${navigationBody}`);
}
if (navigationAction.attributes.metadata.ignoredNested !== undefined) {
  throw new Error(`nested navigation action metadata should be dropped: ${navigationBody}`);
}
const navigationTraceparent = navigationRequests[0].init.headers.traceparent;
if (navigationTraceparent !== "00-11111111111111111111111111111111-2222222222222222-01") {
  throw new Error(`expected dynamic route traceparent, got ${navigationTraceparent}`);
}

const fullClient = createLogBrewBrowserClient({
  clientKey: "LOGBREW_BROWSER_KEY",
  sdkName: "browser-smoke-app",
  sdkVersion: "0.1.0",
  maxRetries: 1
});
addFullBatch(fullClient);
const preview = fullClient.previewJson();
const fullResponse = await fullClient.shutdown(new RecordingTransport([{ statusCode: 503 }, { statusCode: 202 }]));
console.log(preview);
console.error(JSON.stringify({
  ok: true,
  beaconEnvelope: beaconPayload.envelope.events[0].id,
  browserDeliveries: transport.sentBodies.length,
  documentTimingSpan: documentTimingSpans[0].attributes.name,
  events: JSON.parse(preview).events.length,
  fetchSpan: browserFetchSpan.attributes.name,
  fetchStatus: fetchResponse.statusCode,
  fullAttempts: fullResponse.attempts,
  hiddenFlush: hiddenPayload.events[0].id,
  interactionSpan: interactionSpans[0].attributes.name,
  longAnimationFrameSpan: interactionSpans[1].attributes.name,
  longTaskSpan: interactionSpans[3].attributes.name,
  networkRoute: networkPayload.events[0].attributes.metadata.routeTemplate,
  navigationPath: navigationSpan.attributes.metadata.path,
  navigationTraceparent,
  pagePath: pagePayload.events[0].attributes.metadata.path,
  pagehideFlush: pagehidePayload.events[0].id,
  persistedDirectReplay: directPersistentReplay.delivered,
  persistedOnlineSends: persistentSends.length,
  propagatedTraceparent,
  rejectionTitle: rejectionPayload.events[0].attributes.title,
  resourceSpan: resourceSpans[0].attributes.name,
  sessionAction: actionPayload.events[0].attributes.metadata.sessionId,
  syncTitle: syncPayload.events[0].attributes.title,
  xhrSpan: browserXhrSpan.attributes.name
}));

async function readBeaconPayload(payload) {
  if (payload && typeof payload.text === "function") {
    return JSON.parse(await payload.text());
  }
  return JSON.parse(String(payload));
}

function addFullBatch(logbrew) {
  logbrew.release("evt_release_001", "2026-06-02T10:00:00Z", {
    version: "1.2.3",
    commit: "abc123def456",
    notes: "Public release marker"
  });
  logbrew.environment("evt_environment_001", "2026-06-02T10:00:01Z", {
    name: "production",
    region: "global"
  });
  logbrew.issue("evt_issue_001", "2026-06-02T10:00:02Z", {
    title: "Checkout timeout",
    level: "error",
    message: "Request timed out after retry budget"
  });
  logbrew.log("evt_log_001", "2026-06-02T10:00:03Z", {
    message: "worker started",
    level: "info",
    logger: "job-runner"
  });
  logbrew.span("evt_span_001", "2026-06-02T10:00:04Z", {
    name: "GET /health",
    traceId: "trace_001",
    spanId: "span_001",
    status: "ok",
    durationMs: 12.5
  });
  logbrew.action("evt_action_001", "2026-06-02T10:00:05Z", {
    name: "deploy",
    status: "success"
  });
}

function assertPathOnly(payload, expectedPath) {
  const body = JSON.stringify(payload);
  if (body.includes("email=") || body.includes("#section") || body.includes("debug=1")) {
    throw new Error(`browser metadata leaked query or hash data: ${body}`);
  }
  const path = payload.events[0].attributes.metadata?.path;
  if (path !== expectedPath) {
    throw new Error(`expected path ${expectedPath}, got ${path}`);
  }
}

function createResourceTimingEntry() {
  return {
    connectEnd: 40,
    connectStart: 22,
    decodedBodySize: 1200,
    domainLookupEnd: 20,
    domainLookupStart: 15,
    duration: 120,
    encodedBodySize: 900,
    entryType: "resource",
    fetchStart: 10,
    initiatorType: "fetch",
    name: "https://api.example.test/api/orders/123?sample=masked#fragment",
    redirectEnd: 10,
    redirectStart: 5,
    requestStart: 40,
    responseEnd: 130,
    responseStart: 80,
    responseStatus: 503,
    secureConnectionStart: 25,
    startTime: 10,
    transferSize: 1024
  };
}

function createNavigationTimingEntry(overrides = {}) {
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
    name: "https://app.example.test/products/42?email=dev@example.test#reviews",
    redirectCount: 2,
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
    workerStart: 5,
    ...overrides,
    serverTiming: [{ name: "sensitive", duration: 123 }]
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

function createFakePerformanceObserver() {
  const callbacks = [];
  const observers = [];
  const observedOptions = [];
  return {
    PerformanceObserver: class FakePerformanceObserver {
      constructor(nextCallback) {
        callbacks.push(nextCallback);
        observers.push(this);
      }

      disconnect() {
        this.disconnected = true;
      }

      observe(nextObservedOptions) {
        observedOptions.push(nextObservedOptions);
      }
    },
    disconnected() {
      return observers.length > 0 && observers.every((observer) => observer.disconnected === true);
    },
    disconnectedCount() {
      return observers.filter((observer) => observer.disconnected === true).length;
    },
    emit(entries) {
      for (const callback of callbacks) {
        callback({
          getEntries() {
            return entries;
          }
        });
      }
    },
    observedOptionsList() {
      return observedOptions;
    },
    observedOptions() {
      return observedOptions[observedOptions.length - 1];
    }
  };
}

function createFakeXMLHttpRequestClass() {
  return class FakeXMLHttpRequest {
    constructor() {
      this.listeners = new Map();
      this.requestHeaders = {};
      this.responseHeaders = {};
      this.status = 0;
    }

    addEventListener(type, listener) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    dispatchEvent(event) {
      for (const listener of this.listeners.get(event.type) ?? []) {
        listener.call(this, event);
      }
    }

    getResponseHeader(name) {
      return this.responseHeaders[String(name).toLowerCase()] ?? null;
    }

    open(method, url) {
      this.method = method;
      this.url = String(url);
    }

    removeEventListener(type, listener) {
      this.listeners.set(type, (this.listeners.get(type) ?? []).filter((candidate) => candidate !== listener));
    }

    send(body) {
      this.body = body;
    }

    setRequestHeader(name, value) {
      this.requestHeaders[name] = value;
    }

    setResponseHeader(name, value) {
      this.responseHeaders[String(name).toLowerCase()] = String(value);
    }
  };
}

function nextTimestamp() {
  tick += 1;
  return `2026-06-02T10:00:0${tick}Z`;
}

function setVisibilityState(document, visibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: visibilityState
  });
}

function createMemoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, String(value));
    }
  };
}

function fillBytes(length, value) {
  return Array.from({ length }, () => value);
}

function sequenceRandomValues(values) {
  let index = 0;
  return (length) => {
    const next = values[index++] ?? fillBytes(length, 0xaa);
    if (next.length !== length) {
      throw new Error(`expected ${length} random bytes, got ${next.length}`);
    }
    return next;
  };
}

function sequenceNumbers(values) {
  let index = 0;
  return () => values[index++] ?? values.at(-1);
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await delay(10);
  }
  throw new Error("timed out waiting for browser capture");
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
EOF

node smoke.mjs > "$tmp_dir/browser-smoke.stdout.json" 2> "$tmp_dir/browser-smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/browser-smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/browser-smoke.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/browser-smoke.stderr.json"
grep -q '"beaconEnvelope":"evt_beacon_log_001"' "$tmp_dir/browser-smoke.stderr.json"
grep -q '"browserDeliveries":8' "$tmp_dir/browser-smoke.stderr.json"
grep -q '"documentTimingSpan":"browser.document /products/:id"' "$tmp_dir/browser-smoke.stderr.json"
grep -q '"fullAttempts":2' "$tmp_dir/browser-smoke.stderr.json"
grep -q '"hiddenFlush":"evt_browser_hidden_001"' "$tmp_dir/browser-smoke.stderr.json"
grep -q '"interactionSpan":"browser.interaction click /products/:id"' "$tmp_dir/browser-smoke.stderr.json"
grep -q '"longAnimationFrameSpan":"browser.long_animation_frame /products/:id"' "$tmp_dir/browser-smoke.stderr.json"
grep -q '"longTaskSpan":"browser.long_task /products/:id"' "$tmp_dir/browser-smoke.stderr.json"
grep -q '"networkRoute":"/api/checkout"' "$tmp_dir/browser-smoke.stderr.json"
grep -q '"navigationPath":"/account"' "$tmp_dir/browser-smoke.stderr.json"
grep -q '"navigationTraceparent":"00-11111111111111111111111111111111-2222222222222222-01"' "$tmp_dir/browser-smoke.stderr.json"
grep -q '"pagePath":"/dashboard"' "$tmp_dir/browser-smoke.stderr.json"
grep -q '"pagehideFlush":"evt_browser_pagehide_001"' "$tmp_dir/browser-smoke.stderr.json"
grep -q '"persistedDirectReplay":1' "$tmp_dir/browser-smoke.stderr.json"
grep -q '"persistedOnlineSends":3' "$tmp_dir/browser-smoke.stderr.json"
grep -q '"propagatedTraceparent":"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"' "$tmp_dir/browser-smoke.stderr.json"
grep -q '"resourceSpan":"browser.resource fetch /api/orders/:id"' "$tmp_dir/browser-smoke.stderr.json"
grep -q '"sessionAction":"sess_browser_001"' "$tmp_dir/browser-smoke.stderr.json"
grep -q '"xhrSpan":"browser.xhr POST /api/orders/:id"' "$tmp_dir/browser-smoke.stderr.json"

cat > consumer.ts <<'EOF'
import { RecordingTransport } from "@logbrew/sdk";
import {
  captureBrowserAction,
  captureBrowserFetchSpan,
  captureBrowserInteractionTiming,
  captureBrowserNavigationTiming,
  captureBrowserNetwork,
  captureBrowserResourceTiming,
  captureBrowserXhrSpan,
  createBrowserTraceContext,
  createBrowserActionEvent,
  createBrowserFetchSpanEvent,
  createBrowserInteractionTimingEvent,
  createBrowserNavigationTimingEvent,
  createBrowserNetworkEvent,
  createBrowserResourceTimingEvent,
  createBrowserXhrSpanEvent,
  createBrowserErrorEvent,
  createBeaconTransport,
  createFetchTransport,
  createLogBrewBrowserFetch,
  createLogBrewBrowserClient,
  createPageViewEvent,
  createPersistentBrowserTransport,
  createTraceparentFetch,
  installLogBrewBrowser,
  installLogBrewBrowserFetchInstrumentation,
  installLogBrewBrowserInteractionTimingInstrumentation,
  installLogBrewBrowserNavigationInstrumentation,
  installLogBrewBrowserNavigationTimingInstrumentation,
  installLogBrewBrowserResourceTimingInstrumentation,
  installLogBrewBrowserXhrInstrumentation,
  type BrowserNavigationInstrumentation,
  type BrowserNavigationTimingInput,
  type BrowserNavigationTimingInstrumentation,
  type BrowserFetchInput,
  type BrowserFetchInstrumentation,
  type BrowserInteractionTimingInput,
  type BrowserInteractionTimingInstrumentation,
  type BrowserMetadataKind,
  type BrowserPersistedReplay,
  type BrowserPersistentStorage,
  type BrowserResourceTimingInput,
  type BrowserResourceTimingInstrumentation,
  type BrowserXhrInput,
  type BrowserXhrInstrumentation,
  type LogBrewBrowserContext,
  type PersistentBrowserTransport,
  type TracePropagationTarget
} from "@logbrew/browser";

const client = createLogBrewBrowserClient({
  clientKey: "LOGBREW_BROWSER_KEY",
  sdkName: "typed-browser-smoke",
  sdkVersion: "0.1.0"
});
const transport = RecordingTransport.alwaysAccept();
const context: LogBrewBrowserContext = installLogBrewBrowser({
  browserWindow: window,
  capturePageViews: false,
  client,
  flushOnCapture: false,
  flushOnPageHide: true,
  flushOnVisibilityHidden: true,
  sanitizeMetadata(metadata, kind: BrowserMetadataKind) {
    return {
      ...metadata,
      kind
    };
  },
  transport
});
const page = createPageViewEvent(window, {
  includeQueryString: false,
  now: () => "2026-06-02T10:00:00Z"
});
const issue = createBrowserErrorEvent(new Error("typed browser error"), window);
const action = createBrowserActionEvent({
  name: "checkout.clicked",
  status: "success",
  metadata: {
    routeTemplate: "/dashboard",
    sessionId: "sess_browser_001"
  }
}, window);
const network = createBrowserNetworkEvent({
  method: "POST",
  routeTemplate: "/api/checkout",
  statusCode: 202,
  durationMs: 123,
  sessionId: "sess_browser_001"
}, window);
const resourceEntry: BrowserResourceTimingInput = {
  duration: 12,
  entryType: "resource",
  initiatorType: "fetch",
  name: "https://api.example.test/api/checkout?sample=masked",
  responseStatus: 202,
  startTime: 0
};
const resource = createBrowserResourceTimingEvent(resourceEntry, window, {
  resourcePathTemplate: "/api/checkout"
});
const navigationEntry: BrowserNavigationTimingInput = {
  duration: 123,
  entryType: "navigation",
  loadEventEnd: 123,
  name: "https://app.example.test/checkout?sample=masked",
  responseStart: 42,
  responseStatus: 200,
  startTime: 0,
  type: "navigate"
};
const documentLoad = createBrowserNavigationTimingEvent(navigationEntry, window, {
  navigationPathTemplate: "/checkout"
});
const fetchEntry: BrowserFetchInput = {
  durationMs: 18,
  method: "POST",
  responseBodySize: 456,
  statusCode: 202,
  tracePropagated: true,
  url: "https://api.example.test/api/checkout?sample=masked"
};
const fetchSpan = createBrowserFetchSpanEvent(fetchEntry, window, {
  resourcePathTemplate: "/api/checkout"
});
const interactionEntry: BrowserInteractionTimingInput = {
  duration: 128,
  entryType: "event",
  interactionId: 91,
  name: "click",
  processingEnd: 275,
  processingStart: 220,
  startTime: 200
};
const interactionSpan = createBrowserInteractionTimingEvent(interactionEntry, window, {
  interactionPathTemplate: "/checkout"
});
const longAnimationFrameEntry: BrowserInteractionTimingInput = {
  blockingDuration: 45,
  duration: 120,
  entryType: "long-animation-frame",
  renderStart: 650,
  scripts: [
    { duration: 40, forcedStyleAndLayoutDuration: 6, pauseDuration: 3 }
  ],
  startTime: 600,
  styleAndLayoutStart: 675
};
const longAnimationFrameSpan = createBrowserInteractionTimingEvent(longAnimationFrameEntry, window, {
  interactionPathTemplate: "/checkout"
});
const xhrEntry: BrowserXhrInput = {
  durationMs: 21,
  method: "POST",
  responseBodySize: 123,
  statusCode: 202,
  tracePropagated: true,
  url: "https://api.example.test/api/checkout?sample=masked"
};
const xhrSpan = createBrowserXhrSpanEvent(xhrEntry, window, {
  resourcePathTemplate: "/api/checkout"
});
client.span(page.id, page.timestamp, page.attributes);
client.span(fetchSpan.id, fetchSpan.timestamp, fetchSpan.attributes);
client.span(interactionSpan.id, interactionSpan.timestamp, interactionSpan.attributes);
client.span(longAnimationFrameSpan.id, longAnimationFrameSpan.timestamp, longAnimationFrameSpan.attributes);
client.span(documentLoad.id, documentLoad.timestamp, documentLoad.attributes);
client.span(resource.id, resource.timestamp, resource.attributes);
client.span(xhrSpan.id, xhrSpan.timestamp, xhrSpan.attributes);
client.action(action.id, action.timestamp, action.attributes);
client.action(network.id, network.timestamp, network.attributes);
client.issue(issue.id, issue.timestamp, issue.attributes);
void captureBrowserAction("checkout.submitted", context);
void captureBrowserNetwork("/api/checkout", context);
void captureBrowserFetchSpan(fetchEntry, context, {
  resourcePathTemplate: "/api/checkout"
});
void captureBrowserInteractionTiming(interactionEntry, context, {
  interactionPathTemplate: "/checkout"
});
void captureBrowserNavigationTiming(navigationEntry, context, {
  navigationPathTemplate: "/checkout"
});
void captureBrowserXhrSpan(xhrEntry, context, {
  resourcePathTemplate: "/api/checkout"
});
void captureBrowserResourceTiming(resourceEntry, context, {
  resourcePathTemplate: "/api/checkout"
});
void context.flush();
createFetchTransport({
  endpoint: "https://api.logbrew.com/v1/events",
  fetchImpl: fetch
});
createBeaconTransport({
  endpoint: "https://example.com/logbrew/browser-beacon",
  sendBeacon(_endpoint, _payload) {
    return true;
  }
});
const storage: BrowserPersistentStorage = window.localStorage;
const persistentTransport: PersistentBrowserTransport = createPersistentBrowserTransport({
  storage,
  transport
});
const replay: Promise<BrowserPersistedReplay> = persistentTransport.replayStoredBatches("LOGBREW_BROWSER_KEY");
void replay;
const traceTargets: TracePropagationTarget[] = ["https://api.example.test/", /^\/internal\//u];
const traceContext = createBrowserTraceContext({
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "b7ad6b7169203331"
});
const navigation: BrowserNavigationInstrumentation = installLogBrewBrowserNavigationInstrumentation(context, {
  captureInitial: false,
  flushOnCapture: false,
  randomValues: (length) => new Uint8Array(length),
  traceFlags: "01"
});
const resourceTimingInstrumentation: BrowserResourceTimingInstrumentation =
  installLogBrewBrowserResourceTimingInstrumentation(context, {
    performanceObserver: window.PerformanceObserver,
    resourcePathTemplate: ({ path }) => path
  });
const navigationTimingInstrumentation: BrowserNavigationTimingInstrumentation =
  installLogBrewBrowserNavigationTimingInstrumentation(context, {
    captureInitial: false,
    navigationPathTemplate: ({ path }) => path
  });
const browserFetch = createLogBrewBrowserFetch(context, {
  fetchImpl: fetch,
  resourcePathTemplate: "/api/checkout",
  tracePropagationTargets: traceTargets
});
const fetchInstrumentation: BrowserFetchInstrumentation = installLogBrewBrowserFetchInstrumentation(context, {
  browserWindow: window,
  resourcePathTemplate: ({ path }) => path
});
const interactionTimingInstrumentation: BrowserInteractionTimingInstrumentation =
  installLogBrewBrowserInteractionTimingInstrumentation(context, {
    entryTypes: ["event", "long-animation-frame"],
    interactionPathTemplate: ({ path }) => path,
    performanceObserver: window.PerformanceObserver
  });
const xhrInstrumentation: BrowserXhrInstrumentation = installLogBrewBrowserXhrInstrumentation(context, {
  browserWindow: window,
  resourcePathTemplate: ({ path }) => path,
  tracePropagationTargets: traceTargets,
  XMLHttpRequest: window.XMLHttpRequest
});
const tracedFetch = createTraceparentFetch({
  fetchImpl: fetch,
  traceContext,
  tracePropagationTargets: traceTargets
});
const dynamicTraceFetch = createTraceparentFetch({
  fetchImpl: fetch,
  traceContext: () => context.traceContext,
  tracePropagationTargets: traceTargets
});
void tracedFetch("/internal/ping");
void dynamicTraceFetch("/internal/ping");
void browserFetch("/internal/ping");
fetchInstrumentation.uninstall();
interactionTimingInstrumentation.uninstall();
xhrInstrumentation.uninstall();
navigation.uninstall();
navigationTimingInstrumentation.uninstall();
resourceTimingInstrumentation.uninstall();
context.uninstall();
EOF
cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "lib": ["DOM", "ES2022"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022",
    "strict": true,
    "skipLibCheck": false,
    "noEmit": true
  },
  "include": ["consumer.ts"]
}
EOF
npx tsc --project tsconfig.json

cat > cjs-smoke.cjs <<'EOF'
const browser = require("@logbrew/browser");
const { RecordingTransport } = require("@logbrew/sdk");

if (typeof browser.installLogBrewBrowser !== "function") {
  throw new Error("missing CommonJS browser install helper");
}
if (typeof browser.installLogBrewBrowserNavigationInstrumentation !== "function") {
  throw new Error("missing CommonJS browser navigation helper");
}
if (typeof browser.createTraceparentFetch !== "function" || typeof browser.createBrowserTraceContext !== "function") {
  throw new Error("missing CommonJS browser trace helpers");
}
if (typeof browser.captureBrowserAction !== "function" || typeof browser.createBrowserActionEvent !== "function") {
  throw new Error("missing CommonJS browser action helpers");
}
if (typeof browser.captureBrowserNetwork !== "function" || typeof browser.createBrowserNetworkEvent !== "function") {
  throw new Error("missing CommonJS browser network helpers");
}
if (typeof browser.captureBrowserResourceTiming !== "function" || typeof browser.createBrowserResourceTimingEvent !== "function") {
  throw new Error("missing CommonJS browser resource timing helpers");
}
if (typeof browser.installLogBrewBrowserResourceTimingInstrumentation !== "function") {
  throw new Error("missing CommonJS browser resource timing instrumentation helper");
}
if (typeof browser.captureBrowserNavigationTiming !== "function" || typeof browser.createBrowserNavigationTimingEvent !== "function") {
  throw new Error("missing CommonJS browser navigation timing helpers");
}
if (typeof browser.installLogBrewBrowserNavigationTimingInstrumentation !== "function") {
  throw new Error("missing CommonJS browser navigation timing instrumentation helper");
}
if (typeof browser.captureBrowserWebVital !== "function" || typeof browser.createBrowserWebVitalEvent !== "function") {
  throw new Error("missing CommonJS browser Web Vital helpers");
}
if (typeof browser.installLogBrewBrowserWebVitalsInstrumentation !== "function") {
  throw new Error("missing CommonJS browser Web Vitals instrumentation helper");
}
if (typeof browser.captureBrowserInteractionTiming !== "function" || typeof browser.createBrowserInteractionTimingEvent !== "function") {
  throw new Error("missing CommonJS browser interaction timing helpers");
}
if (typeof browser.installLogBrewBrowserInteractionTimingInstrumentation !== "function") {
  throw new Error("missing CommonJS browser interaction timing instrumentation helper");
}
if (typeof browser.createLogBrewBrowserFetch !== "function" || typeof browser.captureBrowserFetchSpan !== "function") {
  throw new Error("missing CommonJS browser fetch span helpers");
}
if (typeof browser.installLogBrewBrowserFetchInstrumentation !== "function") {
  throw new Error("missing CommonJS browser fetch instrumentation helper");
}
if (typeof browser.createBrowserXhrSpanEvent !== "function" || typeof browser.captureBrowserXhrSpan !== "function") {
  throw new Error("missing CommonJS browser XHR span helpers");
}
if (typeof browser.installLogBrewBrowserXhrInstrumentation !== "function") {
  throw new Error("missing CommonJS browser XHR instrumentation helper");
}
if (typeof browser.createPersistentBrowserTransport !== "function") {
  throw new Error("missing CommonJS persistent browser transport helper");
}
if (typeof browser.createBeaconTransport !== "function") {
  throw new Error("missing CommonJS beacon transport helper");
}
const client = browser.createLogBrewBrowserClient({
  clientKey: "LOGBREW_BROWSER_KEY",
  sdkName: "cjs-browser-smoke",
  sdkVersion: "0.1.0"
});
client.log("evt_log_001", "2026-06-02T10:00:03Z", {
  message: "commonjs browser app started",
  level: "info",
  logger: "browser"
});
client.flush(RecordingTransport.alwaysAccept()).then((response) => {
  if (response.statusCode !== 202) {
    throw new Error(`unexpected CJS status: ${response.statusCode}`);
  }
});
EOF
node cjs-smoke.cjs

node node_modules/@logbrew/browser/examples/index.mjs --help > "$tmp_dir/launcher-help.txt"
grep -q 'node node_modules/@logbrew/browser/examples/index.mjs readme-example' "$tmp_dir/launcher-help.txt"
node node_modules/@logbrew/browser/examples/index.mjs --list > "$tmp_dir/launcher-list.txt"
grep -q 'real-user-smoke -> node node_modules/@logbrew/browser/examples/index.mjs real-user-smoke' "$tmp_dir/launcher-list.txt"
node node_modules/@logbrew/browser/examples/index.mjs readme-example > "$tmp_dir/example-readme.stdout.json" 2> "$tmp_dir/example-readme.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/example-readme.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/example-readme.stderr.json"
grep -q '"path":"/dashboard"' "$tmp_dir/example-readme.stderr.json"
node node_modules/@logbrew/browser/examples/index.mjs > "$tmp_dir/example-default.stdout.json" 2> "$tmp_dir/example-default.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/example-default.stdout.json" >/dev/null
grep -q '"pagehideFlushEvents":12' "$tmp_dir/example-default.stderr.json"
grep -q '"documentSpan":"browser.document /settings"' "$tmp_dir/example-default.stderr.json"
grep -q '"fetchSpan":"browser.fetch POST /api/checkout/:id"' "$tmp_dir/example-default.stderr.json"
grep -q '"interactionSpan":"browser.interaction click /settings"' "$tmp_dir/example-default.stderr.json"
grep -q '"longAnimationFrameSpan":"browser.long_animation_frame /settings"' "$tmp_dir/example-default.stderr.json"
grep -q '"longTaskSpan":"browser.long_task /settings"' "$tmp_dir/example-default.stderr.json"
grep -q '"webVitalSpan":"browser.web_vital LCP /settings"' "$tmp_dir/example-default.stderr.json"
grep -q '"propagatedTraceparent":"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"' "$tmp_dir/example-default.stderr.json"
npm --prefix node_modules/@logbrew/browser/examples run list > "$tmp_dir/npm-helper-list.txt"
grep -q 'readme-example -> node node_modules/@logbrew/browser/examples/index.mjs readme-example' "$tmp_dir/npm-helper-list.txt"
npm --prefix node_modules/@logbrew/browser/examples run help > "$tmp_dir/npm-helper-help.txt"
grep -q 'Default example: real-user-smoke' "$tmp_dir/npm-helper-help.txt"
npm --prefix node_modules/@logbrew/browser/examples run --silent real-user-smoke > "$tmp_dir/npm-helper-smoke.stdout.json" 2> "$tmp_dir/npm-helper-smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/npm-helper-smoke.stdout.json" >/dev/null
grep -q '"pagehideFlushEvents":12' "$tmp_dir/npm-helper-smoke.stderr.json"
grep -q '"documentSpan":"browser.document /settings"' "$tmp_dir/npm-helper-smoke.stderr.json"
grep -q '"fetchSpan":"browser.fetch POST /api/checkout/:id"' "$tmp_dir/npm-helper-smoke.stderr.json"
grep -q '"interactionSpan":"browser.interaction click /settings"' "$tmp_dir/npm-helper-smoke.stderr.json"
grep -q '"longAnimationFrameSpan":"browser.long_animation_frame /settings"' "$tmp_dir/npm-helper-smoke.stderr.json"
grep -q '"longTaskSpan":"browser.long_task /settings"' "$tmp_dir/npm-helper-smoke.stderr.json"
grep -q '"webVitalSpan":"browser.web_vital LCP /settings"' "$tmp_dir/npm-helper-smoke.stderr.json"
grep -q '"propagatedTraceparent":"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"' "$tmp_dir/npm-helper-smoke.stderr.json"

echo "browser real-user smoke passed with happy-dom@$(node -p 'require("happy-dom/package.json").version')"
