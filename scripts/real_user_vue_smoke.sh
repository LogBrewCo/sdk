#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

core_pack_json="$tmp_dir/core-pack.json"
vue_pack_json="$tmp_dir/vue-pack.json"
(cd "$repo_root/js/logbrew-js" && npm pack --json --pack-destination "$tmp_dir") > "$core_pack_json"
(cd "$repo_root/js/logbrew-vue" && npm pack --json --pack-destination "$tmp_dir") > "$vue_pack_json"

core_tgz="$(python3 - "$core_pack_json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
print(payload[0]["filename"])
PY
)"
vue_tgz="$(python3 - "$vue_pack_json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
print(payload[0]["filename"])
PY
)"
core_tgz="$tmp_dir/$core_tgz"
vue_tgz="$tmp_dir/$vue_tgz"
test -f "$core_tgz"
test -f "$vue_tgz"

tar -tzf "$vue_tgz" > "$tmp_dir/vue-tarball.txt"
grep -q '^package/README.md$' "$tmp_dir/vue-tarball.txt"
grep -q '^package/index.js$' "$tmp_dir/vue-tarball.txt"
grep -q '^package/index.cjs$' "$tmp_dir/vue-tarball.txt"
grep -q '^package/index.d.ts$' "$tmp_dir/vue-tarball.txt"
grep -q '^package/index.d.cts$' "$tmp_dir/vue-tarball.txt"
grep -q '^package/examples/index.mjs$' "$tmp_dir/vue-tarball.txt"
grep -q '^package/examples/package.json$' "$tmp_dir/vue-tarball.txt"
grep -q '^package/examples/readme-example.mjs$' "$tmp_dir/vue-tarball.txt"
grep -q '^package/examples/real-user-smoke.mjs$' "$tmp_dir/vue-tarball.txt"
tar -xOf "$vue_tgz" package/README.md > "$tmp_dir/vue-readme.md"
grep -q 'npm install @logbrew/sdk @logbrew/vue vue' "$tmp_dir/vue-readme.md"
grep -q 'pnpm add @logbrew/sdk @logbrew/vue vue' "$tmp_dir/vue-readme.md"
grep -q 'LOGBREW_API_KEY' "$tmp_dir/vue-readme.md"
grep -q 'LOGBREW_CLIENT_KEY' "$tmp_dir/vue-readme.md"
grep -q 'createTraceparentFetch' "$tmp_dir/vue-readme.md"
grep -q 'createVueTraceparent' "$tmp_dir/vue-readme.md"
grep -q 'tracePropagationTargets' "$tmp_dir/vue-readme.md"
grep -q 'createLogBrewVuePlugin' "$tmp_dir/vue-readme.md"
grep -q 'useLogBrew' "$tmp_dir/vue-readme.md"
grep -q 'app.config.errorHandler' "$tmp_dir/vue-readme.md"

app_dir="$tmp_dir/vue-smoke-app"
mkdir -p "$app_dir"
cd "$app_dir"
npm init -y >/dev/null
npm pkg set type=module >/dev/null
vue_version="$(npm view vue version)"
vue_server_renderer_version="$(npm view @vue/server-renderer version)"
npm install \
  --save-exact \
  "$core_tgz" \
  "$vue_tgz" \
  "vue@$vue_version" \
  "@vue/server-renderer@$vue_server_renderer_version" \
  "typescript" \
  "@types/node" \
  >/dev/null

grep -q '"@logbrew/sdk": "file:' package.json
grep -q '"@logbrew/vue": "file:' package.json
grep -q '"vue":' package.json
grep -q '"@vue/server-renderer":' package.json
grep -q '"@logbrew/vue"' package-lock.json
grep -q '"@logbrew/sdk"' package-lock.json
npm ls @logbrew/sdk @logbrew/vue vue @vue/server-renderer >/dev/null
npm explain @logbrew/vue > "$tmp_dir/npm-explain-vue.txt"
grep -q '@logbrew/vue@0.1.0' "$tmp_dir/npm-explain-vue.txt"
npm list --depth=0 > "$tmp_dir/npm-list-depth0.txt"
grep -q '@logbrew/vue@0.1.0' "$tmp_dir/npm-list-depth0.txt"
grep -q '@logbrew/sdk@0.1.0' "$tmp_dir/npm-list-depth0.txt"
npm list --json --depth=0 > "$tmp_dir/npm-list-depth0.json"
python3 - "$tmp_dir/npm-list-depth0.json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
deps = payload.get("dependencies", {})
for name in ("@logbrew/vue", "@logbrew/sdk", "vue", "@vue/server-renderer"):
    if name not in deps:
        raise SystemExit(f"missing npm dependency entry: {name}")
