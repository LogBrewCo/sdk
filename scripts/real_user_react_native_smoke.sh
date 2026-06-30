#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sdk_package_version="$(node -p "require('${repo_root}/js/logbrew-js/package.json').version")"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

core_pack_json="$tmp_dir/core-pack.json"
native_pack_json="$tmp_dir/native-pack.json"
(cd "$repo_root/js/logbrew-js" && npm pack --json --pack-destination "$tmp_dir") > "$core_pack_json"
(cd "$repo_root/js/logbrew-react-native" && npm pack --json --pack-destination "$tmp_dir") > "$native_pack_json"

core_tgz="$(python3 - "$core_pack_json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
print(payload[0]["filename"])
PY
)"
native_tgz="$(python3 - "$native_pack_json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
print(payload[0]["filename"])
PY
)"
core_tgz="$tmp_dir/$core_tgz"
native_tgz="$tmp_dir/$native_tgz"
test -f "$core_tgz"
test -f "$native_tgz"

tar -tzf "$native_tgz" > "$tmp_dir/native-tarball.txt"
grep -q '^package/README.md$' "$tmp_dir/native-tarball.txt"
grep -q '^package/index.js$' "$tmp_dir/native-tarball.txt"
grep -q '^package/index.cjs$' "$tmp_dir/native-tarball.txt"
grep -q '^package/index.native.js$' "$tmp_dir/native-tarball.txt"
grep -q '^package/index.d.ts$' "$tmp_dir/native-tarball.txt"
grep -q '^package/index.d.cts$' "$tmp_dir/native-tarball.txt"
grep -q '^package/instrumentation.js$' "$tmp_dir/native-tarball.txt"
grep -q '^package/instrumentation.cjs$' "$tmp_dir/native-tarball.txt"
grep -q '^package/instrumentation.d.ts$' "$tmp_dir/native-tarball.txt"
grep -q '^package/instrumentation.d.cts$' "$tmp_dir/native-tarball.txt"
grep -q '^package/lifecycle.js$' "$tmp_dir/native-tarball.txt"
grep -q '^package/lifecycle.cjs$' "$tmp_dir/native-tarball.txt"
grep -q '^package/lifecycle.d.ts$' "$tmp_dir/native-tarball.txt"
grep -q '^package/lifecycle.d.cts$' "$tmp_dir/native-tarball.txt"
grep -q '^package/metadata.js$' "$tmp_dir/native-tarball.txt"
grep -q '^package/metadata.cjs$' "$tmp_dir/native-tarball.txt"
grep -q '^package/native-bridge.js$' "$tmp_dir/native-tarball.txt"
grep -q '^package/native-bridge.cjs$' "$tmp_dir/native-tarball.txt"
grep -q '^package/native-bridge.d.ts$' "$tmp_dir/native-tarball.txt"
grep -q '^package/native-bridge.d.cts$' "$tmp_dir/native-tarball.txt"
grep -q '^package/resource-fetch.js$' "$tmp_dir/native-tarball.txt"
grep -q '^package/resource-fetch.cjs$' "$tmp_dir/native-tarball.txt"
grep -q '^package/resource-fetch.d.ts$' "$tmp_dir/native-tarball.txt"
grep -q '^package/resource-fetch.d.cts$' "$tmp_dir/native-tarball.txt"
grep -q '^package/examples/index.mjs$' "$tmp_dir/native-tarball.txt"
grep -q '^package/examples/instrumentation-kit.mjs$' "$tmp_dir/native-tarball.txt"
grep -q '^package/examples/lifecycle-spans.mjs$' "$tmp_dir/native-tarball.txt"
grep -q '^package/examples/native-bridge-scope.mjs$' "$tmp_dir/native-tarball.txt"
grep -q '^package/examples/navigation-resource-spans.mjs$' "$tmp_dir/native-tarball.txt"
grep -q '^package/examples/package.json$' "$tmp_dir/native-tarball.txt"
grep -q '^package/examples/readme-example.mjs$' "$tmp_dir/native-tarball.txt"
grep -q '^package/examples/real-user-smoke.mjs$' "$tmp_dir/native-tarball.txt"
grep -q '^package/examples/resource-fetch-spans.mjs$' "$tmp_dir/native-tarball.txt"
grep -q '^package/examples/trace-correlation.mjs$' "$tmp_dir/native-tarball.txt"
tar -xOf "$native_tgz" package/README.md > "$tmp_dir/native-readme.md"
grep -q 'npm install @logbrew/sdk @logbrew/react-native react react-native' "$tmp_dir/native-readme.md"
grep -q 'pnpm add @logbrew/sdk @logbrew/react-native react react-native' "$tmp_dir/native-readme.md"
grep -q 'LOGBREW_CLIENT_KEY' "$tmp_dir/native-readme.md"
grep -q 'AppState' "$tmp_dir/native-readme.md"
grep -q 'Platform' "$tmp_dir/native-readme.md"
grep -q 'createTraceparentFetch' "$tmp_dir/native-readme.md"
grep -q 'createReactNativeTraceparent' "$tmp_dir/native-readme.md"
grep -q 'tracePropagationTargets' "$tmp_dir/native-readme.md"
grep -q 'captureReactNativeError' "$tmp_dir/native-readme.md"
grep -q 'captureReactNativeAction' "$tmp_dir/native-readme.md"
grep -q 'captureReactNativeNetwork' "$tmp_dir/native-readme.md"
grep -q 'withLogBrewTrace' "$tmp_dir/native-readme.md"
grep -q 'getActiveLogBrewTrace' "$tmp_dir/native-readme.md"
grep -q 'createReactNavigationSpanListener' "$tmp_dir/native-readme.md"
grep -q 'createAppStateLifecycleSpanListener' "$tmp_dir/native-readme.md"
grep -q 'captureReactNativeResourceSpan' "$tmp_dir/native-readme.md"
grep -q 'createReactNativeGraphQLMetadataFactory' "$tmp_dir/native-readme.md"
grep -q 'createReactNativeResourceFetch' "$tmp_dir/native-readme.md"
grep -q 'createLogBrewReactNativeInstrumentation' "$tmp_dir/native-readme.md"
grep -q 'withLogBrewNativeBridgeScope' "$tmp_dir/native-readme.md"
grep -q '@logbrew/react-native/instrumentation' "$tmp_dir/native-readme.md"
grep -q '@logbrew/react-native/native-bridge' "$tmp_dir/native-readme.md"
grep -q '@logbrew/react-native/resource-fetch' "$tmp_dir/native-readme.md"
grep -q '@logbrew/react-native/lifecycle' "$tmp_dir/native-readme.md"

app_dir="$tmp_dir/react-native-smoke-app"
mkdir -p "$app_dir"
cd "$app_dir"
npm init -y >/dev/null
npm pkg set type=module >/dev/null
react_native_version="$(npm view react-native version)"
react_version="$(npm view react version)"
renderer_version="$(npm view react-test-renderer version)"
npm install \
  --save-exact \
  "$core_tgz" \
  "$native_tgz" \
  "react@$react_version" \
  "react-native@$react_native_version" \
  "react-test-renderer@$renderer_version" \
  typescript \
  @types/react \
  >/dev/null

