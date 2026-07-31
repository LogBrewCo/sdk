#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sdk_package_version="$(node -p "require('${repo_root}/js/logbrew-js/package.json').version")"
node_package_version="$(node -p "require('${repo_root}/js/logbrew-node/package.json').version")"
express_package_version="$(node -p "require('${repo_root}/js/logbrew-express/package.json').version")"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

core_pack_json="$tmp_dir/core-pack.json"
node_pack_json="$tmp_dir/node-pack.json"
express_pack_json="$tmp_dir/express-pack.json"
(cd "$repo_root/js/logbrew-js" && npm pack --json --pack-destination "$tmp_dir") > "$core_pack_json"
(cd "$repo_root/js/logbrew-node" && npm pack --json --pack-destination "$tmp_dir") > "$node_pack_json"
(cd "$repo_root/js/logbrew-express" && npm pack --json --pack-destination "$tmp_dir") > "$express_pack_json"

core_tgz="$(python3 - "$core_pack_json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
print(payload[0]["filename"])
PY
)"
node_tgz="$(python3 - "$node_pack_json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
print(payload[0]["filename"])
PY
)"
express_tgz="$(python3 - "$express_pack_json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
print(payload[0]["filename"])
PY
)"
core_tgz="$tmp_dir/$core_tgz"
node_tgz="$tmp_dir/$node_tgz"
express_tgz="$tmp_dir/$express_tgz"
test -f "$core_tgz"
test -f "$node_tgz"
test -f "$express_tgz"

tar -tzf "$express_tgz" > "$tmp_dir/express-tarball.txt"
grep -q '^package/README.md$' "$tmp_dir/express-tarball.txt"
grep -q '^package/index.js$' "$tmp_dir/express-tarball.txt"
grep -q '^package/index.cjs$' "$tmp_dir/express-tarball.txt"
grep -q '^package/index.d.ts$' "$tmp_dir/express-tarball.txt"
grep -q '^package/index.d.cts$' "$tmp_dir/express-tarball.txt"
grep -q '^package/examples/index.mjs$' "$tmp_dir/express-tarball.txt"
grep -q '^package/examples/package.json$' "$tmp_dir/express-tarball.txt"
grep -q '^package/examples/readme-example.mjs$' "$tmp_dir/express-tarball.txt"
grep -q '^package/examples/real-user-smoke.mjs$' "$tmp_dir/express-tarball.txt"
tar -xOf "$express_tgz" package/README.md > "$tmp_dir/express-readme.md"
tar -xOf "$express_tgz" package/package.json > "$tmp_dir/express-package.json"
grep -q 'npm install @logbrew/sdk @logbrew/node @logbrew/express express' "$tmp_dir/express-readme.md"
grep -q 'pnpm add @logbrew/sdk @logbrew/node @logbrew/express express' "$tmp_dir/express-readme.md"
grep -q 'sends to the LogBrew ingest API by default' "$tmp_dir/express-readme.md"
grep -q 'logbrew projects create' "$tmp_dir/express-readme.md"
grep -q -- '--ingest-key-file' "$tmp_dir/express-readme.md"
grep -q 'logbrew read logs --project' "$tmp_dir/express-readme.md"
grep -q 'logbrew projects archive' "$tmp_dir/express-readme.md"
grep -q 'Do not ask a person to paste an ingest key' "$tmp_dir/express-readme.md"
grep -q 'Do not treat a missing environment variable as a reason to stop setup' "$tmp_dir/express-readme.md"
grep -q 'Continue without a browser handoff' "$tmp_dir/express-readme.md"
grep -q 'Only stop for account authentication' "$tmp_dir/express-readme.md"
grep -q 'if (logbrewServerApiKey)' "$tmp_dir/express-readme.md"
grep -q 'final 500 request event' "$tmp_dir/express-readme.md"
grep -q 'LOGBREW_API_KEY' "$tmp_dir/express-readme.md"
grep -q 'LOGBREW_SERVER_API_KEY' "$tmp_dir/express-readme.md"
grep -q 'serverApiKey' "$tmp_dir/express-readme.md"
grep -q 'logbrewMiddleware' "$tmp_dir/express-readme.md"
grep -q 'logbrewErrorHandler' "$tmp_dir/express-readme.md"
grep -q 'traceparent' "$tmp_dir/express-readme.md"
grep -q 'spanIdFactory' "$tmp_dir/express-readme.md"
grep -q 'captureRequestMetrics' "$tmp_dir/express-readme.md"
grep -q 'http.server.duration' "$tmp_dir/express-readme.md"
grep -q 'low-cardinality' "$tmp_dir/express-readme.md"
python3 - "$tmp_dir/express-package.json" "$node_package_version" <<'PY'
import json
import sys
from pathlib import Path

