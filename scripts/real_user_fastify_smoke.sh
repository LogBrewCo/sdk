#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sdk_package_version="$(node -p "require('${repo_root}/js/logbrew-js/package.json').version")"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

core_pack_json="$tmp_dir/core-pack.json"
fastify_pack_json="$tmp_dir/fastify-pack.json"
(cd "$repo_root/js/logbrew-js" && npm pack --json --pack-destination "$tmp_dir") > "$core_pack_json"
(cd "$repo_root/js/logbrew-fastify" && npm pack --json --pack-destination "$tmp_dir") > "$fastify_pack_json"

core_tgz="$(python3 - "$core_pack_json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
print(payload[0]["filename"])
PY
)"
fastify_tgz="$(python3 - "$fastify_pack_json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
print(payload[0]["filename"])
PY
)"
core_tgz="$tmp_dir/$core_tgz"
fastify_tgz="$tmp_dir/$fastify_tgz"
test -f "$core_tgz"
test -f "$fastify_tgz"

tar -tzf "$fastify_tgz" > "$tmp_dir/fastify-tarball.txt"
grep -q '^package/README.md$' "$tmp_dir/fastify-tarball.txt"
grep -q '^package/index.js$' "$tmp_dir/fastify-tarball.txt"
grep -q '^package/index.cjs$' "$tmp_dir/fastify-tarball.txt"
grep -q '^package/index.d.ts$' "$tmp_dir/fastify-tarball.txt"
grep -q '^package/index.d.cts$' "$tmp_dir/fastify-tarball.txt"
grep -q '^package/examples/index.mjs$' "$tmp_dir/fastify-tarball.txt"
grep -q '^package/examples/package.json$' "$tmp_dir/fastify-tarball.txt"
grep -q '^package/examples/readme-example.mjs$' "$tmp_dir/fastify-tarball.txt"
grep -q '^package/examples/real-user-smoke.mjs$' "$tmp_dir/fastify-tarball.txt"
tar -xOf "$fastify_tgz" package/README.md > "$tmp_dir/fastify-readme.md"
grep -q 'npm install @logbrew/sdk @logbrew/fastify fastify' "$tmp_dir/fastify-readme.md"
grep -q 'pnpm add @logbrew/sdk @logbrew/fastify fastify' "$tmp_dir/fastify-readme.md"
grep -q 'LOGBREW_API_KEY' "$tmp_dir/fastify-readme.md"
grep -q 'LOGBREW_SERVER_API_KEY' "$tmp_dir/fastify-readme.md"
grep -q 'serverApiKey' "$tmp_dir/fastify-readme.md"
grep -q 'logbrewFastifyPlugin' "$tmp_dir/fastify-readme.md"
grep -q 'onResponse' "$tmp_dir/fastify-readme.md"
grep -q 'onError' "$tmp_dir/fastify-readme.md"
grep -q 'traceparent' "$tmp_dir/fastify-readme.md"
grep -q 'spanIdFactory' "$tmp_dir/fastify-readme.md"
grep -q 'captureRequestMetrics' "$tmp_dir/fastify-readme.md"
grep -q 'http.server.duration' "$tmp_dir/fastify-readme.md"
grep -q 'low-cardinality' "$tmp_dir/fastify-readme.md"

app_dir="$tmp_dir/fastify-smoke-app"
mkdir -p "$app_dir"
cd "$app_dir"
npm init -y >/dev/null
npm pkg set type=module >/dev/null
fastify_version="$(npm view fastify version)"
npm install \
  --save-exact \
  "$core_tgz" \
  "$fastify_tgz" \
  "fastify@$fastify_version" \
  "typescript" \
  "@types/node@22" \
  >/dev/null

grep -q '"@logbrew/sdk": "file:' package.json
grep -q '"@logbrew/fastify": "file:' package.json
grep -q '"fastify":' package.json
grep -q '"@logbrew/fastify"' package-lock.json
grep -q '"@logbrew/sdk"' package-lock.json
npm ls @logbrew/sdk @logbrew/fastify fastify >/dev/null
npm explain @logbrew/fastify > "$tmp_dir/npm-explain-fastify.txt"
grep -q '@logbrew/fastify@0.1.0' "$tmp_dir/npm-explain-fastify.txt"
npm list --depth=0 > "$tmp_dir/npm-list-depth0.txt"
grep -q '@logbrew/fastify@0.1.0' "$tmp_dir/npm-list-depth0.txt"
grep -q "@logbrew/sdk@${sdk_package_version}" "$tmp_dir/npm-list-depth0.txt"
npm list --json --depth=0 > "$tmp_dir/npm-list-depth0.json"
python3 - "$tmp_dir/npm-list-depth0.json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
deps = payload.get("dependencies", {})
for name in ("@logbrew/fastify", "@logbrew/sdk", "fastify"):
    if name not in deps:
        raise SystemExit(f"missing npm dependency entry: {name}")