grep -q '"@logbrew/sdk": "file:' package.json
grep -q '"@logbrew/react-native": "file:' package.json
grep -q '"react-native":' package.json
grep -q '"react":' package.json
grep -q '"@logbrew/react-native"' package-lock.json
grep -q '"@logbrew/sdk"' package-lock.json
grep -q '"react-native": "./index.native.js"' node_modules/@logbrew/react-native/package.json
grep -q '"./instrumentation"' node_modules/@logbrew/react-native/package.json
grep -q '"./lifecycle"' node_modules/@logbrew/react-native/package.json
grep -q '"./native-bridge"' node_modules/@logbrew/react-native/package.json
npm ls @logbrew/sdk @logbrew/react-native react react-native react-test-renderer >/dev/null
npm explain @logbrew/react-native > "$tmp_dir/npm-explain-native.txt"
grep -q '@logbrew/react-native@0.1.0' "$tmp_dir/npm-explain-native.txt"
npm list --depth=0 > "$tmp_dir/npm-list-depth0.txt"
grep -q '@logbrew/react-native@0.1.0' "$tmp_dir/npm-list-depth0.txt"
grep -q "@logbrew/sdk@${sdk_package_version}" "$tmp_dir/npm-list-depth0.txt"
npm list --json --depth=0 > "$tmp_dir/npm-list-depth0.json"
python3 - "$tmp_dir/npm-list-depth0.json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
deps = payload.get("dependencies", {})
for name in ("@logbrew/react-native", "@logbrew/sdk", "react", "react-native"):
    if name not in deps:
        raise SystemExit(f"missing npm dependency entry: {name}")
PY
node --check node_modules/@logbrew/react-native/index.native.js
node --check node_modules/@logbrew/react-native/instrumentation.js
node --check node_modules/@logbrew/react-native/instrumentation.cjs
node --check node_modules/@logbrew/react-native/lifecycle.js
node --check node_modules/@logbrew/react-native/lifecycle.cjs
node --check node_modules/@logbrew/react-native/metadata.js
node --check node_modules/@logbrew/react-native/metadata.cjs
node --check node_modules/@logbrew/react-native/native-bridge.js
node --check node_modules/@logbrew/react-native/native-bridge.cjs
node --check node_modules/@logbrew/react-native/resource-fetch.js
node --check node_modules/@logbrew/react-native/resource-fetch.cjs
node -e 'const native = require("@logbrew/react-native"); if (typeof native.createLogBrewReactNativeClient !== "function" || typeof native.createTraceparentFetch !== "function" || typeof native.createReactNativeTraceparent !== "function" || typeof native.createReactNativeTraceContext !== "function" || typeof native.getActiveLogBrewTrace !== "function" || typeof native.withLogBrewTrace !== "function" || typeof native.createReactNativeTraceHeaders !== "function" || typeof native.captureReactNativeError !== "function" || typeof native.captureReactNativeAction !== "function" || typeof native.captureReactNativeNetwork !== "function" || typeof native.captureReactNativeNavigationSpan !== "function" || typeof native.captureReactNativeResourceSpan !== "function" || typeof native.createReactNavigationSpanListener !== "function" || typeof native.createReactNativeErrorEvent !== "function" || typeof native.createReactNativeActionEvent !== "function" || typeof native.createReactNativeNetworkEvent !== "function" || typeof native.createReactNativeNavigationSpanEvent !== "function" || typeof native.createReactNativeResourceSpanEvent !== "function" || typeof native.default !== "object") process.exit(1)'
node -e 'const instrumentation = require("@logbrew/react-native/instrumentation"); if (typeof instrumentation.createLogBrewReactNativeInstrumentation !== "function" || typeof instrumentation.default !== "object") process.exit(1)'
node -e 'const lifecycle = require("@logbrew/react-native/lifecycle"); if (typeof lifecycle.createAppStateLifecycleSpanListener !== "function" || typeof lifecycle.captureReactNativeLifecycleSpan !== "function" || typeof lifecycle.createReactNativeLifecycleSpanEvent !== "function") process.exit(1)'
node -e 'const bridge = require("@logbrew/react-native/native-bridge"); if (typeof bridge.createLogBrewNativeBridgeScope !== "function" || typeof bridge.syncLogBrewNativeBridgeScope !== "function" || typeof bridge.clearLogBrewNativeBridgeScope !== "function" || typeof bridge.withLogBrewNativeBridgeScope !== "function" || typeof bridge.default !== "object") process.exit(1)'
node -e 'const nativeResourceFetch = require("@logbrew/react-native/resource-fetch"); if (typeof nativeResourceFetch.createReactNativeGraphQLMetadataFactory !== "function" || typeof nativeResourceFetch.createReactNativeResourceFetch !== "function") process.exit(1)'

cat > smoke.mjs <<'EOF'
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { RecordingTransport } from "@logbrew/sdk";
import {
  LogBrewNativeProvider,
  bindLogBrewTrace,
  captureAppStateChange,
  captureReactNativeAction,
  captureReactNativeError,
  captureReactNativeNetwork,
  captureScreenView,
  createAppStateListener,
  createLogBrewReactNativeClient,
  createReactNativeActionEvent,
  createReactNativeNetworkEvent,
  createReactNativeSpanAttributes,
  createReactNativeTraceContext,
  createReactNativeTraceHeaders,
  createReactNativeTraceparent,
  createTraceparentFetch,
  getActiveLogBrewTrace,
  getReactNativeContext,
  getReactNativeTraceMetadata,
  shouldPropagateTraceparent,
  withLogBrewTrace,
  useLogBrewNativeActions
} from "@logbrew/react-native";
import {
  createAppStateLifecycleSpanListener
} from "@logbrew/react-native/lifecycle";
import {
  createLogBrewReactNativeInstrumentation
} from "@logbrew/react-native/instrumentation";
import {
  createReactNativeGraphQLMetadataFactory,
  createReactNativeResourceFetch
} from "@logbrew/react-native/resource-fetch";

const platform = {
  OS: "ios",
  Version: "18.0",
  isPad: false,
  constants: { isTesting: true }
};
let appStateListener = null;
const appState = {
  currentState: "active",
  addEventListener(_type, listener) {
    appStateListener = listener;
    return {
      remove() {
        appStateListener = null;
      }
    };
  }
};

const context = getReactNativeContext({ platform, appState, metadata: { app: "smoke" } });
if (context.platform !== "ios" || context.appState !== "active" || context.app !== "smoke") {
  throw new Error(`unexpected native context: ${JSON.stringify(context)}`);
}

const client = createLogBrewReactNativeClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "react-native-smoke-app",
  sdkVersion: "0.1.0",
  maxRetries: 1
});
const providerTrace = createReactNativeTraceContext({
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  spanId: "b7ad6b7169203331"
});
const providerTraceHeaders = createReactNativeTraceHeaders(providerTrace);
if (providerTraceHeaders.traceparent !== "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01") {
  throw new Error(`unexpected provider traceparent: ${providerTraceHeaders.traceparent}`);
}
const traceMetadata = getReactNativeTraceMetadata(providerTrace);
if (traceMetadata.traceSampled !== true || traceMetadata.parentSpanId !== "00f067aa0ba902b7") {
  throw new Error(`unexpected trace metadata: ${JSON.stringify(traceMetadata)}`);
}
const boundHandler = bindLogBrewTrace(providerTrace, () => getActiveLogBrewTrace()?.traceId);
if (boundHandler() !== providerTrace.traceId || getActiveLogBrewTrace() !== undefined) {
  throw new Error("bound trace callback should expose and then clear active trace");
}

