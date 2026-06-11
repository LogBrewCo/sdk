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
grep -q '^package/examples/index.mjs$' "$tmp_dir/native-tarball.txt"
grep -q '^package/examples/package.json$' "$tmp_dir/native-tarball.txt"
grep -q '^package/examples/readme-example.mjs$' "$tmp_dir/native-tarball.txt"
grep -q '^package/examples/real-user-smoke.mjs$' "$tmp_dir/native-tarball.txt"
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
node -e 'const native = require("@logbrew/react-native"); if (typeof native.createLogBrewReactNativeClient !== "function" || typeof native.createTraceparentFetch !== "function" || typeof native.createReactNativeTraceparent !== "function" || typeof native.captureReactNativeError !== "function" || typeof native.captureReactNativeAction !== "function" || typeof native.captureReactNativeNetwork !== "function" || typeof native.createReactNativeErrorEvent !== "function" || typeof native.createReactNativeActionEvent !== "function" || typeof native.createReactNativeNetworkEvent !== "function" || typeof native.default !== "object") process.exit(1)'

cat > smoke.mjs <<'EOF'
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { RecordingTransport } from "@logbrew/sdk";
import {
  LogBrewNativeProvider,
  captureAppStateChange,
  captureReactNativeAction,
  captureReactNativeError,
  captureReactNativeNetwork,
  captureScreenView,
  createAppStateListener,
  createLogBrewReactNativeClient,
  createReactNativeActionEvent,
  createReactNativeNetworkEvent,
  createReactNativeTraceparent,
  createTraceparentFetch,
  getReactNativeContext,
  shouldPropagateTraceparent,
  useLogBrewNativeActions
} from "@logbrew/react-native";

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
      { client, platform, appState },
      React.createElement(CaptureComponent)
    )
  );
});