PY

cat > smoke.mjs <<'EOF'
import { createSSRApp, defineComponent, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { RecordingTransport } from "@logbrew/sdk";
import {
  captureVueError,
  createLogBrewVueClient,
  createLogBrewVuePlugin,
  createTraceparentFetch,
  createVueErrorEvent,
  createVueTraceparent,
  createVueViewEvent,
  shouldPropagateTraceparent,
  useLogBrew
} from "@logbrew/vue";

const requestTransport = new RecordingTransport([{ statusCode: 503 }, { statusCode: 202 }]);
const errorTransport = RecordingTransport.alwaysAccept();
const manualErrorTransport = RecordingTransport.alwaysAccept();
const client = createLogBrewVueClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  maxRetries: 1,
  sdkName: "vue-smoke-app",
  sdkVersion: "0.1.0"
});

const App = defineComponent({
  name: "VueSmokeApp",
  setup() {
    const logbrew = useLogBrew();
    addFullBatch(logbrew.client);
    const event = createVueViewEvent("VueSmokeApp", {
      idFactory: () => "evt_vue_view_001",
      now: () => "2026-06-02T10:00:06Z",
      path: "/smoke"
    });
    if (event.attributes.metadata.path !== "/smoke") {
      throw new Error(`unexpected view event: ${JSON.stringify(event)}`);
    }
    return () => h("pre", "LogBrew Vue smoke");
  }
});

const app = createSSRApp(App);
app.use(createLogBrewVuePlugin({
  captureErrors: false,
  client,
  transport: requestTransport
}));

await renderToString(app);
const payload = client.previewJson();
await client.shutdown(requestTransport);

const errorClient = createLogBrewVueClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "vue-error-smoke",
  sdkVersion: "0.1.0"
});
const ErrorComponent = defineComponent({
  name: "ExplodingVueComponent",
  setup() {
    throw new Error("component exploded");
  }
});
const errorApp = createSSRApp(ErrorComponent);
let previousHandlerCalled = false;
errorApp.config.errorHandler = () => {
  previousHandlerCalled = true;
};
errorApp.use(createLogBrewVuePlugin({
  client: errorClient,
  errorEvent(error, { instance, info }) {
    return createVueErrorEvent(error, instance, info, {
      idFactory: () => "evt_vue_error_001",
      now: () => "2026-06-02T10:00:07Z"
    });
  },
  transport: errorTransport
}));
try {
  await renderToString(errorApp);
} catch (error) {
  if (!(error instanceof Error) || error.message !== "component exploded") {
    throw error;
  }
}
await waitFor(() => errorTransport.sentBodies.length === 1);
if (!previousHandlerCalled) {
  throw new Error("expected existing Vue error handler to be called");
}

const manualClient = createLogBrewVueClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "vue-manual-error-smoke",
  sdkVersion: "0.1.0"
});
const manualContext = {
  client: manualClient,
  logbrew: manualClient,
  transport: manualErrorTransport,
  previewJson: () => manualClient.previewJson(),
  flush: () => manualClient.flush(manualErrorTransport),
  shutdown: () => manualClient.shutdown(manualErrorTransport)
};
await captureVueError(new Error("manual vue failure"), null, "manual", manualContext, {
  idFactory: () => "evt_vue_error_manual",
  now: () => "2026-06-02T10:00:08Z"
});

const errorPayload = JSON.parse(errorTransport.lastBody());
if (errorPayload.events[0].type !== "issue" || errorPayload.events[0].id !== "evt_vue_error_001") {
  throw new Error(`unexpected error payload: ${errorTransport.lastBody()}`);
}
const manualErrorPayload = JSON.parse(manualErrorTransport.lastBody());
if (manualErrorPayload.events[0].id !== "evt_vue_error_manual") {
  throw new Error(`unexpected manual error payload: ${manualErrorTransport.lastBody()}`);
}