function CaptureComponent() {
  const actions = useLogBrewNativeActions();
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
  actions.captureScreenView("Checkout", {
    id: "evt_action_001",
    timestamp: "2026-06-02T10:00:05Z",
    metadata: { flow: "checkout" }
  });
  return React.createElement("logbrew-smoke", { pending: actions.pendingEvents() });
}

await act(async () => {
  TestRenderer.create(
    React.createElement(
      LogBrewNativeProvider,
      { client, platform, appState, trace: providerTrace },
      React.createElement(CaptureComponent)
    )
  );
});

const stopListening = createAppStateListener(client, appState, {
  id: "evt_action_background",
  timestamp: "2026-06-02T10:00:06Z",
  platform,
  trace: providerTrace
});
appStateListener("background");
stopListening();
withLogBrewTrace(providerTrace, () => {
  captureAppStateChange(client, "active", {
    id: "evt_action_foreground",
    timestamp: "2026-06-02T10:00:07Z",
    platform,
    appState
  });
  captureScreenView(client, "Checkout Complete", {
    id: "evt_action_checkout_complete",
    timestamp: "2026-06-02T10:00:08Z",
    platform,
    appState
  });
});

const lifecycleClient = createLogBrewReactNativeClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "react-native-lifecycle-smoke",
  sdkVersion: "0.1.0",
  maxRetries: 1
});
const lifecycleTimes = [1000, 1125, 1600];
const lifecycleTimestamps = [
  "2026-06-02T10:00:09Z",
  "2026-06-02T10:00:10Z",
  "2026-06-02T10:00:11Z"
];
const stopLifecycleListening = createAppStateLifecycleSpanListener(lifecycleClient, appState, {
  captureInitialState: true,
  metadata: { flow: "checkout", nested: { dropped: true } },
  now: () => lifecycleTimestamps.shift(),
  nowMs: () => lifecycleTimes.shift(),
  platform,
  screen: "Checkout",
  sessionId: "session_mobile_001",
  trace: providerTrace
});
appState.currentState = "inactive";
appStateListener("inactive");
appState.currentState = "background";
appStateListener("background");
stopLifecycleListening();
appState.currentState = "active";
const lifecycleEvents = JSON.parse(lifecycleClient.previewJson()).events;
if (lifecycleEvents.length !== 3) {
  throw new Error(`expected three lifecycle spans, got ${lifecycleEvents.length}`);
}
const lifecycleInitial = lifecycleEvents[0].attributes;
const lifecycleInactive = lifecycleEvents[1].attributes;
const lifecycleBackground = lifecycleEvents[2].attributes;
if (
  lifecycleInitial.name !== "app_state:active" ||
  lifecycleInitial.metadata.toAppState !== "active" ||
  lifecycleInitial.metadata.traceId !== providerTrace.traceId
) {
  throw new Error(`unexpected initial lifecycle span: ${JSON.stringify(lifecycleInitial)}`);
}
if (
  lifecycleInactive.name !== "app_state:active->inactive" ||
  lifecycleInactive.durationMs !== 125 ||
  lifecycleInactive.metadata.fromAppState !== "active" ||
  lifecycleInactive.metadata.toAppState !== "inactive" ||
  lifecycleInactive.metadata.nested !== undefined
) {
  throw new Error(`unexpected inactive lifecycle span: ${JSON.stringify(lifecycleInactive)}`);
}
if (
  lifecycleBackground.name !== "app_state:inactive->background" ||
  lifecycleBackground.durationMs !== 475 ||
  lifecycleBackground.metadata.appState !== "background"
) {
  throw new Error(`unexpected background lifecycle span: ${JSON.stringify(lifecycleBackground)}`);
}
const handledError = new Error("Checkout failed on device");
handledError.stack = "Error: Checkout failed on device\n    at checkout (app://Checkout.js:12:4)";
captureReactNativeError(client, handledError, {
  id: "evt_issue_react_native_error",
  timestamp: "2026-06-02T10:00:09Z",
  platform,
  appState,
  screen: "Checkout",
  trace: providerTrace,
  metadata: { flow: "checkout", handled: true }
});
captureReactNativeError(client, "non-error rejection", {
  id: "evt_issue_react_native_non_error",
  timestamp: "2026-06-02T10:00:10Z",
  level: "warning",
  platform,
  appState,
  trace: providerTrace,
  metadata: { handled: true }
});
captureReactNativeError(client, handledError, {
  id: "evt_issue_react_native_stack",
  timestamp: "2026-06-02T10:00:11Z",
  includeStack: true,
  platform,
  appState,
  screen: "Checkout",
  trace: providerTrace
});

const tracedFetchRequests = [];
const tracedFetch = createTraceparentFetch({
  fetchImpl: async (input, init = {}) => {
    tracedFetchRequests.push({ input, init });
    return { status: 204 };
  },
  traceparentFactory: () => createReactNativeTraceparent({
    randomValues: deterministicBytes
  }),
  tracePropagationTargets: ["https://api.example.test/", /^\/mobile-api\//u]
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
await tracedFetch("/mobile-api/cart");
const activeTraceFetchRequests = [];
let activeTraceFetchPromise;
withLogBrewTrace(providerTrace, () => {
  const activeTraceFetch = createTraceparentFetch({
    fetchImpl: async (input, init = {}) => {
      activeTraceFetchRequests.push({ input, init });
      return { status: 204 };
    },
    tracePropagationTargets: ["https://api.example.test/"]
  });
  activeTraceFetchPromise = activeTraceFetch("https://api.example.test/checkout");
});
await activeTraceFetchPromise;
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
if (activeTraceFetchRequests[0].init.headers.traceparent !== providerTraceHeaders.traceparent) {
  throw new Error(`active trace fetch should reuse provider trace: ${activeTraceFetchRequests[0].init.headers.traceparent}`);
}
if (getActiveLogBrewTrace() !== undefined) {
  throw new Error("active trace should be cleared after scoped fetch");
}

const resourceFetchClient = createLogBrewReactNativeClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "react-native-resource-fetch-smoke",
  sdkVersion: "0.1.0",
  maxRetries: 1
});
const resourceFetchRequests = [];
const resourceFetchTimes = [1000, 1167, 2000, 2031];
const resourceFetchTimestamps = ["2026-06-02T10:00:12Z", "2026-06-02T10:00:13Z"];
const resourceFetch = createReactNativeResourceFetch(resourceFetchClient, {
  fetchImpl: async (input, init = {}) => {
    resourceFetchRequests.push({ input, init });
    if (String(input).includes("/api/fail")) {
      throw new TypeError("network request failed");
    }
    return { status: 202 };
  },
  metadata: { flow: "checkout", nested: { dropped: true } },
  metadataFactory: createReactNativeGraphQLMetadataFactory(),
  now: () => resourceFetchTimestamps.shift(),
  nowMs: () => resourceFetchTimes.shift(),
  platform,
  appState,
  screen: "Checkout",
  sessionId: "session_mobile_001",
  trace: providerTrace,
  tracePropagationTargets: ["https://api.example.test/"]
});
await resourceFetch("https://api.example.test/api/checkout?email=dev@example.test", {
  method: "POST",
  headers: { accept: "application/json" },
  body: JSON.stringify({
    query: "mutation CheckoutSubmit($email: String!) { checkout(email: $email) { id } }",
    variables: { email: "dev@example.test" }
  })
});
try {
  await resourceFetch("https://cdn.example.test/api/fail?debug=hidden", {
    method: "GET"
  });
} catch (error) {
  if (!(error instanceof TypeError)) {
    throw error;
  }
}
const resourceFetchEvents = JSON.parse(resourceFetchClient.previewJson()).events;
if (resourceFetchEvents.length !== 2) {
  throw new Error(`expected two resource fetch spans, got ${resourceFetchEvents.length}`);
}
if (resourceFetchRequests[0].init.headers.traceparent !== providerTraceHeaders.traceparent) {
  throw new Error(`resource fetch should propagate provider trace: ${resourceFetchRequests[0].init.headers.traceparent}`);
}
if (resourceFetchRequests[1].init.headers?.traceparent !== undefined) {
  throw new Error("non-target resource fetch should not receive traceparent");
}
const resourceFetchSuccess = resourceFetchEvents[0].attributes;
const resourceFetchFailure = resourceFetchEvents[1].attributes;
if (
  resourceFetchSuccess.name !== "POST /api/checkout" ||
  resourceFetchSuccess.status !== "ok" ||
  resourceFetchSuccess.durationMs !== 167 ||
  resourceFetchSuccess.metadata.routeTemplate !== "/api/checkout" ||
  resourceFetchSuccess.metadata.graphqlOperationName !== "CheckoutSubmit" ||
  resourceFetchSuccess.metadata.graphqlOperationType !== "mutation" ||
  resourceFetchSuccess.metadata.traceId !== providerTrace.traceId ||
  resourceFetchSuccess.metadata.nested !== undefined
) {
  throw new Error(`unexpected resource fetch success span: ${JSON.stringify(resourceFetchSuccess)}`);
}
if (JSON.stringify(resourceFetchEvents).includes("dev@example.test") || JSON.stringify(resourceFetchEvents).includes("checkout(email")) {
  throw new Error("GraphQL resource fetch metadata leaked request body content");
}
if (
  resourceFetchFailure.name !== "GET /api/fail" ||
  resourceFetchFailure.status !== "error" ||
  resourceFetchFailure.durationMs !== 31 ||
  resourceFetchFailure.metadata.fetchErrorName !== "TypeError" ||
  resourceFetchFailure.metadata.traceId !== providerTrace.traceId
) {
  throw new Error(`unexpected resource fetch failure span: ${JSON.stringify(resourceFetchFailure)}`);
}

const xhrClient = createLogBrewReactNativeClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "react-native-xhr-graphql-smoke",
  sdkVersion: "0.1.0",
  maxRetries: 1
});
const xhrRequests = [];
const xhrTimes = [2990, 3000, 3012, 3038];
class MockXMLHttpRequest {
  static HEADERS_RECEIVED = 2;
  static DONE = 4;