const stopListening = createAppStateListener(client, appState, {
  id: "evt_action_background",
  timestamp: "2026-06-02T10:00:06Z",
  platform
});
appStateListener("background");
stopListening();
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
const handledError = new Error("Checkout failed on device");
handledError.stack = "Error: Checkout failed on device\n    at checkout (app://Checkout.js:12:4)";
captureReactNativeError(client, handledError, {
  id: "evt_issue_react_native_error",
  timestamp: "2026-06-02T10:00:09Z",
  platform,
  appState,
  screen: "Checkout",
  metadata: { flow: "checkout", handled: true }
});
captureReactNativeError(client, "non-error rejection", {
  id: "evt_issue_react_native_non_error",
  timestamp: "2026-06-02T10:00:10Z",
  level: "warning",
  platform,
  appState,
  metadata: { handled: true }
});
captureReactNativeError(client, handledError, {
  id: "evt_issue_react_native_stack",
  timestamp: "2026-06-02T10:00:11Z",
  includeStack: true,
  platform,
  appState,
  screen: "Checkout"
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
      { client: timelineClient, platform, appState },
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
grep -q '"timelineEvents":6' "$tmp_dir/native-smoke.stderr.json"
grep -q '"networkAction":"POST /api/checkout"' "$tmp_dir/native-smoke.stderr.json"
grep -q '"propagatedTraceparent":"00-0102030405060708090a0b0c0d0e0f10-0102030405060708-01"' "$tmp_dir/native-smoke.stderr.json"

cat > consumer.ts <<'EOF'
import React from "react";
import type { AppStateStatus } from "react-native";
import { RecordingTransport } from "@logbrew/sdk";
import {
  LogBrewNativeProvider,
  captureAppStateChange,
  captureScreenView,
  createAppStateListener,
  createLogBrewReactNativeClient,
  captureReactNativeAction,
  captureReactNativeError,
  captureReactNativeNetwork,
  createReactNativeActionEvent,
  createReactNativeErrorEvent,
  createReactNativeNetworkEvent,
  createReactNativeTraceparent,
  createTraceparentFetch,
  useLogBrewNativeActions,
  type ReactNativeAppStateLike,
  type ReactNativePlatformLike,
  type TracePropagationTarget
} from "@logbrew/react-native";

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
const traceTargets: TracePropagationTarget[] = ["https://api.example.test/", /^\/mobile-api\//u];
const tracedFetch = createTraceparentFetch({
  fetchImpl: async () => ({ status: 204 }),
  traceparentFactory: () => createReactNativeTraceparent({
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "b7ad6b7169203331"
  }),
  tracePropagationTargets: traceTargets
});
void tracedFetch("/mobile-api/ping");

captureScreenView(client, "Checkout", { platform, appState });
captureAppStateChange(client, state, { platform, appState });
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
const errorEvent = createReactNativeErrorEvent(new Error("typed native error"), {
  platform,
  appState,
  screen: "Checkout"
});
captureReactNativeError(client, new Error("typed handled error"), { platform, appState });
const remove = createAppStateListener(client, appState, { platform });
remove();

function Component(): React.ReactElement {
  const actions = useLogBrewNativeActions();
  actions.log("evt_log_001", "2026-06-02T10:00:03Z", {
    message: "worker started",
    level: "info"
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
  void actions.flush(RecordingTransport.alwaysAccept());
  return React.createElement("span", { pending: actions.pendingEvents(), issue: errorEvent.attributes.title }, "typed");
}

export const app = React.createElement(
  LogBrewNativeProvider,
  { client, platform, appState },
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
grep -q 'node node_modules/@logbrew/react-native/examples/index.mjs readme-example' "$tmp_dir/launcher-help.txt"
node node_modules/@logbrew/react-native/examples/index.mjs --list > "$tmp_dir/launcher-list.txt"
grep -q 'real-user-smoke -> node node_modules/@logbrew/react-native/examples/index.mjs real-user-smoke' "$tmp_dir/launcher-list.txt"
node node_modules/@logbrew/react-native/examples/index.mjs readme-example > "$tmp_dir/example-readme.stdout.json" 2> "$tmp_dir/example-readme.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/example-readme.stdout.json" >/dev/null
grep -q '"events":6' "$tmp_dir/example-readme.stderr.json"
node node_modules/@logbrew/react-native/examples/index.mjs > "$tmp_dir/example-default.stdout.json" 2> "$tmp_dir/example-default.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/example-default.stdout.json" >/dev/null
grep -q '"attempts":2' "$tmp_dir/example-default.stderr.json"
grep -q '"events":8' "$tmp_dir/example-default.stderr.json"
grep -q '"timelineEvents":2' "$tmp_dir/example-default.stderr.json"
grep -q '"networkAction":"POST /api/checkout"' "$tmp_dir/example-default.stderr.json"
grep -q '"listenerRemoved":true' "$tmp_dir/example-default.stderr.json"
grep -q '"propagatedTraceparent":"00-0102030405060708090a0b0c0d0e0f10-0102030405060708-01"' "$tmp_dir/example-default.stderr.json"
npm --prefix node_modules/@logbrew/react-native/examples run list > "$tmp_dir/npm-helper-list.txt"
grep -q 'readme-example -> node node_modules/@logbrew/react-native/examples/index.mjs readme-example' "$tmp_dir/npm-helper-list.txt"
npm --prefix node_modules/@logbrew/react-native/examples run help > "$tmp_dir/npm-helper-help.txt"
grep -q 'npm --prefix node_modules/@logbrew/react-native/examples run real-user-smoke' "$tmp_dir/npm-helper-help.txt"
npm --prefix node_modules/@logbrew/react-native/examples run --silent real-user-smoke > "$tmp_dir/npm-helper-smoke.stdout.json" 2> "$tmp_dir/npm-helper-smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/npm-helper-smoke.stdout.json" >/dev/null
grep -q '"attempts":2' "$tmp_dir/npm-helper-smoke.stderr.json"
grep -q '"timelineEvents":2' "$tmp_dir/npm-helper-smoke.stderr.json"
grep -q '"networkAction":"POST /api/checkout"' "$tmp_dir/npm-helper-smoke.stderr.json"
grep -q '"propagatedTraceparent":"00-0102030405060708090a0b0c0d0e0f10-0102030405060708-01"' "$tmp_dir/npm-helper-smoke.stderr.json"

echo "react native real-user smoke passed with react-native@$react_native_version react@$react_version react-test-renderer@$renderer_version"
