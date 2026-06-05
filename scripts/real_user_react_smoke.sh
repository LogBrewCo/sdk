#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

core_pack_json="$tmp_dir/core-pack.json"
react_pack_json="$tmp_dir/react-pack.json"
(cd "$repo_root/js/logbrew-js" && npm pack --json --pack-destination "$tmp_dir") > "$core_pack_json"
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
react_tgz="$tmp_dir/$react_tgz"
test -f "$core_tgz"
test -f "$react_tgz"

tar -tzf "$react_tgz" > "$tmp_dir/react-tarball.txt"
grep -q '^package/README.md$' "$tmp_dir/react-tarball.txt"
grep -q '^package/index.js$' "$tmp_dir/react-tarball.txt"
grep -q '^package/index.cjs$' "$tmp_dir/react-tarball.txt"
grep -q '^package/index.d.ts$' "$tmp_dir/react-tarball.txt"
grep -q '^package/index.d.cts$' "$tmp_dir/react-tarball.txt"
grep -q '^package/examples/index.mjs$' "$tmp_dir/react-tarball.txt"
grep -q '^package/examples/package.json$' "$tmp_dir/react-tarball.txt"
grep -q '^package/examples/readme-example.mjs$' "$tmp_dir/react-tarball.txt"
grep -q '^package/examples/real-user-smoke.mjs$' "$tmp_dir/react-tarball.txt"
tar -xOf "$react_tgz" package/README.md > "$tmp_dir/react-readme.md"
grep -q 'npm install @logbrew/sdk @logbrew/react react' "$tmp_dir/react-readme.md"
grep -q 'pnpm add @logbrew/sdk @logbrew/react react' "$tmp_dir/react-readme.md"
grep -q 'LOGBREW_CLIENT_KEY' "$tmp_dir/react-readme.md"
grep -q 'LogBrewProvider' "$tmp_dir/react-readme.md"
grep -q 'LogBrewErrorBoundary' "$tmp_dir/react-readme.md"
grep -q 'useLogBrewActions' "$tmp_dir/react-readme.md"
grep -q 'captureReactError' "$tmp_dir/react-readme.md"
grep -q 'createTraceparentFetch' "$tmp_dir/react-readme.md"
grep -q 'createReactTraceparent' "$tmp_dir/react-readme.md"
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
  "$react_tgz" \
  "react@$react_version" \
  "react-dom@$react_dom_version" \
  "react-test-renderer@$renderer_version" \
  typescript \
  @types/react \
  @types/react-dom >/dev/null

grep -q '"@logbrew/sdk": "file:' package.json
grep -q '"@logbrew/react": "file:' package.json
grep -q '"react":' package.json
grep -q '"react-dom":' package.json
grep -q '"react-test-renderer":' package.json
grep -q '"@logbrew/react"' package-lock.json
grep -q '"@logbrew/sdk"' package-lock.json
npm ls @logbrew/sdk @logbrew/react react react-dom react-test-renderer >/dev/null
npm explain @logbrew/react > "$tmp_dir/npm-explain-react.txt"
grep -q '@logbrew/react@0.1.0' "$tmp_dir/npm-explain-react.txt"
npm list --depth=0 > "$tmp_dir/npm-list-depth0.txt"
grep -q '@logbrew/react@0.1.0' "$tmp_dir/npm-list-depth0.txt"
grep -q '@logbrew/sdk@0.1.0' "$tmp_dir/npm-list-depth0.txt"
npm list --json --depth=0 > "$tmp_dir/npm-list-depth0.json"
python3 - "$tmp_dir/npm-list-depth0.json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
deps = payload.get("dependencies", {})
for name in ("@logbrew/react", "@logbrew/sdk", "react", "react-dom", "react-test-renderer"):
    if name not in deps:
        raise SystemExit(f"missing npm dependency entry: {name}")
PY

cat > smoke.mjs <<'EOF'
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";
import { RecordingTransport } from "@logbrew/sdk";
import {
  LogBrewErrorBoundary,
  LogBrewProvider,
  captureReactError,
  createLogBrewReactClient,
  createReactErrorEvent,
  createReactTraceparent,
  createTraceparentFetch,
  shouldPropagateTraceparent,
  useLogBrew,
  useLogBrewActions
} from "@logbrew/react";

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