  constructor() {
    this.headers = {};
    this.listeners = new Map();
    this.readyState = 0;
    this.status = 0;
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }

  open(method, url) {
    this.method = method;
    this.url = url;
  }

  send(body) {
    xhrRequests.push({ body, headers: { ...this.headers }, method: this.method, url: this.url });
    this.readyState = MockXMLHttpRequest.HEADERS_RECEIVED;
    this.listeners.get("readystatechange")?.();
    this.responseText = "ok \u2713";
    this.status = 200;
    this.readyState = MockXMLHttpRequest.DONE;
    this.listeners.get("readystatechange")?.();
  }

  getResponseHeader() {
    return null;
  }

  setRequestHeader(name, value) {
    this.headers[String(name).toLowerCase()] = String(value);
  }
}
const xhrGlobalObject = { XMLHttpRequest: MockXMLHttpRequest };
const xhrInstrumentation = createLogBrewReactNativeInstrumentation(xhrClient, {
  globalObject: xhrGlobalObject,
  instrumentGlobalXMLHttpRequest: true,
  measureXhrResponseBodySize: true,
  metadata: { flow: "checkout" },
  metadataFactory: createReactNativeGraphQLMetadataFactory(),
  now: () => "2026-06-02T10:00:14Z",
  nowMs: () => xhrTimes.shift(),
  platform,
  appState,
  routeTemplateFactory: () => "/graphql",
  trace: providerTrace,
  tracePropagationTargets: ["https://api.example.test/"]
});
const xhr = new xhrGlobalObject.XMLHttpRequest();
xhr.open("POST", "https://api.example.test/graphql?email=dev@example.test");
xhr.send(JSON.stringify({
  query: "mutation CheckoutSubmit($email: String!) { checkout(email: $email) { id } }",
  variables: { email: "dev@example.test" }
}));
xhrInstrumentation.remove();
const xhrEvents = JSON.parse(xhrClient.previewJson()).events;
if (xhrEvents.length !== 1) {
  throw new Error(`expected one XHR GraphQL span, got ${xhrEvents.length}`);
}
if (xhrRequests[0].headers.traceparent !== providerTraceHeaders.traceparent) {
  throw new Error(`XHR should propagate provider trace: ${xhrRequests[0].headers.traceparent}`);
}
const xhrSpan = xhrEvents[0].attributes;
if (
  xhrSpan.name !== "POST /graphql" ||
  xhrSpan.status !== "ok" ||
  xhrSpan.durationMs !== 38 ||
  xhrSpan.metadata.routeTemplate !== "/graphql" ||
  xhrSpan.metadata.responseStartDurationMs !== 12 ||
  xhrSpan.metadata.responseSizeBytes !== 6 ||
  xhrSpan.metadata.graphqlOperationName !== "CheckoutSubmit" ||
  xhrSpan.metadata.graphqlOperationType !== "mutation" ||
  xhrSpan.metadata.traceId !== providerTrace.traceId
) {
  throw new Error(`unexpected XHR GraphQL span: ${JSON.stringify(xhrSpan)}`);
}
if (JSON.stringify(xhrEvents).includes("dev@example.test") || JSON.stringify(xhrEvents).includes("checkout(email")) {
  throw new Error("XHR GraphQL metadata leaked request body content");
}

const timelineClient = createLogBrewReactNativeClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "react-native-timeline-smoke",
  sdkVersion: "0.1.0",
  maxRetries: 1
});

function TimelineComponent() {
  const actions = useLogBrewNativeActions();
  actions.captureReactNativeAction({
    id: "evt_native_action_checkout_submit",
    timestamp: "2026-06-02T10:00:12Z",
    name: "checkout.submit",
    screen: "Checkout",
    sessionId: "session_mobile_001",
    traceId: "trace_mobile_001",
    metadata: {
      funnel: "checkout",
      step: "submit",
      nested: { dropped: true }
    }
  });
  actions.captureReactNativeNetwork({
    id: "evt_native_network_checkout",
    timestamp: "2026-06-02T10:00:13Z",
    method: "post",
    routeTemplate: "/api/checkout?email=dev@example.test#pay",
    statusCode: 503,
    durationMs: 241,
    screen: "Checkout",
    sessionId: "session_mobile_001",
    traceId: "trace_mobile_001"
  });
  return React.createElement("logbrew-timeline", { pending: actions.pendingEvents() });
}