PY

cat > smoke.mjs <<'EOF'
import Fastify from "fastify";
import { RecordingTransport } from "@logbrew/sdk";
import {
  createErrorEvent,
  createLogBrewFastifyClient,
  createRequestMetricEvent,
  createRequestEvent,
  getActiveLogBrewTrace,
  logbrewFastifyPlugin
} from "@logbrew/fastify";

const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const requestTransport = new RecordingTransport([{ statusCode: 503 }, { statusCode: 202 }]);
const autoTransport = RecordingTransport.alwaysAccept();
const errorTransport = RecordingTransport.alwaysAccept();
const metricOnlyTransport = RecordingTransport.alwaysAccept();
const app = Fastify();
let activeTraceFromAuto;

const explicitClient = createLogBrewFastifyClient({
  apiKey: "LOGBREW_API_KEY",
  sdkName: "fastify-smoke-explicit",
  sdkVersion: "0.1.0"
});
if (explicitClient.pendingEvents() !== 0) {
  throw new Error("expected empty explicit client");
}

await app.register(async (scope) => {
  let metricNowMs = 100;
  await scope.register(logbrewFastifyPlugin, {
    serverApiKey: "LOGBREW_SERVER_API_KEY",
    captureRequests: false,
    captureRequestMetrics: true,
    metricIdFactory: () => "evt_fastify_metric_001",
    now: () => "2026-06-02T10:00:09Z",
    nowMs: () => {
      const value = metricNowMs;
      metricNowMs += 25;
      return value;
    },
    sdkName: "fastify-metric-smoke",
    sdkVersion: "0.1.0",
    transport: metricOnlyTransport
  });

  scope.get("/metrics-only/:id", async () => ({ ok: true }));
});

await app.register(async (scope) => {
  await scope.register(logbrewFastifyPlugin, {
    serverApiKey: "LOGBREW_SERVER_API_KEY",
    captureRequests: false,
    maxRetries: 1,
    sdkName: "fastify-smoke-app",
    sdkVersion: "0.1.0",
    transport: requestTransport
  });

  scope.get("/logbrew", async (request) => {
    addFullBatch(request.logbrew.client);
    const payload = request.logbrew.previewJson();
    await request.logbrew.shutdown();
    return JSON.parse(payload);
  });
});

await app.register(async (scope) => {
  await scope.register(logbrewFastifyPlugin, {
    serverApiKey: "LOGBREW_SERVER_API_KEY",
    now: () => "2026-06-02T10:00:06Z",
    nowMs: () => 100,
    spanIdFactory: () => "b7ad6b7169203331",
    requestEvent(request, reply, { durationMs }) {
      return createRequestEvent(request, reply, {
        durationMs,
        idFactory: () => "evt_fastify_request_001",
        now: () => "2026-06-02T10:00:06Z"
      });
    },
    sdkName: "fastify-auto-smoke",
    sdkVersion: "0.1.0",
    transport: autoTransport
  });

  scope.get("/auto", async (request) => {
    await Promise.resolve().then(() => {
      activeTraceFromAuto = getActiveLogBrewTrace();
    });
    if (request.logbrew.trace?.traceId !== "4bf92f3577b34da6a3ce929d0e0e4736") {
      throw new Error(`missing Fastify request trace context: ${JSON.stringify(request.logbrew.trace)}`);
    }
    return { ok: true };
  });
});

await app.register(async (scope) => {
  await scope.register(logbrewFastifyPlugin, {
    serverApiKey: "LOGBREW_SERVER_API_KEY",
    captureRequests: false,
    spanIdFactory: () => "b7ad6b7169203332",
    errorEvent(error, { request }) {
      return createErrorEvent(error, request, {
        idFactory: () => "evt_fastify_error_001",
        now: () => "2026-06-02T10:00:07Z"
      });
    },
    sdkName: "fastify-error-smoke",
    sdkVersion: "0.1.0",
    transport: errorTransport
  });

  scope.get("/fail", async () => {
    throw new Error("route exploded");
  });

  scope.setErrorHandler((error, _request, reply) => {
    reply.code(500).send({ error: error.message });
  });
});