const propagatedRequests = [];
const tracedFetch = createTraceparentFetch({
  fetchImpl: async (input, init = {}) => {
    propagatedRequests.push({ input, init });
    return { status: 204 };
  },
  traceparentFactory: () => createVueTraceparent({
    randomValues: deterministicBytes
  }),
  tracePropagationTargets: ["https://api.example.test/", /^\/api\//u]
});
if (!shouldPropagateTraceparent("https://api.example.test/checkout", ["https://api.example.test/"])) {
  throw new Error("expected API request to match trace propagation target");
}
if (shouldPropagateTraceparent("https://cdn.example.test/app.js", ["https://api.example.test/"])) {
  throw new Error("expected CDN request not to match trace propagation target");
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
await tracedFetch("https://api.example.test/checkout", {
  headers: { accept: "application/json", traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01" }
});
await tracedFetch("https://cdn.example.test/app.js", {
  headers: { accept: "text/javascript" }
});
await tracedFetch("/api/cart");
const propagatedTraceparent = propagatedRequests[0].init.headers.traceparent;
if (propagatedTraceparent !== "00-0102030405060708090a0b0c0d0e0f10-0102030405060708-01") {
  throw new Error(`unexpected propagated traceparent: ${propagatedTraceparent}`);
}
if (propagatedRequests[0].init.headers.accept !== "application/json") {
  throw new Error("expected traced fetch to preserve existing headers");
}
if (propagatedRequests[1].init.headers?.traceparent !== undefined) {
  throw new Error("unmatched requests should not receive traceparent");
}
if (propagatedRequests[2].init.headers.traceparent !== propagatedTraceparent) {
  throw new Error("relative matched requests should receive traceparent");
}

console.log(payload);
console.error(JSON.stringify({
  ok: true,
  attempts: requestTransport.sentBodies.length,
  errorCaptured: errorPayload.events[0].attributes.title,
  events: JSON.parse(payload).events.length,
  manualErrorCaptured: manualErrorPayload.events[0].attributes.title,
  propagatedTraceparent,
  viewHelper: "evt_vue_view_001"
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

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error("timed out waiting for Vue capture");
}

function deterministicBytes(length) {
  return Uint8Array.from({ length }, (_value, index) => index + 1);
}
EOF

node smoke.mjs > "$tmp_dir/vue-smoke.stdout.json" 2> "$tmp_dir/vue-smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/vue-smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/vue-smoke.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/vue-smoke.stderr.json"
grep -q '"attempts":2' "$tmp_dir/vue-smoke.stderr.json"
grep -q '"events":6' "$tmp_dir/vue-smoke.stderr.json"
grep -q 'ExplodingVueComponent failed' "$tmp_dir/vue-smoke.stderr.json"
grep -q 'Vue component failed' "$tmp_dir/vue-smoke.stderr.json"
grep -q '"propagatedTraceparent":"00-0102030405060708090a0b0c0d0e0f10-0102030405060708-01"' "$tmp_dir/vue-smoke.stderr.json"
grep -q '"viewHelper":"evt_vue_view_001"' "$tmp_dir/vue-smoke.stderr.json"

cat > consumer.ts <<'EOF'
import { createSSRApp, defineComponent, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { RecordingTransport } from "@logbrew/sdk";
import {
  createLogBrewVueClient,
  createLogBrewVuePlugin,
  createTraceparentFetch,
  createVueTraceparent,
  createVueViewEvent,
  shouldPropagateTraceparent,
  type TracePropagationTarget,
  useLogBrew
} from "@logbrew/vue";

const client = createLogBrewVueClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "typed-vue-smoke",
  sdkVersion: "0.1.0"
});

const traceTargets: TracePropagationTarget[] = ["https://api.example.test/", /^\/api\//u];
const tracedFetch = createTraceparentFetch({
  fetchImpl: async (_input: unknown, _init?: unknown): Promise<{ status: number }> => ({ status: 204 }),
  traceparentFactory: () => createVueTraceparent({
    randomValues: (length: number) => new Uint8Array(length).fill(7)
  }),
  tracePropagationTargets: traceTargets
});
if (!shouldPropagateTraceparent("https://api.example.test/ping", traceTargets)) {
  throw new Error("expected typed trace target to match");
}
void tracedFetch("/api/typed");

const App = defineComponent({
  name: "TypedVueSmoke",
  setup() {
    const logbrew = useLogBrew();
    const event = createVueViewEvent("TypedVueSmoke", {
      path: "/typed",
      now: () => "2026-06-02T10:00:06Z"
    });
    logbrew.client.log(event.id, event.timestamp, event.attributes);
    return () => h("strong", `${logbrew.client.pendingEvents()}`);
  }
});

const app = createSSRApp(App);
app.use(createLogBrewVuePlugin({
  client,
  transport: RecordingTransport.alwaysAccept()
}));

async function render(): Promise<string> {
  return renderToString(app);
}

export { render };
EOF

cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "types": ["node"],
    "esModuleInterop": true,
    "skipLibCheck": false,
    "noEmit": true
  },
  "include": ["consumer.ts"]
}
EOF
npx tsc --project tsconfig.json

node -e 'const vue = require("@logbrew/vue"); if (typeof vue.createLogBrewVuePlugin !== "function" || typeof vue.createTraceparentFetch !== "function" || typeof vue.createVueTraceparent !== "function") process.exit(1)'

node node_modules/@logbrew/vue/examples/index.mjs --help > "$tmp_dir/launcher-help.txt"
grep -q 'node node_modules/@logbrew/vue/examples/index.mjs readme-example' "$tmp_dir/launcher-help.txt"
node node_modules/@logbrew/vue/examples/index.mjs --list > "$tmp_dir/launcher-list.txt"
grep -q 'real-user-smoke -> node node_modules/@logbrew/vue/examples/index.mjs real-user-smoke' "$tmp_dir/launcher-list.txt"
node node_modules/@logbrew/vue/examples/index.mjs readme-example > "$tmp_dir/example-readme.stdout.json" 2> "$tmp_dir/example-readme.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/example-readme.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/example-readme.stdout.json" >/dev/null
grep -q '"attempts":1' "$tmp_dir/example-readme.stderr.json"
grep -q '"viewHelper":"evt_vue_view_001"' "$tmp_dir/example-readme.stderr.json"
node node_modules/@logbrew/vue/examples/index.mjs > "$tmp_dir/example-default.stdout.json" 2> "$tmp_dir/example-default.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/example-default.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/example-default.stdout.json" >/dev/null
grep -q '"attempts":2' "$tmp_dir/example-default.stderr.json"
grep -q 'ExplodingVueComponent failed' "$tmp_dir/example-default.stderr.json"
grep -q '"propagatedTraceparent":"00-0102030405060708090a0b0c0d0e0f10-0102030405060708-01"' "$tmp_dir/example-default.stderr.json"
npm --prefix node_modules/@logbrew/vue/examples run list > "$tmp_dir/npm-helper-list.txt"
grep -q 'readme-example -> node node_modules/@logbrew/vue/examples/index.mjs readme-example' "$tmp_dir/npm-helper-list.txt"
npm --prefix node_modules/@logbrew/vue/examples run help > "$tmp_dir/npm-helper-help.txt"
grep -q 'npm --prefix node_modules/@logbrew/vue/examples run real-user-smoke' "$tmp_dir/npm-helper-help.txt"
npm --prefix node_modules/@logbrew/vue/examples run --silent real-user-smoke > "$tmp_dir/npm-helper-smoke.stdout.json" 2> "$tmp_dir/npm-helper-smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/npm-helper-smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/npm-helper-smoke.stdout.json" >/dev/null
grep -q '"attempts":2' "$tmp_dir/npm-helper-smoke.stderr.json"
grep -q '"propagatedTraceparent":"00-0102030405060708090a0b0c0d0e0f10-0102030405060708-01"' "$tmp_dir/npm-helper-smoke.stderr.json"

echo "vue real-user smoke passed with vue@$vue_version @vue/server-renderer@$vue_server_renderer_version"