await act(async () => {
  TestRenderer.create(
    React.createElement(
      LogBrewNativeProvider,
      { client: timelineClient, platform, appState, trace: providerTrace },
      React.createElement(TimelineComponent)
    )
  );
});
const directAction = createReactNativeActionEvent({
  id: "evt_native_action_direct",
  timestamp: "2026-06-02T10:00:14Z",
  platform,
  appState,
  name: "checkout.retry",
  screen: "Checkout",
  metadata: { funnel: "checkout", step: "retry" }
});
timelineClient.action(directAction.id, directAction.timestamp, directAction.attributes);
captureReactNativeAction(timelineClient, {
  id: "evt_native_action_direct_capture",
  timestamp: "2026-06-02T10:00:15Z",
  platform,
  appState,
  name: "checkout.cancel",
  screen: "Checkout"
});
const directNetwork = createReactNativeNetworkEvent({
  id: "evt_native_network_direct",
  timestamp: "2026-06-02T10:00:16Z",
  platform,
  appState,
  method: "get",
  routeTemplate: "/api/cart?itemId=123#items",
  statusCode: 200,
  durationMs: 42,
  screen: "Checkout"
});
timelineClient.action(directNetwork.id, directNetwork.timestamp, directNetwork.attributes);
captureReactNativeNetwork(timelineClient, {
  id: "evt_native_network_direct_capture",
  timestamp: "2026-06-02T10:00:17Z",
  platform,
  appState,
  method: "delete",
  routeTemplate: "/api/cart/item?itemId=123#remove",
  statusCode: 204,
  durationMs: 36,
  screen: "Checkout"
});
const timelineEvents = JSON.parse(timelineClient.previewJson()).events;
if (timelineEvents.length !== 6) {
  throw new Error(`expected six timeline events, got ${timelineEvents.length}`);
}
const timelineAction = timelineEvents[0].attributes;
if (timelineAction.metadata.source !== "react-native.action" || timelineAction.metadata.platform !== "ios") {
  throw new Error(`unexpected action metadata: ${JSON.stringify(timelineAction.metadata)}`);
}
if (timelineAction.metadata.traceId !== providerTrace.traceId || timelineAction.metadata.spanId !== providerTrace.spanId) {
  throw new Error(`timeline action should include provider trace: ${JSON.stringify(timelineAction.metadata)}`);
}
if (timelineAction.metadata.nested !== undefined) {
  throw new Error("nested action metadata should be dropped");
}
const timelineNetwork = timelineEvents[1].attributes;
if (timelineNetwork.name !== "POST /api/checkout" || timelineNetwork.status !== "failure") {
  throw new Error(`unexpected network timeline event: ${JSON.stringify(timelineNetwork)}`);
}
if (timelineNetwork.metadata.routeTemplate !== "/api/checkout" || timelineNetwork.metadata.method !== "POST") {
  throw new Error(`expected sanitized network metadata: ${JSON.stringify(timelineNetwork.metadata)}`);
}
if (timelineEvents[4].attributes.metadata.routeTemplate !== "/api/cart") {
  throw new Error("direct network event should strip query and hash");
}
if (timelineEvents[5].attributes.metadata.routeTemplate !== "/api/cart/item") {
  throw new Error("captured network event should strip query and hash");
}

const preview = client.previewJson();
const transport = new RecordingTransport([{ statusCode: 503 }, { statusCode: 202 }]);
const response = await client.shutdown(transport);
console.log(preview);
console.error(JSON.stringify({
  ok: true,
  status: response.statusCode,
  attempts: response.attempts,
  events: 12,
  lifecycleEvents: lifecycleEvents.length,
  lifecycleSpan: lifecycleBackground.name,
  timelineEvents: timelineEvents.length,
  networkAction: timelineNetwork.name,
  listenerRemoved: appStateListener === null,
  propagatedTraceparent
}));

function deterministicBytes(length) {
  return Uint8Array.from({ length }, (_value, index) => index + 1);
}
EOF

node smoke.mjs > "$tmp_dir/native-smoke.stdout.json" 2> "$tmp_dir/native-smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/native-smoke.stdout.json" >/dev/null
python3 - "$tmp_dir/native-smoke.stdout.json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
events = payload["events"]
if len(events) != 12:
    raise SystemExit(f"expected 12 events, got {len(events)}")
if [event["type"] for event in events[:6]] != ["release", "environment", "issue", "log", "span", "action"]:
    raise SystemExit("first six event types did not match the public batch flow")
trace_id = "4bf92f3577b34da6a3ce929d0e0e4736"
span_id = "b7ad6b7169203331"
parent_span_id = "00f067aa0ba902b7"
for index in (2, 3, 5, 6, 7, 8, 9, 10, 11):
    metadata = events[index]["attributes"].get("metadata", {})
    if metadata.get("traceId") != trace_id or metadata.get("spanId") != span_id:
        raise SystemExit(f"event {index} is missing trace correlation: {metadata}")
    if metadata.get("parentSpanId") != parent_span_id:
        raise SystemExit(f"event {index} is missing parent span correlation: {metadata}")
screen = events[5]["attributes"]
if screen["name"] != "screen:Checkout" or screen["metadata"]["platform"] != "ios":
    raise SystemExit(f"unexpected screen event: {screen}")
if events[6]["attributes"]["metadata"]["appState"] != "background":
    raise SystemExit("missing background app-state event")
handled = events[9]["attributes"]
if handled["title"] != "React Native error: Checkout failed on device":
    raise SystemExit(f"unexpected handled error event: {handled}")
if handled["metadata"]["source"] != "react-native.error" or handled["metadata"]["screen"] != "Checkout":
    raise SystemExit(f"missing handled error metadata: {handled}")
if "errorStack" in handled["metadata"]:
    raise SystemExit("stack text should stay omitted by default")
non_error = events[10]["attributes"]
if non_error["level"] != "warning" or non_error["message"] != "non-error rejection":
    raise SystemExit(f"unexpected non-Error capture: {non_error}")
stacked = events[11]["attributes"]
if "errorStack" not in stacked["metadata"]:
    raise SystemExit("expected opt-in stack metadata")
PY
grep -q '"ok":true' "$tmp_dir/native-smoke.stderr.json"
grep -q '"attempts":2' "$tmp_dir/native-smoke.stderr.json"
grep -q '"listenerRemoved":true' "$tmp_dir/native-smoke.stderr.json"
grep -q '"lifecycleEvents":3' "$tmp_dir/native-smoke.stderr.json"
grep -q '"lifecycleSpan":"app_state:inactive->background"' "$tmp_dir/native-smoke.stderr.json"
grep -q '"timelineEvents":6' "$tmp_dir/native-smoke.stderr.json"
grep -q '"networkAction":"POST /api/checkout"' "$tmp_dir/native-smoke.stderr.json"
grep -q '"propagatedTraceparent":"00-0102030405060708090a0b0c0d0e0f10-0102030405060708-01"' "$tmp_dir/native-smoke.stderr.json"

node node_modules/@logbrew/react-native/examples/index.mjs navigation-resource-spans > "$tmp_dir/navigation-resource-spans.stdout.json" 2> "$tmp_dir/navigation-resource-spans.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/navigation-resource-spans.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/navigation-resource-spans.stderr.json"
grep -q '"events":4' "$tmp_dir/navigation-resource-spans.stderr.json"
grep -q '"navigationSpan":"navigation:CheckoutComplete"' "$tmp_dir/navigation-resource-spans.stderr.json"
grep -q '"resourceSpan":"POST /api/checkout"' "$tmp_dir/navigation-resource-spans.stderr.json"