const address = await app.listen({ host: "127.0.0.1", port: 0 });
const okResponse = await fetch(`${address}/logbrew`);
const okText = await okResponse.text();
const autoResponse = await fetch(`${address}/auto?token=secret`, {
  headers: {
    traceparent
  }
});
await autoResponse.json();
await waitFor(() => autoTransport.sentBodies.length === 1 && activeTraceFromAuto);
const metricResponse = await fetch(`${address}/metrics-only/42?token=secret#hidden`);
await metricResponse.json();
await waitFor(() => metricOnlyTransport.sentBodies.length === 1);
const failResponse = await fetch(`${address}/fail?token=secret`, {
  headers: {
    traceparent
  }
});
await failResponse.json();
await waitFor(() => errorTransport.sentBodies.length === 1);
await app.close();

const autoPayload = JSON.parse(autoTransport.lastBody());
if (autoPayload.events[0].type !== "span" || autoPayload.events[0].id !== "evt_fastify_request_001") {
  throw new Error(`unexpected auto request payload: ${autoTransport.lastBody()}`);
}
if (autoPayload.events[0].attributes.traceId !== "4bf92f3577b34da6a3ce929d0e0e4736") {
  throw new Error(`unexpected fastify trace id: ${autoTransport.lastBody()}`);
}
if (autoPayload.events[0].attributes.parentSpanId !== "00f067aa0ba902b7") {
  throw new Error(`unexpected fastify parent span id: ${autoTransport.lastBody()}`);
}
if (autoPayload.events[0].attributes.spanId !== "b7ad6b7169203331") {
  throw new Error(`unexpected fastify request span id: ${autoTransport.lastBody()}`);
}
if (autoPayload.events[0].attributes.metadata.framework !== "fastify") {
  throw new Error(`missing fastify span metadata: ${autoTransport.lastBody()}`);
}
if (autoPayload.events[0].attributes.metadata.sampled !== true) {
  throw new Error(`missing sampled fastify span metadata: ${autoTransport.lastBody()}`);
}
if (autoPayload.events[0].attributes.metadata.path !== "/auto") {
  throw new Error(`request capture should omit query text: ${autoTransport.lastBody()}`);
}
if (activeTraceFromAuto?.spanId !== "b7ad6b7169203331") {
  throw new Error(`async trace context was not preserved: ${JSON.stringify(activeTraceFromAuto)}`);
}
const metricPayload = JSON.parse(metricOnlyTransport.lastBody());
const metricEvent = metricPayload.events[0];
if (metricPayload.events.length !== 1 || metricEvent.type !== "metric" || metricEvent.id !== "evt_fastify_metric_001") {
  throw new Error(`unexpected metric payload: ${metricOnlyTransport.lastBody()}`);
}
if (metricEvent.attributes.name !== "http.server.duration") {
  throw new Error(`unexpected metric name: ${metricOnlyTransport.lastBody()}`);
}
if (metricEvent.attributes.kind !== "histogram" || metricEvent.attributes.unit !== "ms" || metricEvent.attributes.temporality !== "delta") {
  throw new Error(`unexpected metric shape: ${metricOnlyTransport.lastBody()}`);
}
if (metricEvent.attributes.value !== 25) {
  throw new Error(`unexpected metric duration: ${metricOnlyTransport.lastBody()}`);
}
if (metricEvent.attributes.metadata.framework !== "fastify") {
  throw new Error(`missing metric framework metadata: ${metricOnlyTransport.lastBody()}`);
}
if (metricEvent.attributes.metadata.routeTemplate !== "/metrics-only/:id") {
  throw new Error(`metric capture should use route template without query/hash: ${metricOnlyTransport.lastBody()}`);
}
if (metricEvent.attributes.metadata.statusCode !== 200 || metricEvent.attributes.metadata.statusCodeClass !== "2xx") {
  throw new Error(`unexpected metric status metadata: ${metricOnlyTransport.lastBody()}`);
}
const errorPayload = JSON.parse(errorTransport.lastBody());
if (errorPayload.events[0].type !== "issue" || errorPayload.events[0].id !== "evt_fastify_error_001") {
  throw new Error(`unexpected error payload: ${errorTransport.lastBody()}`);
}
if (errorPayload.events[0].attributes.metadata.path !== "/fail") {
  throw new Error(`error capture should omit query text: ${errorTransport.lastBody()}`);
}
if (errorPayload.events[0].attributes.metadata.traceId !== "4bf92f3577b34da6a3ce929d0e0e4736") {
  throw new Error(`error capture should include trace id: ${errorTransport.lastBody()}`);
}
if (errorPayload.events[0].attributes.metadata.spanId !== "b7ad6b7169203332") {
  throw new Error(`error capture should include request span id: ${errorTransport.lastBody()}`);
}
const errorPreview = createErrorEvent(new Error("manual failure"), { method: "POST", url: "/manual?token=secret" }, {
  idFactory: () => "evt_fastify_error_preview",
  now: () => "2026-06-02T10:00:08Z"
});
if (errorPreview.attributes.title !== "POST /manual failed") {
  throw new Error(`unexpected error preview: ${JSON.stringify(errorPreview)}`);
}
const metricPreview = createRequestMetricEvent(
  { method: "POST", routeOptions: { url: "/manual/:id?token=secret" }, url: "/manual/42?token=secret" },
  { statusCode: 503 },
  {
    durationMs: 34,
    idFactory: () => "evt_fastify_metric_preview",
    now: () => "2026-06-02T10:00:10Z"
  }
);
if (metricPreview.attributes.metadata.routeTemplate !== "/manual/:id") {
  throw new Error(`unexpected metric preview route: ${JSON.stringify(metricPreview)}`);
}
if (metricPreview.attributes.metadata.statusCodeClass !== "5xx") {
  throw new Error(`unexpected metric preview status class: ${JSON.stringify(metricPreview)}`);
}