const markup = renderToStaticMarkup(
  React.createElement(LogBrewProvider, { client }, React.createElement(SmokeComponent))
);
if (!markup.includes('data-pending="6"')) {
  throw new Error(`provider did not expose queued events: ${markup}`);
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
  propagatedTraceparent,
  rendered: true
}));

function deterministicBytes(length) {
  return Uint8Array.from({ length }, (_value, index) => index + 1);
}
EOF

node smoke.mjs > "$tmp_dir/react-smoke.stdout.json" 2> "$tmp_dir/react-smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/react-smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/react-smoke.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/react-smoke.stderr.json"
grep -q '"attempts":2' "$tmp_dir/react-smoke.stderr.json"
grep -q '"errorAttempts":2' "$tmp_dir/react-smoke.stderr.json"
grep -q '"errorEvents":3' "$tmp_dir/react-smoke.stderr.json"
grep -q '"propagatedTraceparent":"00-0102030405060708090a0b0c0d0e0f10-0102030405060708-01"' "$tmp_dir/react-smoke.stderr.json"
grep -q '"rendered":true' "$tmp_dir/react-smoke.stderr.json"

cat > consumer.ts <<'EOF'
import React from "react";
import { RecordingTransport } from "@logbrew/sdk";
import {
  LogBrewErrorBoundary,
  LogBrewProvider,
  captureReactError,
  createLogBrewReactClient,
  createReactErrorEvent,
  createReactTraceparent,
  createTraceparentFetch,
  useLogBrew,
  useLogBrewActions,
  type LogBrewActions,
  type ReactErrorEvent,
  type TracePropagationTarget
} from "@logbrew/react";

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
captureReactError(client, new Error("typed handled error"), {
  componentStack: "\n    at Component"
});

function Component(): React.ReactElement {
  const directClient = useLogBrew();
  const actions: LogBrewActions = useLogBrewActions();
  actions.log("evt_log_001", "2026-06-02T10:00:03Z", {
    message: "worker started",
    level: "info"
  });
  actions.captureReactError(new Error("typed hook error"), {
    componentStack: "\n    at Component"
  });
  void actions.flush(RecordingTransport.alwaysAccept());
  return React.createElement("span", { "data-pending": directClient.pendingEvents(), "data-event": typedErrorEvent.id }, "typed");
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
EOF
node cjs-smoke.cjs

node node_modules/@logbrew/react/examples/index.mjs --help > "$tmp_dir/launcher-help.txt"
grep -q 'node node_modules/@logbrew/react/examples/index.mjs readme-example' "$tmp_dir/launcher-help.txt"
node node_modules/@logbrew/react/examples/index.mjs --list > "$tmp_dir/launcher-list.txt"
grep -q 'real-user-smoke -> node node_modules/@logbrew/react/examples/index.mjs real-user-smoke' "$tmp_dir/launcher-list.txt"
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
grep -q 'readme-example -> node node_modules/@logbrew/react/examples/index.mjs readme-example' "$tmp_dir/npm-helper-list.txt"
npm --prefix node_modules/@logbrew/react/examples run help > "$tmp_dir/npm-helper-help.txt"
grep -q 'npm --prefix node_modules/@logbrew/react/examples run real-user-smoke' "$tmp_dir/npm-helper-help.txt"
npm --prefix node_modules/@logbrew/react/examples run --silent real-user-smoke > "$tmp_dir/npm-helper-smoke.stdout.json" 2> "$tmp_dir/npm-helper-smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/npm-helper-smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/npm-helper-smoke.stdout.json" >/dev/null
grep -q '"attempts":2' "$tmp_dir/npm-helper-smoke.stderr.json"
grep -q '"manualErrorAttempts":2' "$tmp_dir/npm-helper-smoke.stderr.json"
grep -q '"manualErrorEvents":3' "$tmp_dir/npm-helper-smoke.stderr.json"
grep -q '"propagatedTraceparent":"00-0102030405060708090a0b0c0d0e0f10-0102030405060708-01"' "$tmp_dir/npm-helper-smoke.stderr.json"

echo "react real-user smoke passed with react@$react_version react-dom@$react_dom_version react-test-renderer@$renderer_version"