cat > consumer.ts <<'EOF'
import React from "react";
import type { AppStateStatus } from "react-native";
import { RecordingTransport } from "@logbrew/sdk";
import {
  LogBrewNativeProvider,
  bindLogBrewTrace,
  captureAppStateChange,
  captureScreenView,
  createAppStateListener,
  createLogBrewReactNativeClient,
  captureReactNativeNavigationSpan,
  captureReactNativeResourceSpan,
  captureReactNativeAction,
  captureReactNativeError,
  captureReactNativeNetwork,
  createReactNavigationSpanListener,
  createReactNativeActionEvent,
  createReactNativeErrorEvent,
  createReactNativeNetworkEvent,
  createReactNativeNavigationSpanEvent,
  createReactNativeResourceSpanEvent,
  createReactNativeSpanAttributes,
  createReactNativeTraceContext,
  createReactNativeTraceHeaders,
  createReactNativeTraceparent,
  createTraceparentFetch,
  getActiveLogBrewTrace,
  getReactNativeTraceMetadata,
  useLogBrewNativeActions,
  withLogBrewTrace,
  type ReactNativeAppStateLike,
  type ReactNativePlatformLike,
  type ReactNativeTraceContext,
  type TracePropagationTarget
} from "@logbrew/react-native";
import {
  createLogBrewReactNativeInstrumentation,
  type ReactNativeInstrumentation
} from "@logbrew/react-native/instrumentation";
import {
  captureReactNativeLifecycleSpan,
  createAppStateLifecycleSpanListener,
  createReactNativeLifecycleSpanEvent
} from "@logbrew/react-native/lifecycle";
import {
  createLogBrewNativeBridgeScope,
  syncLogBrewNativeBridgeScope,
  withLogBrewNativeBridgeScope,
  type LogBrewNativeBridgeLike,
  type LogBrewNativeBridgeScope
} from "@logbrew/react-native/native-bridge";
import {
  createReactNativeGraphQLMetadataFactory,
  createReactNativeResourceFetch
} from "@logbrew/react-native/resource-fetch";

const platform: ReactNativePlatformLike = {
  OS: "android",
  Version: 35,
  isPad: false,
  constants: { isTesting: true }
};
const state: AppStateStatus = "active";
const appState: ReactNativeAppStateLike = {
  currentState: state,
  addEventListener(_type, listener) {
    listener("background");
    return { remove() {} };
  }
};
const client = createLogBrewReactNativeClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "typed-native-smoke",
  sdkVersion: "0.1.0"
});
const trace: ReactNativeTraceContext = createReactNativeTraceContext({
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  spanId: "b7ad6b7169203331"
});
const traceHeaders: { traceparent: string } = createReactNativeTraceHeaders(trace);
const metadata = getReactNativeTraceMetadata(trace);
const activeTraceId = withLogBrewTrace(trace, activeTrace => getActiveLogBrewTrace()?.traceId ?? activeTrace.traceId);
const bound = bindLogBrewTrace(trace, (value: string) => `${getActiveLogBrewTrace()?.spanId}:${value}`);
bound("typed");
const bridgeCalls: Array<LogBrewNativeBridgeScope | undefined> = [];
const bridge: LogBrewNativeBridgeLike = scope => {
  bridgeCalls.push(scope);
};
const bridgeScope = createLogBrewNativeBridgeScope({
  logger: "NativeCheckout",
  metadata: { routeTemplate: "/native/checkout" },
  screen: "Checkout",
  sessionId: "session_123",
  trace
});
syncLogBrewNativeBridgeScope(bridge, { logger: "NativeCheckout", trace });
const bridgeResult = withLogBrewNativeBridgeScope(bridge, {
  logger: "NativeCheckout",
  metadata: bridgeScope.metadata,
  screen: "Checkout",
  trace
}, scope => scope.trace?.traceId ?? "missing");
client.span("evt_span_trace", "2026-06-02T10:00:00Z", createReactNativeSpanAttributes({
  name: "typed.mobile",
  status: "ok",
  durationMs: 1,
  trace,
  metadata: { ...metadata, bridgeResult }
}));
const traceTargets: TracePropagationTarget[] = ["https://api.example.test/", /^\/mobile-api\//u];
const tracedFetch = createTraceparentFetch({
  fetchImpl: async () => ({ status: 204 }),
  trace,
  traceparentFactory: () => createReactNativeTraceparent({
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "b7ad6b7169203331"
  }),
  tracePropagationTargets: traceTargets
});
void tracedFetch("/mobile-api/ping");
void createTraceparentFetch({ fetchImpl: async () => ({ status: 204 }), trace, tracePropagationTargets: traceTargets })("/mobile-api/trace");
const resourceFetch = createReactNativeResourceFetch(client, {
  fetchImpl: async () => ({ status: 202 }),
  metadataFactory: createReactNativeGraphQLMetadataFactory(),
  trace,
  tracePropagationTargets: traceTargets
});
void resourceFetch("/mobile-api/resource", {
  body: JSON.stringify({ query: "query TypedSmoke { viewer { id } }" }),
  method: "POST"
});
class MockXMLHttpRequest {
  open(_method: string, _url: string) {}
  send(_body?: unknown) {}
  setRequestHeader(_name: string, _value: string) {}
}
const globalObject: {
  fetch: (input: string, init?: { method?: string }) => Promise<{ status: number }>;
  XMLHttpRequest: typeof MockXMLHttpRequest;
} = {
  fetch: async () => ({ status: 202 }),
  XMLHttpRequest: MockXMLHttpRequest
};
const instrumentation: ReactNativeInstrumentation<string, { method?: string }, { status: number }> = createLogBrewReactNativeInstrumentation(client, {
  appState,
  fetchImpl: async () => ({ status: 202 }),
  globalObject,
  instrumentGlobalFetch: true,
  instrumentGlobalXMLHttpRequest: true,
  measureXhrResponseBodySize: true,
  nativeBridge: bridge,
  platform,
  screen: "Checkout",
  trace,
  tracePropagationTargets: traceTargets
});
void instrumentation.resourceFetch("/mobile-api/instrumented", { method: "POST" });
void globalObject.fetch("/mobile-api/global", { method: "GET" });
void instrumentation.globalFetch?.fetch("/mobile-api/direct", { method: "GET" });
instrumentation.globalXMLHttpRequest?.stop();
instrumentation.withNativeBridgeScope(scope => scope.metadata);
instrumentation.remove();

captureScreenView(client, "Checkout", { platform, appState, trace });
captureAppStateChange(client, state, { platform, appState, trace });
const actionEvent = createReactNativeActionEvent({
  name: "checkout.submit",
  screen: "Checkout",
  sessionId: "session_123",
  traceId: "trace_123"
});
captureReactNativeAction(client, {
  name: actionEvent.attributes.name,
  screen: "Checkout",
  metadata: actionEvent.attributes.metadata
});
const networkEvent = createReactNativeNetworkEvent({
  method: "POST",
  routeTemplate: "/api/checkout?email=hidden",
  statusCode: 202,
  durationMs: 128,
  screen: "Checkout"
});
captureReactNativeNetwork(client, {
  name: networkEvent.attributes.name,
  method: "POST",
  routeTemplate: "/api/checkout",
  statusCode: 202
});
const navigationSpan = createReactNativeNavigationSpanEvent({
  routeName: "Checkout",
  previousRouteName: "Cart",
  actionType: "NAVIGATE",
  durationMs: 64,
  trace
});
captureReactNativeNavigationSpan(client, {
  routeName: "CheckoutComplete",
  routePath: "/checkout/complete?hidden=value",
  actionType: "NAVIGATE",
  durationMs: 72,
  trace,
  metadata: navigationSpan.attributes.metadata
});
const resourceSpan = createReactNativeResourceSpanEvent({
  method: "GET",
  routeTemplate: "/api/cart?itemId=123#items",
  statusCode: 200,
  durationMs: 42,
  trace
});
captureReactNativeResourceSpan(client, {
  name: resourceSpan.attributes.name,
  method: "POST",
  routeTemplate: "/api/checkout?email=hidden",
  statusCode: 202,
  durationMs: 128,
  trace
});
const lifecycleSpan = createReactNativeLifecycleSpanEvent({
  fromState: "active",
  toState: "background",
  durationMs: 640,
  screen: "Checkout",
  sessionId: "session_123",
  trace
});
captureReactNativeLifecycleSpan(client, {
  fromState: "background",
  toState: "active",
  durationMs: 320,
  screen: "Checkout",
  trace,
  metadata: lifecycleSpan.attributes.metadata
});
const stopLifecycle = createAppStateLifecycleSpanListener(client, appState, {
  captureInitialState: true,
  trace,
  platform,
  screen: "Checkout",
  sessionId: "session_123"
});
stopLifecycle();
let currentRoute = { key: "Checkout-1", name: "Checkout", path: "/checkout?email=hidden" };
const navigationListeners = new Map<string, (event?: unknown) => void>();
const navigationContainer = {
  addListener(eventName: string, listener: (event?: unknown) => void) {
    navigationListeners.set(eventName, listener);
    return { remove() { navigationListeners.delete(eventName); } };
  },
  getCurrentRoute() {
    return currentRoute;
  }
};
const stopNavigation = createReactNavigationSpanListener(client, navigationContainer, {
  trace,
  platform,
  appState,
  nowMs: () => 100,
  now: () => "2026-06-02T10:00:18Z"
});
navigationListeners.get("__unsafe_action__")?.({ data: { action: { type: "NAVIGATE" } } });
currentRoute = { key: "Done-1", name: "Done", path: "/done?email=hidden" };
navigationListeners.get("state")?.();
stopNavigation();
const errorEvent = createReactNativeErrorEvent(new Error("typed native error"), {
  platform,
  appState,
  screen: "Checkout"
});
captureReactNativeError(client, new Error("typed handled error"), { platform, appState, trace });
const remove = createAppStateListener(client, appState, { platform, trace });
remove();

function Component(): React.ReactElement {
  const actions = useLogBrewNativeActions();
  const currentTrace: ReactNativeTraceContext | undefined = actions.trace;
  actions.log("evt_log_001", "2026-06-02T10:00:03Z", {
    message: "worker started",
    level: "info",
    metadata: { activeTraceId, outgoing: traceHeaders.traceparent, hookTrace: currentTrace?.traceId ?? null }
  });
  actions.captureReactNativeError(new Error("hook handled error"));
  actions.captureReactNativeAction({
    name: "checkout.view",
    screen: "Checkout",
    metadata: { funnel: "checkout", step: "view" }
  });
  actions.captureReactNativeNetwork({
    method: "GET",
    routeTemplate: "/api/cart",
    statusCode: 200,
    durationMs: 42,
    screen: "Checkout"
  });
  actions.captureReactNativeNavigationSpan({
    routeName: "Checkout",
    durationMs: 10
  });
  actions.captureReactNativeResourceSpan({
    method: "GET",
    routeTemplate: "/api/cart",
    statusCode: 200,
    durationMs: 42
  });
  void actions.flush(RecordingTransport.alwaysAccept());
  return React.createElement("span", { pending: actions.pendingEvents(), issue: errorEvent.attributes.title }, "typed");
}

export const app = React.createElement(
  LogBrewNativeProvider,
  { client, platform, appState, trace },
  React.createElement(Component)
);
EOF
cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "jsx": "react-jsx",
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["consumer.ts"]
}
EOF
npx tsc --project tsconfig.json