manifest = json.loads(Path(sys.argv[1]).read_text())
node_version = sys.argv[2]
peers = manifest.get("peerDependencies", {})
if peers.get("@logbrew/node") != f"^{node_version}":
    raise SystemExit(f"unexpected @logbrew/node peer: {peers.get('@logbrew/node')!r}")
if peers.get("@logbrew/sdk") != "^0.1.3":
    raise SystemExit(f"unexpected @logbrew/sdk peer: {peers.get('@logbrew/sdk')!r}")
PY

app_dir="$tmp_dir/express-smoke-app"
mkdir -p "$app_dir"
cd "$app_dir"
npm init -y >/dev/null
npm pkg set type=module >/dev/null
express_version="$(npm view express version)"
types_express_version="$(npm view @types/express version)"
npm install \
  --save-exact \
  "$core_tgz" \
  "$node_tgz" \
  "$express_tgz" \
  "express@$express_version" \
  "typescript" \
  "@types/node" \
  "@types/express@$types_express_version" \
  >/dev/null

grep -q '"@logbrew/sdk": "file:' package.json
grep -q '"@logbrew/node": "file:' package.json
grep -q '"@logbrew/express": "file:' package.json
grep -q '"express":' package.json
grep -q '"@logbrew/express"' package-lock.json
grep -q '"@logbrew/node"' package-lock.json
grep -q '"@logbrew/sdk"' package-lock.json
npm ls @logbrew/sdk @logbrew/node @logbrew/express express >/dev/null
npm explain @logbrew/express > "$tmp_dir/npm-explain-express.txt"
grep -q "@logbrew/express@${express_package_version}" "$tmp_dir/npm-explain-express.txt"
npm list --depth=0 > "$tmp_dir/npm-list-depth0.txt"
grep -q "@logbrew/express@${express_package_version}" "$tmp_dir/npm-list-depth0.txt"
grep -q "@logbrew/node@${node_package_version}" "$tmp_dir/npm-list-depth0.txt"
grep -q "@logbrew/sdk@${sdk_package_version}" "$tmp_dir/npm-list-depth0.txt"
npm list --json --depth=0 > "$tmp_dir/npm-list-depth0.json"
python3 - "$tmp_dir/npm-list-depth0.json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
deps = payload.get("dependencies", {})
for name in ("@logbrew/express", "@logbrew/node", "@logbrew/sdk", "express"):
    if name not in deps:
        raise SystemExit(f"missing npm dependency entry: {name}")
PY

cat > smoke.mjs <<'EOF'
import express from "express";
import { RecordingTransport } from "@logbrew/sdk";
import {
  createErrorEvent,
  createLogBrewExpressClient,
  createRequestEvent,
  createRequestMetricEvent,
  getActiveLogBrewTrace,
  logbrewErrorHandler,
  logbrewMiddleware
} from "@logbrew/express";

const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const requestTransport = new RecordingTransport([{ statusCode: 503 }, { statusCode: 202 }]);
const autoTransport = RecordingTransport.alwaysAccept();
const metricOnlyTransport = RecordingTransport.alwaysAccept();
const errorTransport = RecordingTransport.alwaysAccept();
const abortedErrorTransport = RecordingTransport.alwaysAccept();
const app = express();