console.log(okText);
console.error(JSON.stringify({
  ok: true,
  attempts: requestTransport.sentBodies.length,
  autoCaptured: autoPayload.events[0].attributes.name,
  autoTraceId: autoPayload.events[0].attributes.traceId,
  errorCaptured: errorPayload.events[0].attributes.title,
  errorTraceId: errorPayload.events[0].attributes.metadata.traceId,
  errorStatus: failResponse.status,
  events: 6,
  metricCaptured: metricEvent.attributes.name,
  metricRouteTemplate: metricEvent.attributes.metadata.routeTemplate,
  status: okResponse.status
}));

function addFullBatch(client) {
  client.release("evt_release_001", "2026-06-02T10:00:00Z", {
    version: "1.2.3",
    commit: "abc123def456",
    notes: "Public release marker"
  });
  client.environment("evt_environment_001", "2026-06-02T10:00:01Z", {
    name: "production",
    region: "global"
  });
  client.issue("evt_issue_001", "2026-06-02T10:00:02Z", {
    title: "Checkout timeout",
    level: "error",
    message: "Request timed out after retry budget"
  });
  client.log("evt_log_001", "2026-06-02T10:00:03Z", {
    message: "worker started",
    level: "info",
    logger: "job-runner"
  });
  client.span("evt_span_001", "2026-06-02T10:00:04Z", {
    name: "GET /health",
    traceId: "trace_001",
    spanId: "span_001",
    status: "ok",
    durationMs: 12.5
  });
  client.action("evt_action_001", "2026-06-02T10:00:05Z", {
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
  throw new Error("timed out waiting for Fastify capture");
}
EOF

node smoke.mjs > "$tmp_dir/fastify-smoke.stdout.json" 2> "$tmp_dir/fastify-smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/fastify-smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/fastify-smoke.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/fastify-smoke.stderr.json"
grep -q '"attempts":2' "$tmp_dir/fastify-smoke.stderr.json"
grep -q '"errorStatus":500' "$tmp_dir/fastify-smoke.stderr.json"
grep -q 'GET /auto' "$tmp_dir/fastify-smoke.stderr.json"
grep -q '4bf92f3577b34da6a3ce929d0e0e4736' "$tmp_dir/fastify-smoke.stderr.json"
grep -q 'GET /fail failed' "$tmp_dir/fastify-smoke.stderr.json"

cat > consumer.ts <<'EOF'
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { RecordingTransport } from "@logbrew/sdk";
import {
  createLogBrewFastifyClient,
  createRequestMetricEvent,
  createRequestEvent,
  getActiveLogBrewTrace,
  type LogBrewTraceContext,
  logbrewFastifyPlugin
} from "@logbrew/fastify";

const app = Fastify();
const client = createLogBrewFastifyClient({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "typed-fastify-smoke",
  sdkVersion: "0.1.0"
});

app.register(logbrewFastifyPlugin, {
  client,
  captureRequestMetrics: true,
  metricIdFactory(request, reply) {
    return `evt_metric_${request.method}_${reply.statusCode}`;
  },
  spanIdFactory: () => "b7ad6b7169203331",
  requestMetricEvent(request, reply, { durationMs, trace }) {
    trace?.spanId.toUpperCase();
    return createRequestMetricEvent(request, reply, {
      durationMs,
      now: () => "2026-06-02T10:00:09Z"
    });
  },
  requestEvent(request, reply, { durationMs, trace }) {
    trace?.spanId.toUpperCase();
    const event = createRequestEvent(request, reply, {
      durationMs,
      now: () => "2026-06-02T10:00:06Z"
    });
    if (event.type === "span") {
      event.attributes.parentSpanId?.toUpperCase();
    }
    return event;
  },
  transport: RecordingTransport.alwaysAccept()
});

app.get("/typed", async (request: FastifyRequest, _reply: FastifyReply) => {
  const activeTrace: LogBrewTraceContext | undefined = getActiveLogBrewTrace();
  activeTrace?.traceId.toUpperCase();
  request.logbrew?.trace?.spanId.toUpperCase();
  request.logbrew?.client.log("evt_log_001", "2026-06-02T10:00:03Z", {
    message: "typed worker",
    level: "info"
  });
  return { pending: request.logbrew?.client.pendingEvents() ?? 0 };
});

app.setErrorHandler((error, _request, reply) => {
  const message = error instanceof Error ? error.message : String(error);
  reply.code(500).send({ error: message });
});

export { app };
EOF

cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": false,
    "noEmit": true
  },
  "include": ["consumer.ts"]
}
EOF
npx tsc --project tsconfig.json