node node_modules/@logbrew/react-native/examples/index.mjs --help > "$tmp_dir/launcher-help.txt"
grep -q 'node node_modules/@logbrew/react-native/examples/index.mjs instrumentation-kit' "$tmp_dir/launcher-help.txt"
grep -q 'node node_modules/@logbrew/react-native/examples/index.mjs lifecycle-spans' "$tmp_dir/launcher-help.txt"
grep -q 'node node_modules/@logbrew/react-native/examples/index.mjs native-bridge-scope' "$tmp_dir/launcher-help.txt"
grep -q 'node node_modules/@logbrew/react-native/examples/index.mjs navigation-resource-spans' "$tmp_dir/launcher-help.txt"
grep -q 'node node_modules/@logbrew/react-native/examples/index.mjs readme-example' "$tmp_dir/launcher-help.txt"
grep -q 'node node_modules/@logbrew/react-native/examples/index.mjs resource-fetch-spans' "$tmp_dir/launcher-help.txt"
grep -q 'node node_modules/@logbrew/react-native/examples/index.mjs trace-correlation' "$tmp_dir/launcher-help.txt"
node node_modules/@logbrew/react-native/examples/index.mjs --list > "$tmp_dir/launcher-list.txt"
grep -q 'instrumentation-kit -> node node_modules/@logbrew/react-native/examples/index.mjs instrumentation-kit' "$tmp_dir/launcher-list.txt"
grep -q 'lifecycle-spans -> node node_modules/@logbrew/react-native/examples/index.mjs lifecycle-spans' "$tmp_dir/launcher-list.txt"
grep -q 'native-bridge-scope -> node node_modules/@logbrew/react-native/examples/index.mjs native-bridge-scope' "$tmp_dir/launcher-list.txt"
grep -q 'navigation-resource-spans -> node node_modules/@logbrew/react-native/examples/index.mjs navigation-resource-spans' "$tmp_dir/launcher-list.txt"
grep -q 'real-user-smoke -> node node_modules/@logbrew/react-native/examples/index.mjs real-user-smoke' "$tmp_dir/launcher-list.txt"
grep -q 'resource-fetch-spans -> node node_modules/@logbrew/react-native/examples/index.mjs resource-fetch-spans' "$tmp_dir/launcher-list.txt"
grep -q 'trace-correlation -> node node_modules/@logbrew/react-native/examples/index.mjs trace-correlation' "$tmp_dir/launcher-list.txt"
node node_modules/@logbrew/react-native/examples/index.mjs readme-example > "$tmp_dir/example-readme.stdout.json" 2> "$tmp_dir/example-readme.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/example-readme.stdout.json" >/dev/null
grep -q '"events":6' "$tmp_dir/example-readme.stderr.json"
node node_modules/@logbrew/react-native/examples/index.mjs > "$tmp_dir/example-default.stdout.json" 2> "$tmp_dir/example-default.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/example-default.stdout.json" >/dev/null
grep -q '"attempts":2' "$tmp_dir/example-default.stderr.json"
grep -q '"events":8' "$tmp_dir/example-default.stderr.json"
grep -q '"timelineEvents":3' "$tmp_dir/example-default.stderr.json"
grep -q '"networkAction":"POST /api/checkout"' "$tmp_dir/example-default.stderr.json"
node node_modules/@logbrew/react-native/examples/index.mjs lifecycle-spans > "$tmp_dir/example-lifecycle.stdout.json" 2> "$tmp_dir/example-lifecycle.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/example-lifecycle.stdout.json" >/dev/null
grep -q '"events":4' "$tmp_dir/example-lifecycle.stderr.json"
grep -q '"inactiveSpan":"app_state:active->inactive"' "$tmp_dir/example-lifecycle.stderr.json"
grep -q '"backgroundSpan":"app_state:inactive->background"' "$tmp_dir/example-lifecycle.stderr.json"
grep -q '"listenerRemoved":true' "$tmp_dir/example-lifecycle.stderr.json"
node node_modules/@logbrew/react-native/examples/index.mjs native-bridge-scope > "$tmp_dir/example-native-bridge.stdout.json" 2> "$tmp_dir/example-native-bridge.stderr.json"
python3 "$repo_root/scripts/check_react_native_native_bridge_payload.py" "$tmp_dir/example-native-bridge.stdout.json" "$tmp_dir/example-native-bridge.stderr.json"
node node_modules/@logbrew/react-native/examples/index.mjs instrumentation-kit > "$tmp_dir/example-instrumentation.stdout.json" 2> "$tmp_dir/example-instrumentation.stderr.json"
python3 "$repo_root/scripts/check_react_native_instrumentation_payload.py" "$tmp_dir/example-instrumentation.stdout.json" "$tmp_dir/example-instrumentation.stderr.json"
node node_modules/@logbrew/react-native/examples/index.mjs trace-correlation > "$tmp_dir/example-trace.stdout.json" 2> "$tmp_dir/example-trace.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/example-trace.stdout.json" >/dev/null
python3 - "$tmp_dir/example-trace.stdout.json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
events = payload["events"]
if len(events) != 5:
    raise SystemExit(f"expected five trace-correlation events, got {len(events)}")