const explicitClient = createLogBrewExpressClient({
  apiKey: "LOGBREW_API_KEY",
  sdkName: "express-smoke-explicit",
  sdkVersion: "0.1.0"
});
if (explicitClient.pendingEvents() !== 0) {
  throw new Error("expected empty explicit client");
}

app.use("/logbrew", logbrewMiddleware({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "express-smoke-app",
  sdkVersion: "0.1.0",
  maxRetries: 1,
  captureRequests: false,
  transport: requestTransport
}));

app.get("/logbrew", (req, res) => {
  addFullBatch(req.logbrew.client);
  res.type("json").send(req.logbrew.previewJson());
  void req.logbrew.shutdown();
});

app.use("/auto", logbrewMiddleware({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "express-auto-smoke",
  sdkVersion: "0.1.0",
  transport: autoTransport,
  captureRequestMetrics: true,
  now: () => "2026-06-02T10:00:06Z",
  nowMs: () => 100,
  metricIdFactory: () => "evt_express_metric_001",
  spanIdFactory: () => "b7ad6b7169203331",
  requestEvent(req, res, { durationMs }) {
    return createRequestEvent(req, res, {
      now: () => "2026-06-02T10:00:06Z",
      durationMs,
      idFactory: () => "evt_express_request_001"
    });
  }
}));

let activeTraceFromAuto;
app.get("/auto", async (req, res) => {
  await Promise.resolve().then(() => {
    activeTraceFromAuto = getActiveLogBrewTrace();
  });
  if (req.logbrew.trace?.traceId !== "4bf92f3577b34da6a3ce929d0e0e4736") {
    throw new Error(`missing Express request trace context: ${JSON.stringify(req.logbrew.trace)}`);
  }
  res.json({ ok: true });
});

app.use("/metrics-only", logbrewMiddleware({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "express-metric-only-smoke",
  sdkVersion: "0.1.0",
  transport: metricOnlyTransport,
  captureRequests: false,
  captureRequestMetrics: true,
  metricIdFactory: () => "evt_express_metric_only_001",
  now: () => "2026-06-02T10:00:06Z",
  nowMs: () => 150
}));

app.get("/metrics-only/:id", (_req, res) => {
  res.json({ ok: true });
});

app.use("/fail", logbrewMiddleware({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "express-error-trace-smoke",
  sdkVersion: "0.1.0",
  transport: errorTransport,
  captureRequestMetrics: true,
  metricIdFactory: () => "evt_express_error_metric_001",
  nowMs: () => 200,
  requestEvent(req, res, { durationMs, trace }) {
    return createRequestEvent(req, res, {
      durationMs,
      idFactory: () => "evt_express_error_request_001",
      now: () => "2026-06-02T10:00:08Z",
      trace
    });
  },
  spanIdFactory: () => "b7ad6b7169203332"
}));

app.get("/fail", async () => {
  throw new Error("route exploded");
});

app.use("/abort", logbrewMiddleware({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "express-aborted-error-smoke",
  sdkVersion: "0.1.0",
  transport: abortedErrorTransport,
  captureRequestMetrics: true,
  idFactory: () => "evt_express_aborted_request_001",
  metricIdFactory: () => "evt_express_aborted_metric_001",
  nowMs: () => 250
}));

app.get("/abort", async () => {
  throw new Error("aborted route exploded");
});

app.use(logbrewErrorHandler({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  transport: errorTransport,
  now: () => "2026-06-02T10:00:07Z",
  idFactory: () => "evt_express_error_001"
}));

app.use((error, req, res, _next) => {
  void _next;
  if (req.path === "/abort") {
    res.statusCode = 500;
    res.destroy();
    return;
  }
  res.status(500).json({ error: error.message });
});

const server = app.listen(0);
const port = server.address().port;

