#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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
grep -q '^package/index.js$' "$tmp_dir/browser-tarball.txt"
grep -q '^package/index.cjs$' "$tmp_dir/browser-tarball.txt"
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
grep -q 'flushOnPageHide' "$tmp_dir/browser-readme.md"
grep -q 'flushOnVisibilityHidden' "$tmp_dir/browser-readme.md"
grep -q 'sanitizeMetadata' "$tmp_dir/browser-readme.md"
grep -q 'query string or hash' "$tmp_dir/browser-readme.md"
grep -q 'captureBrowserAction' "$tmp_dir/browser-readme.md"
grep -q 'captureBrowserNetwork' "$tmp_dir/browser-readme.md"
grep -q 'sessionId' "$tmp_dir/browser-readme.md"
grep -q 'createTraceparentFetch' "$tmp_dir/browser-readme.md"
grep -q 'createBrowserTraceparent' "$tmp_dir/browser-readme.md"
grep -q 'tracePropagationTargets' "$tmp_dir/browser-readme.md"

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
grep -q '@logbrew/sdk@0.1.0' "$tmp_dir/npm-list-depth0.txt"
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
  captureBrowserNetwork,
  createBrowserTraceparent,
  createFetchTransport,
  createLogBrewBrowserClient,
  createTraceparentFetch,
  installLogBrewBrowser,
  shouldPropagateTraceparent
} from "@logbrew/browser";

const browserWindow = new Window({
  url: "https://app.example.test/dashboard?email=dev@example.test#section"
});
browserWindow.document.title = "LogBrew Browser Smoke";

let tick = 0;
const transport = RecordingTransport.alwaysAccept();
const flushed = [];
const logbrew = installLogBrewBrowser({
  clientKey: "LOGBREW_BROWSER_KEY",
  browserWindow,
  now: nextTimestamp,
  onFlush(response) {
    flushed.push(response);
  },
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

const tracedFetchRequests = [];
const tracedFetch = createTraceparentFetch({
  fetchImpl: async (input, init = {}) => {
    tracedFetchRequests.push({ input, init });
    return { status: 204 };
  },
  traceparentFactory: () => createBrowserTraceparent({
    randomValues: deterministicBytes
  }),
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
  browserDeliveries: transport.sentBodies.length,
  events: JSON.parse(preview).events.length,
  fetchStatus: fetchResponse.statusCode,
  fullAttempts: fullResponse.attempts,
  hiddenFlush: hiddenPayload.events[0].id,
  networkRoute: networkPayload.events[0].attributes.metadata.routeTemplate,
  pagePath: pagePayload.events[0].attributes.metadata.path,
  pagehideFlush: pagehidePayload.events[0].id,
  propagatedTraceparent,
  rejectionTitle: rejectionPayload.events[0].attributes.title,
  sessionAction: actionPayload.events[0].attributes.metadata.sessionId,
  syncTitle: syncPayload.events[0].attributes.title
}));

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
grep -q '"browserDeliveries":8' "$tmp_dir/browser-smoke.stderr.json"
grep -q '"fullAttempts":2' "$tmp_dir/browser-smoke.stderr.json"
grep -q '"hiddenFlush":"evt_browser_hidden_001"' "$tmp_dir/browser-smoke.stderr.json"
grep -q '"networkRoute":"/api/checkout"' "$tmp_dir/browser-smoke.stderr.json"
grep -q '"pagePath":"/dashboard"' "$tmp_dir/browser-smoke.stderr.json"
grep -q '"pagehideFlush":"evt_browser_pagehide_001"' "$tmp_dir/browser-smoke.stderr.json"
grep -q '"propagatedTraceparent":"00-0102030405060708090a0b0c0d0e0f10-0102030405060708-01"' "$tmp_dir/browser-smoke.stderr.json"
grep -q '"sessionAction":"sess_browser_001"' "$tmp_dir/browser-smoke.stderr.json"

cat > consumer.ts <<'EOF'
import { RecordingTransport } from "@logbrew/sdk";
import {
  captureBrowserAction,
  captureBrowserNetwork,
  createBrowserTraceparent,
  createBrowserActionEvent,
  createBrowserNetworkEvent,
  createBrowserErrorEvent,
  createFetchTransport,
  createLogBrewBrowserClient,
  createPageViewEvent,
  createTraceparentFetch,
  installLogBrewBrowser,
  type BrowserMetadataKind,
  type LogBrewBrowserContext,
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
client.span(page.id, page.timestamp, page.attributes);
client.action(action.id, action.timestamp, action.attributes);
client.action(network.id, network.timestamp, network.attributes);
client.issue(issue.id, issue.timestamp, issue.attributes);
void captureBrowserAction("checkout.submitted", context);
void captureBrowserNetwork("/api/checkout", context);
void context.flush();
createFetchTransport({
  endpoint: "https://api.logbrew.com/v1/events",
  fetchImpl: fetch
});
const traceTargets: TracePropagationTarget[] = ["https://api.example.test/", /^\/internal\//u];
const tracedFetch = createTraceparentFetch({
  fetchImpl: fetch,
  traceparentFactory: () => createBrowserTraceparent({
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "b7ad6b7169203331"
  }),
  tracePropagationTargets: traceTargets
});
void tracedFetch("/internal/ping");
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
if (typeof browser.createTraceparentFetch !== "function" || typeof browser.createBrowserTraceparent !== "function") {
  throw new Error("missing CommonJS browser trace helpers");
}
if (typeof browser.captureBrowserAction !== "function" || typeof browser.createBrowserActionEvent !== "function") {
  throw new Error("missing CommonJS browser action helpers");
}
if (typeof browser.captureBrowserNetwork !== "function" || typeof browser.createBrowserNetworkEvent !== "function") {
  throw new Error("missing CommonJS browser network helpers");
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
grep -q '"pagehideFlushEvents":6' "$tmp_dir/example-default.stderr.json"
grep -q '"propagatedTraceparent":"00-0102030405060708090a0b0c0d0e0f10-0102030405060708-01"' "$tmp_dir/example-default.stderr.json"
npm --prefix node_modules/@logbrew/browser/examples run list > "$tmp_dir/npm-helper-list.txt"
grep -q 'readme-example -> node node_modules/@logbrew/browser/examples/index.mjs readme-example' "$tmp_dir/npm-helper-list.txt"
npm --prefix node_modules/@logbrew/browser/examples run help > "$tmp_dir/npm-helper-help.txt"
grep -q 'Default example: real-user-smoke' "$tmp_dir/npm-helper-help.txt"
npm --prefix node_modules/@logbrew/browser/examples run --silent real-user-smoke > "$tmp_dir/npm-helper-smoke.stdout.json" 2> "$tmp_dir/npm-helper-smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/npm-helper-smoke.stdout.json" >/dev/null
grep -q '"pagehideFlushEvents":6' "$tmp_dir/npm-helper-smoke.stderr.json"
grep -q '"propagatedTraceparent":"00-0102030405060708090a0b0c0d0e0f10-0102030405060708-01"' "$tmp_dir/npm-helper-smoke.stderr.json"

echo "browser real-user smoke passed with happy-dom@$(node -p 'require("happy-dom/package.json").version')"