for event in events:
    if event["type"] == "span":
        if event["attributes"]["traceId"] != "4bf92f3577b34da6a3ce929d0e0e4736":
            raise SystemExit(f"span trace missing: {event}")
        continue
    metadata = event["attributes"].get("metadata", {})
    if metadata.get("traceId") != "4bf92f3577b34da6a3ce929d0e0e4736":
        raise SystemExit(f"event trace missing: {event}")
    if "errorStack" in metadata:
        raise SystemExit("trace example should not include stack text")
PY
grep -q '"events":5' "$tmp_dir/example-trace.stderr.json"
grep -q '"propagatedTraceparent":"00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01"' "$tmp_dir/example-trace.stderr.json"
node node_modules/@logbrew/react-native/examples/index.mjs resource-fetch-spans > "$tmp_dir/example-resource-fetch.stdout.json" 2> "$tmp_dir/example-resource-fetch.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/example-resource-fetch.stdout.json" >/dev/null
grep -q '"events":2' "$tmp_dir/example-resource-fetch.stderr.json"
grep -q '"successSpan":"POST /api/checkout"' "$tmp_dir/example-resource-fetch.stderr.json"
grep -q '"failureSpan":"GET /api/fail"' "$tmp_dir/example-resource-fetch.stderr.json"
grep -q '"propagatedTraceparent":"00-4bf92f3577b34da6a3ce929d0e0e4736-c2ad6b7169204442-01"' "$tmp_dir/example-resource-fetch.stderr.json"
grep -q '"listenerRemoved":true' "$tmp_dir/example-default.stderr.json"
grep -q '"propagatedTraceparent":"00-0102030405060708090a0b0c0d0e0f10-0102030405060708-01"' "$tmp_dir/example-default.stderr.json"
npm --prefix node_modules/@logbrew/react-native/examples run list > "$tmp_dir/npm-helper-list.txt"
grep -q 'instrumentation-kit -> node node_modules/@logbrew/react-native/examples/index.mjs instrumentation-kit' "$tmp_dir/npm-helper-list.txt"
grep -q 'lifecycle-spans -> node node_modules/@logbrew/react-native/examples/index.mjs lifecycle-spans' "$tmp_dir/npm-helper-list.txt"
grep -q 'native-bridge-scope -> node node_modules/@logbrew/react-native/examples/index.mjs native-bridge-scope' "$tmp_dir/npm-helper-list.txt"
grep -q 'navigation-resource-spans -> node node_modules/@logbrew/react-native/examples/index.mjs navigation-resource-spans' "$tmp_dir/npm-helper-list.txt"
grep -q 'readme-example -> node node_modules/@logbrew/react-native/examples/index.mjs readme-example' "$tmp_dir/npm-helper-list.txt"
grep -q 'resource-fetch-spans -> node node_modules/@logbrew/react-native/examples/index.mjs resource-fetch-spans' "$tmp_dir/npm-helper-list.txt"
npm --prefix node_modules/@logbrew/react-native/examples run help > "$tmp_dir/npm-helper-help.txt"
grep -q 'npm --prefix node_modules/@logbrew/react-native/examples run instrumentation-kit' "$tmp_dir/npm-helper-help.txt"
grep -q 'npm --prefix node_modules/@logbrew/react-native/examples run lifecycle-spans' "$tmp_dir/npm-helper-help.txt"
grep -q 'npm --prefix node_modules/@logbrew/react-native/examples run native-bridge-scope' "$tmp_dir/npm-helper-help.txt"
grep -q 'npm --prefix node_modules/@logbrew/react-native/examples run real-user-smoke' "$tmp_dir/npm-helper-help.txt"
grep -q 'npm --prefix node_modules/@logbrew/react-native/examples run resource-fetch-spans' "$tmp_dir/npm-helper-help.txt"
npm --prefix node_modules/@logbrew/react-native/examples run --silent native-bridge-scope > "$tmp_dir/npm-helper-native-bridge.stdout.json" 2> "$tmp_dir/npm-helper-native-bridge.stderr.json"
python3 "$repo_root/scripts/check_react_native_native_bridge_payload.py" "$tmp_dir/npm-helper-native-bridge.stdout.json" "$tmp_dir/npm-helper-native-bridge.stderr.json"
npm --prefix node_modules/@logbrew/react-native/examples run --silent instrumentation-kit > "$tmp_dir/npm-helper-instrumentation.stdout.json" 2> "$tmp_dir/npm-helper-instrumentation.stderr.json"
python3 "$repo_root/scripts/check_react_native_instrumentation_payload.py" "$tmp_dir/npm-helper-instrumentation.stdout.json" "$tmp_dir/npm-helper-instrumentation.stderr.json"
npm --prefix node_modules/@logbrew/react-native/examples run --silent real-user-smoke > "$tmp_dir/npm-helper-smoke.stdout.json" 2> "$tmp_dir/npm-helper-smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/npm-helper-smoke.stdout.json" >/dev/null
grep -q '"attempts":2' "$tmp_dir/npm-helper-smoke.stderr.json"
grep -q '"timelineEvents":3' "$tmp_dir/npm-helper-smoke.stderr.json"
grep -q '"networkAction":"POST /api/checkout"' "$tmp_dir/npm-helper-smoke.stderr.json"
grep -q '"propagatedTraceparent":"00-0102030405060708090a0b0c0d0e0f10-0102030405060708-01"' "$tmp_dir/npm-helper-smoke.stderr.json"

echo "react native real-user smoke passed with react-native@$react_native_version react@$react_version react-test-renderer@$renderer_version"