const okResponse = await fetch(`http://127.0.0.1:${port}/logbrew`);
const okText = await okResponse.text();
const autoResponse = await fetch(`http://127.0.0.1:${port}/auto?token=secret`, {
  headers: {
    traceparent
  }
});
await autoResponse.json();
await waitFor(() => autoTransport.sentBodies.length === 1 && activeTraceFromAuto);
const metricOnlyResponse = await fetch(`http://127.0.0.1:${port}/metrics-only/123?token=secret`);
await metricOnlyResponse.json();
await waitFor(() => metricOnlyTransport.sentBodies.length === 1);
const failResponse = await fetch(`http://127.0.0.1:${port}/fail?token=secret`, {
  headers: {
    traceparent
  }
});
await failResponse.json();
await waitFor(() => errorTransport.sentBodies.length === 1);
await fetch(`http://127.0.0.1:${port}/abort`).catch(() => undefined);
await waitFor(() => abortedErrorTransport.sentBodies.length === 1);
await new Promise((resolve) => {
  server.close(resolve);
});

const autoPayload = JSON.parse(autoTransport.lastBody());
if (autoPayload.events[0].type !== "span" || autoPayload.events[0].id !== "evt_express_request_001") {
  throw new Error(`unexpected auto request payload: ${autoTransport.lastBody()}`);
}
if (autoPayload.events[0].attributes.traceId !== "4bf92f3577b34da6a3ce929d0e0e4736") {
  throw new Error(`unexpected express trace id: ${autoTransport.lastBody()}`);
}
if (autoPayload.events[0].attributes.parentSpanId !== "00f067aa0ba902b7") {
  throw new Error(`unexpected express parent span id: ${autoTransport.lastBody()}`);
}
if (autoPayload.events[0].attributes.spanId !== "b7ad6b7169203331") {
  throw new Error(`unexpected express request span id: ${autoTransport.lastBody()}`);
}
if (autoPayload.events[0].attributes.metadata.framework !== "express") {
  throw new Error(`missing express span metadata: ${autoTransport.lastBody()}`);
}
if (autoPayload.events[0].attributes.metadata.sampled !== true) {
  throw new Error(`missing sampled express span metadata: ${autoTransport.lastBody()}`);
}
if (autoPayload.events[0].attributes.metadata.path !== "/auto") {
  throw new Error(`request capture should omit query text: ${autoTransport.lastBody()}`);
}
if (activeTraceFromAuto?.spanId !== "b7ad6b7169203331") {
  throw new Error(`async trace context was not preserved: ${JSON.stringify(activeTraceFromAuto)}`);
}
if (autoPayload.events[1].type !== "metric" || autoPayload.events[1].id !== "evt_express_metric_001") {
  throw new Error(`unexpected request metric payload: ${autoTransport.lastBody()}`);
}
if (autoPayload.events[1].attributes.name !== "http.server.duration") {
  throw new Error(`unexpected request metric name: ${autoTransport.lastBody()}`);
}
if (autoPayload.events[1].attributes.kind !== "histogram" || autoPayload.events[1].attributes.unit !== "ms") {
  throw new Error(`unexpected request metric shape: ${autoTransport.lastBody()}`);
}
if (autoPayload.events[1].attributes.metadata.routeTemplate !== "/auto") {
  throw new Error(`request metric should use route template without query text: ${autoTransport.lastBody()}`);
}
if (autoPayload.events[1].attributes.metadata.statusCodeClass !== "2xx") {
  throw new Error(`request metric should include status class: ${autoTransport.lastBody()}`);
}
const metricOnlyPayload = JSON.parse(metricOnlyTransport.lastBody());
if (metricOnlyPayload.events.length !== 1 || metricOnlyPayload.events[0].type !== "metric") {
  throw new Error(`metrics-only capture should send one metric event: ${metricOnlyTransport.lastBody()}`);
}
if (metricOnlyPayload.events[0].attributes.metadata.routeTemplate !== "/metrics-only/:id") {
  throw new Error(`metrics-only capture should prefer Express route templates: ${metricOnlyTransport.lastBody()}`);
}
const errorPayload = JSON.parse(errorTransport.lastBody());
if (errorPayload.events.length !== 3) {
  throw new Error(`error capture should retain issue, request, and metric events: ${errorTransport.lastBody()}`);
}
if (errorPayload.events[0].type !== "issue" || errorPayload.events[0].id !== "evt_express_error_001") {
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
if (errorPayload.events[1].type !== "span" || errorPayload.events[1].id !== "evt_express_error_request_001") {
  throw new Error(`error capture should retain the final request span: ${errorTransport.lastBody()}`);
}
if (errorPayload.events[1].attributes.status !== "error" || errorPayload.events[1].attributes.metadata.statusCode !== 500) {
  throw new Error(`error request span should retain the final 500 status: ${errorTransport.lastBody()}`);
}
if (errorPayload.events[2].type !== "metric" || errorPayload.events[2].id !== "evt_express_error_metric_001") {
  throw new Error(`error capture should retain the final request metric: ${errorTransport.lastBody()}`);
}
if (errorPayload.events[2].attributes.metadata.statusCodeClass !== "5xx") {
  throw new Error(`error request metric should retain the final 5xx class: ${errorTransport.lastBody()}`);
}
const abortedErrorPayload = JSON.parse(abortedErrorTransport.lastBody());
if (
  abortedErrorPayload.events.length !== 3 ||
  abortedErrorPayload.events[0].type !== "issue" ||
  abortedErrorPayload.events[1].id !== "evt_express_aborted_request_001" ||
  abortedErrorPayload.events[1].attributes.metadata.statusCode !== 500 ||
  abortedErrorPayload.events[2].id !== "evt_express_aborted_metric_001"
) {
  throw new Error(`response close should flush the complete error lifecycle: ${abortedErrorTransport.lastBody()}`);
}
const errorPreview = createErrorEvent(new Error("manual failure"), { method: "POST", originalUrl: "/manual" }, {
  now: () => "2026-06-02T10:00:08Z",
  idFactory: () => "evt_express_error_preview"
});
if (errorPreview.attributes.title !== "POST /manual failed") {
  throw new Error(`unexpected error preview: ${JSON.stringify(errorPreview)}`);
}
const metricPreview = createRequestMetricEvent(
  { method: "POST", originalUrl: "/orders/123?token=secret" },
  { statusCode: 201 },
  {
    now: () => "2026-06-02T10:00:09Z",
    durationMs: 42,
    idFactory: () => "evt_express_metric_preview"
  }
);
if (metricPreview.attributes.metadata.routeTemplate !== "/orders/123") {
  throw new Error(`unexpected metric preview route: ${JSON.stringify(metricPreview)}`);
}

console.log(okText);
console.error(JSON.stringify({
  ok: true,
  status: okResponse.status,
  attempts: requestTransport.sentBodies.length,
  autoCaptured: autoPayload.events[0].attributes.name,
  metricCaptured: autoPayload.events[1].attributes.name,
  autoTraceId: autoPayload.events[0].attributes.traceId,
  errorStatus: failResponse.status,
  errorCaptured: errorPayload.events[0].attributes.title,
  events: 6
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
  throw new Error("timed out waiting for Express capture");
}
EOF

node smoke.mjs > "$tmp_dir/express-smoke.stdout.json" 2> "$tmp_dir/express-smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/express-smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/express-smoke.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/express-smoke.stderr.json"
grep -q '"attempts":2' "$tmp_dir/express-smoke.stderr.json"
grep -q '"errorStatus":500' "$tmp_dir/express-smoke.stderr.json"
grep -q 'GET /auto' "$tmp_dir/express-smoke.stderr.json"
grep -q 'http.server.duration' "$tmp_dir/express-smoke.stderr.json"
grep -q '4bf92f3577b34da6a3ce929d0e0e4736' "$tmp_dir/express-smoke.stderr.json"
grep -q 'GET /fail failed' "$tmp_dir/express-smoke.stderr.json"

cat > default-delivery.mjs <<'EOF'
import express from "express";
import { createServer } from "node:http";
import { logbrewMiddleware } from "@logbrew/express";

const received = [];
const intake = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  received.push({
    authorization: request.headers.authorization,
    body: Buffer.concat(chunks).toString("utf8")
  });
  response.statusCode = 202;
  response.end();
});
await listen(intake);
const endpoint = `http://127.0.0.1:${intake.address().port}/v1/events`;

let defaultServer;
let failureServer;
try {
  const flushStatuses = [];
  const captureErrors = [];
  const defaultApp = express();
  defaultApp.use(logbrewMiddleware({
    serverApiKey: "default-key",
    endpoint,
    idFactory: () => "evt_express_default_delivery",
    maxRetries: 0,
    onFlush(response) {
      flushStatuses.push(response.statusCode);
    },
    onCaptureError(error) {
      captureErrors.push(error instanceof Error ? error.message : String(error));
    }
  }));
  defaultApp.get("/default-delivery", (_request, response) => {
    response.json({ ok: true });
  });
  defaultServer = await start(defaultApp);
  const response = await fetch(`http://127.0.0.1:${defaultServer.address().port}/default-delivery`);
  await response.json();
  await waitFor(() => received.length === 1, "default middleware delivery");

  if (captureErrors.length !== 0 || flushStatuses[0] !== 202) {
    throw new Error(`default middleware delivery failed: ${JSON.stringify({ captureErrors, flushStatuses })}`);
  }
  if (received[0]?.authorization !== "Bearer default-key") {
    throw new Error(`default middleware authorization changed: ${JSON.stringify(received[0])}`);
  }
  const defaultPayload = JSON.parse(received[0]?.body ?? "");
  if (defaultPayload.events?.[0]?.id !== "evt_express_default_delivery") {
    throw new Error(`default middleware payload changed: ${received[0]?.body}`);
  }

  const networkErrors = [];
  const unexpectedFlushes = [];
  const failureApp = express();
  failureApp.use(logbrewMiddleware({
    serverApiKey: "failure-key",
    endpoint,
    fetchImpl: async () => {
      throw new Error("network sentinel");
    },
    idFactory: () => "evt_express_network_failure",
    maxRetries: 0,
    onFlush(response) {
      unexpectedFlushes.push(response.statusCode);
    },
    onCaptureError(error) {
      networkErrors.push(error instanceof Error ? error.message : String(error));
    }
  }));
  failureApp.get("/default-delivery", (_request, response) => {
    response.json({ ok: true });
  });
  failureServer = await start(failureApp);
  const failureResponse = await fetch(`http://127.0.0.1:${failureServer.address().port}/default-delivery`);
  await failureResponse.json();
  await waitFor(() => networkErrors.length === 1, "default transport failure callback");

  if (!networkErrors[0]?.includes("fetch failed: network sentinel")) {
    throw new Error(`unexpected network failure: ${JSON.stringify(networkErrors)}`);
  }
  if (unexpectedFlushes.length !== 0) {
    throw new Error(`network failure reported a successful flush: ${JSON.stringify(unexpectedFlushes)}`);
  }

  console.log(JSON.stringify({
    defaultMiddlewareDelivered: defaultPayload.events[0].id,
    networkFailureSurfaced: true,
    ok: true
  }));
} finally {
  await close(failureServer);
  await close(defaultServer);
  await close(intake);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function start(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
    server.once("error", reject);
  });
}