node -e 'const fastify = require("@logbrew/fastify"); if (typeof fastify.logbrewFastifyPlugin !== "function") process.exit(1)'

node node_modules/@logbrew/fastify/examples/index.mjs --help > "$tmp_dir/launcher-help.txt"
grep -q 'node node_modules/@logbrew/fastify/examples/index.mjs readme-example' "$tmp_dir/launcher-help.txt"
node node_modules/@logbrew/fastify/examples/index.mjs --list > "$tmp_dir/launcher-list.txt"
grep -q 'real-user-smoke -> node node_modules/@logbrew/fastify/examples/index.mjs real-user-smoke' "$tmp_dir/launcher-list.txt"
node node_modules/@logbrew/fastify/examples/index.mjs readme-example > "$tmp_dir/example-readme.stdout.json" 2> "$tmp_dir/example-readme.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/example-readme.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/example-readme.stdout.json" >/dev/null
grep -q '"attempts":1' "$tmp_dir/example-readme.stderr.json"
node node_modules/@logbrew/fastify/examples/index.mjs > "$tmp_dir/example-default.stdout.json" 2> "$tmp_dir/example-default.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/example-default.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/example-default.stdout.json" >/dev/null
grep -q '"attempts":2' "$tmp_dir/example-default.stderr.json"
grep -q '"errorStatus":500' "$tmp_dir/example-default.stderr.json"
npm --prefix node_modules/@logbrew/fastify/examples run list > "$tmp_dir/npm-helper-list.txt"
grep -q 'readme-example -> node node_modules/@logbrew/fastify/examples/index.mjs readme-example' "$tmp_dir/npm-helper-list.txt"
npm --prefix node_modules/@logbrew/fastify/examples run help > "$tmp_dir/npm-helper-help.txt"
grep -q 'npm --prefix node_modules/@logbrew/fastify/examples run real-user-smoke' "$tmp_dir/npm-helper-help.txt"
npm --prefix node_modules/@logbrew/fastify/examples run --silent real-user-smoke > "$tmp_dir/npm-helper-smoke.stdout.json" 2> "$tmp_dir/npm-helper-smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/npm-helper-smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/npm-helper-smoke.stdout.json" >/dev/null
grep -q '"attempts":2' "$tmp_dir/npm-helper-smoke.stderr.json"

echo "fastify real-user smoke passed with fastify@$fastify_version"