function close(server) {
  if (!server) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}
EOF

node default-delivery.mjs > "$tmp_dir/express-default-delivery.json"
grep -q '"defaultMiddlewareDelivered":"evt_express_default_delivery"' "$tmp_dir/express-default-delivery.json"
grep -q '"networkFailureSurfaced":true' "$tmp_dir/express-default-delivery.json"

cat > default-delivery.cjs <<'EOF'
const express = require("express");
const { logbrewErrorHandler, logbrewMiddleware } = require("@logbrew/express");

const deliveries = [];
const fetchImpl = async (_url, init) => {
  deliveries.push({ authorization: init.headers.authorization, body: init.body });
  return new Response(null, { status: 202 });
};

(async () => {
  const app = express();
  app.use("/cjs-default", logbrewMiddleware({
    serverApiKey: "cjs-intake",
    endpoint: "https://intake.invalid/v1/events",
    fetchImpl,
    idFactory: () => "evt_express_cjs_default",
    maxRetries: 0
  }));
  app.get("/cjs-default", (_request, response) => response.json({ ok: true }));
  app.use("/cjs-fail", logbrewMiddleware({
    serverApiKey: "cjs-intake",
    endpoint: "https://intake.invalid/v1/events",
    fetchImpl,
    idFactory: () => "evt_express_cjs_error_request",
    captureRequestMetrics: true,
    metricIdFactory: () => "evt_express_cjs_error_metric",
    maxRetries: 0
  }));
  app.get("/cjs-fail", async () => {
    throw new Error("cjs route exploded");
  });
  app.use(logbrewErrorHandler({
    serverApiKey: "cjs-intake",
    endpoint: "https://intake.invalid/v1/events",
    fetchImpl,
    idFactory: () => "evt_express_cjs_error_issue",
    maxRetries: 0
  }));
  app.use((error, _request, response, _next) => {
    void _next;
    response.status(500).json({ error: error.message });
  });
  const server = await new Promise((resolve, reject) => {
    const candidate = app.listen(0, "127.0.0.1", () => resolve(candidate));
    candidate.once("error", reject);
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/cjs-default`);
    await response.json();
    await waitFor(() => deliveries.length === 1);
    const payload = JSON.parse(deliveries[0].body);
    if (
      deliveries[0].authorization !== "Bearer cjs-intake" ||
      payload.events?.[0]?.id !== "evt_express_cjs_default"
    ) {
      throw new Error(`unexpected CommonJS delivery: ${JSON.stringify(deliveries[0])}`);
    }
    const errorResponse = await fetch(`http://127.0.0.1:${server.address().port}/cjs-fail`);
    await errorResponse.json();
    await waitFor(() => deliveries.length === 2);
    const errorPayload = JSON.parse(deliveries[1].body);
    if (
      errorPayload.events?.length !== 3 ||
      errorPayload.events[0]?.id !== "evt_express_cjs_error_issue" ||
      errorPayload.events[1]?.id !== "evt_express_cjs_error_request" ||
      errorPayload.events[1]?.attributes?.metadata?.statusCode !== 500 ||
      errorPayload.events[2]?.id !== "evt_express_cjs_error_metric" ||
      errorPayload.events[2]?.attributes?.metadata?.statusCodeClass !== "5xx"
    ) {
      throw new Error(`CommonJS error lifecycle dropped final events: ${deliveries[1].body}`);
    }
    console.log(JSON.stringify({
      cjsDefaultDelivered: payload.events[0].id,
      cjsErrorLifecycleDelivered: errorPayload.events.length,
      ok: true
    }));
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for CommonJS default delivery");
}
EOF

node default-delivery.cjs > "$tmp_dir/express-default-delivery-cjs.json"
grep -q '"cjsDefaultDelivered":"evt_express_cjs_default"' "$tmp_dir/express-default-delivery-cjs.json"
grep -q '"cjsErrorLifecycleDelivered":3' "$tmp_dir/express-default-delivery-cjs.json"

cat > consumer.ts <<'EOF'
import express, { type NextFunction, type Request, type Response } from "express";
import { RecordingTransport } from "@logbrew/sdk";
import {
  createLogBrewExpressClient,
  createRequestEvent,
  createRequestMetricEvent,
  getActiveLogBrewTrace,
  type LogBrewTraceContext,
  logbrewErrorHandler,
  logbrewMiddleware
} from "@logbrew/express";

const app = express();
const client = createLogBrewExpressClient({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "typed-express-smoke",
  sdkVersion: "0.1.0"
});

app.use(logbrewMiddleware({
  client,
  transport: RecordingTransport.alwaysAccept(),
  captureRequestMetrics: true,
  metricIdFactory: () => "evt_typed_metric_001",
  spanIdFactory: () => "b7ad6b7169203331",
  requestEvent(req, res, { durationMs, trace }) {
    trace?.spanId.toUpperCase();
    const event = createRequestEvent(req, res, {
      durationMs,
      now: () => "2026-06-02T10:00:06Z"
    });
    if (event.type === "span") {
      event.attributes.parentSpanId?.toUpperCase();
    }
    return event;
  },
  requestMetricEvent(req, res, { durationMs }) {
    const event = createRequestMetricEvent(req, res, {
      durationMs,
      now: () => "2026-06-02T10:00:06Z"
    });
    event.attributes.metadata?.routeTemplate?.toString();
    return event;
  }
}));

app.get("/typed", (req: Request, res: Response) => {
  const activeTrace: LogBrewTraceContext | undefined = getActiveLogBrewTrace();
  activeTrace?.traceId.toUpperCase();
  req.logbrew?.trace?.spanId.toUpperCase();
  req.logbrew?.client.log("evt_log_001", "2026-06-02T10:00:03Z", {
    message: "typed worker",
    level: "info"
  });
  res.json({ pending: req.logbrew?.client.pendingEvents() ?? 0 });
});

app.use(logbrewErrorHandler({
  client,
  transport: RecordingTransport.alwaysAccept()
}));

app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
  void _next;
  res.status(500).json({ error: error.message });
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

node -e 'const express = require("@logbrew/express"); if (typeof express.logbrewMiddleware !== "function") process.exit(1)'

node node_modules/@logbrew/express/examples/index.mjs --help > "$tmp_dir/launcher-help.txt"
grep -q 'node node_modules/@logbrew/express/examples/index.mjs readme-example' "$tmp_dir/launcher-help.txt"
node node_modules/@logbrew/express/examples/index.mjs --list > "$tmp_dir/launcher-list.txt"
grep -q 'real-user-smoke -> node node_modules/@logbrew/express/examples/index.mjs real-user-smoke' "$tmp_dir/launcher-list.txt"
node node_modules/@logbrew/express/examples/index.mjs readme-example > "$tmp_dir/example-readme.stdout.json" 2> "$tmp_dir/example-readme.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/example-readme.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/example-readme.stdout.json" >/dev/null
grep -q '"attempts":1' "$tmp_dir/example-readme.stderr.json"
node node_modules/@logbrew/express/examples/index.mjs > "$tmp_dir/example-default.stdout.json" 2> "$tmp_dir/example-default.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/example-default.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/example-default.stdout.json" >/dev/null
grep -q '"attempts":2' "$tmp_dir/example-default.stderr.json"
grep -q '"errorStatus":500' "$tmp_dir/example-default.stderr.json"
npm --prefix node_modules/@logbrew/express/examples run list > "$tmp_dir/npm-helper-list.txt"
grep -q 'readme-example -> node node_modules/@logbrew/express/examples/index.mjs readme-example' "$tmp_dir/npm-helper-list.txt"
npm --prefix node_modules/@logbrew/express/examples run help > "$tmp_dir/npm-helper-help.txt"
grep -q 'npm --prefix node_modules/@logbrew/express/examples run real-user-smoke' "$tmp_dir/npm-helper-help.txt"
npm --prefix node_modules/@logbrew/express/examples run --silent real-user-smoke > "$tmp_dir/npm-helper-smoke.stdout.json" 2> "$tmp_dir/npm-helper-smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/npm-helper-smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/npm-helper-smoke.stdout.json" >/dev/null
grep -q '"attempts":2' "$tmp_dir/npm-helper-smoke.stderr.json"

echo "express real-user smoke passed with express@$express_version @types/express@$types_express_version"
