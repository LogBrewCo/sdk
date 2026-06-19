#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sdk_package_version="$(node -p "require('${repo_root}/js/logbrew-js/package.json').version")"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

core_pack_json="$tmp_dir/core-pack.json"
node_pack_json="$tmp_dir/node-pack.json"
(cd "$repo_root/js/logbrew-js" && npm pack --json --pack-destination "$tmp_dir") > "$core_pack_json"
(cd "$repo_root/js/logbrew-node" && npm pack --json --pack-destination "$tmp_dir") > "$node_pack_json"

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
core_tgz="$tmp_dir/$core_tgz"
node_tgz="$tmp_dir/$node_tgz"
test -f "$core_tgz"
test -f "$node_tgz"

tar -tzf "$node_tgz" > "$tmp_dir/node-tarball.txt"
grep -q '^package/README.md$' "$tmp_dir/node-tarball.txt"
grep -q '^package/index.js$' "$tmp_dir/node-tarball.txt"
grep -q '^package/index.cjs$' "$tmp_dir/node-tarball.txt"
grep -q '^package/index.d.ts$' "$tmp_dir/node-tarball.txt"
grep -q '^package/index.d.cts$' "$tmp_dir/node-tarball.txt"
grep -q '^package/examples/first-useful-telemetry.mjs$' "$tmp_dir/node-tarball.txt"
grep -q '^package/examples/index.mjs$' "$tmp_dir/node-tarball.txt"
grep -q '^package/examples/package.json$' "$tmp_dir/node-tarball.txt"
grep -q '^package/examples/readme-example.mjs$' "$tmp_dir/node-tarball.txt"
grep -q '^package/examples/real-user-smoke.mjs$' "$tmp_dir/node-tarball.txt"
tar -xOf "$node_tgz" package/README.md > "$tmp_dir/node-readme.md"
grep -q 'npm install @logbrew/sdk @logbrew/node' "$tmp_dir/node-readme.md"
grep -q 'pnpm add @logbrew/sdk @logbrew/node' "$tmp_dir/node-readme.md"
grep -q 'LOGBREW_API_KEY' "$tmp_dir/node-readme.md"
grep -q 'LOGBREW_SERVER_API_KEY' "$tmp_dir/node-readme.md"
grep -q 'cacheOperationWithLogBrewSpan' "$tmp_dir/node-readme.md"
grep -q 'serverApiKey' "$tmp_dir/node-readme.md"
grep -q 'queueOperationWithLogBrewSpan' "$tmp_dir/node-readme.md"
grep -q 'createNodeFetchTransport' "$tmp_dir/node-readme.md"
grep -q 'databaseOperationWithLogBrewSpan' "$tmp_dir/node-readme.md"
grep -q 'fetchWithLogBrewSpan' "$tmp_dir/node-readme.md"
grep -q 'withLogBrewHttpHandler' "$tmp_dir/node-readme.md"
grep -q 'node:http' "$tmp_dir/node-readme.md"
grep -q 'traceparent' "$tmp_dir/node-readme.md"
grep -q 'spanIdFactory' "$tmp_dir/node-readme.md"

app_dir="$tmp_dir/node-smoke-app"
mkdir -p "$app_dir"
cd "$app_dir"
npm init -y >/dev/null
npm pkg set type=module >/dev/null
npm install \
  --save-exact \
  "$core_tgz" \
  "$node_tgz" \
  "typescript" \
  "@types/node" \
  >/dev/null

grep -q '"@logbrew/sdk": "file:' package.json
grep -q '"@logbrew/node": "file:' package.json
grep -q '"@logbrew/node"' package-lock.json
grep -q '"@logbrew/sdk"' package-lock.json
npm ls @logbrew/sdk @logbrew/node >/dev/null
npm explain @logbrew/node > "$tmp_dir/npm-explain-node.txt"
grep -q '@logbrew/node@0.1.0' "$tmp_dir/npm-explain-node.txt"
npm list --depth=0 > "$tmp_dir/npm-list-depth0.txt"
grep -q '@logbrew/node@0.1.0' "$tmp_dir/npm-list-depth0.txt"
grep -q "@logbrew/sdk@${sdk_package_version}" "$tmp_dir/npm-list-depth0.txt"
npm list --json --depth=0 > "$tmp_dir/npm-list-depth0.json"
python3 - "$tmp_dir/npm-list-depth0.json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
deps = payload.get("dependencies", {})
for name in ("@logbrew/node", "@logbrew/sdk"):
    if name not in deps:
        raise SystemExit(f"missing npm dependency entry: {name}")
PY

cat > smoke.mjs <<'EOF'
import { createServer } from "node:http";
import { once } from "node:events";
import { RecordingTransport } from "@logbrew/sdk";
import {
  cacheOperationWithLogBrewSpan,
  captureHttpError,
  createNodeFetchTransport,
  createHttpErrorEvent,
  createHttpRequestEvent,
  createLogBrewNodeClient,
  createLogBrewNodeContext,
  databaseOperationWithLogBrewSpan,
  fetchWithLogBrewSpan,
  getActiveLogBrewTrace,
  queueOperationWithLogBrewSpan,
  withLogBrewHttpHandler
} from "@logbrew/node";

const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const requestTransport = new RecordingTransport([{ statusCode: 503 }, { statusCode: 202 }]);
const client = createLogBrewNodeClient({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  maxRetries: 1,
  sdkName: "node-smoke-app",
  sdkVersion: "0.1.0"
});
const legacyClient = createLogBrewNodeClient({
  apiKey: "LOGBREW_API_KEY",
  sdkName: "node-legacy-api-key-smoke",
  sdkVersion: "0.1.0"
});
if (legacyClient.pendingEvents() !== 0) {
  throw new Error("expected empty legacy client");
}
const previousServerApiKey = process.env.LOGBREW_SERVER_API_KEY;
process.env.LOGBREW_SERVER_API_KEY = "LOGBREW_SERVER_API_KEY";
const envClient = createLogBrewNodeClient({
  sdkName: "node-env-smoke",
  sdkVersion: "0.1.0"
});
if (previousServerApiKey === undefined) {
  delete process.env.LOGBREW_SERVER_API_KEY;
} else {
  process.env.LOGBREW_SERVER_API_KEY = previousServerApiKey;
}
if (envClient.pendingEvents() !== 0) {
  throw new Error("expected empty env fallback client");
}

const server = createServer(withLogBrewHttpHandler((req, res, logbrew) => {
  addFullBatch(logbrew.client);
  const event = createHttpRequestEvent(req, res, {
    idFactory: () => "evt_node_request_001",
    now: () => "2026-06-02T10:00:06Z"
  });
  if (event.attributes.metadata.path !== "/smoke") {
    throw new Error(`unexpected request event: ${JSON.stringify(event)}`);
  }
  res.end("ok");
}, {
  captureRequests: false,
  client,
  transport: requestTransport
}));

server.listen(0);
await once(server, "listening");
const port = server.address().port;
const response = await fetch(`http://127.0.0.1:${port}/smoke`);
if (response.status !== 200) {
  throw new Error(`unexpected status: ${response.status}`);
}
const payload = client.previewJson();
await client.shutdown(requestTransport);
await closeServer(server);

const captureTransport = RecordingTransport.alwaysAccept();
const captureClient = createLogBrewNodeClient({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "node-request-capture-smoke",
  sdkVersion: "0.1.0"
});
let activeTraceFromAsync;
const downstreamRequests = [];
const downstreamServer = createServer((req, res) => {
  downstreamRequests.push({
    traceparent: req.headers.traceparent,
    url: req.url
  });
  res.statusCode = 202;
  res.end("accepted");
});
downstreamServer.listen(0);
await once(downstreamServer, "listening");
const downstreamPort = downstreamServer.address().port;
const captureServer = createServer(withLogBrewHttpHandler(async (req, res, logbrew) => {
  Promise.resolve().then(() => {
    activeTraceFromAsync = getActiveLogBrewTrace();
  });
  if (logbrew.trace?.traceId !== "4bf92f3577b34da6a3ce929d0e0e4736") {
    throw new Error(`missing request trace context: ${JSON.stringify(logbrew.trace)}`);
  }
  const callerTraceparent = "00-11111111111111111111111111111111-2222222222222222-01";
  const fetchInit = {
    method: "POST",
    headers: { traceparent: callerTraceparent, accept: "application/json" }
  };
  const fetchClock = [10, 43];
  const downstreamResponse = await fetchWithLogBrewSpan(
    `http://127.0.0.1:${downstreamPort}/payments/123?coupon=summer#frag`,
    fetchInit,
    {
      client: logbrew.client,
      trace: logbrew.trace,
      id: "evt_node_fetch_span_001",
      routeTemplate: "/payments/:paymentId",
      now: () => "2026-06-02T10:00:07Z",
      nowMs: () => fetchClock.shift() ?? 43,
      spanIdFactory: () => "c7ad6b7169203331"
    }
  );
  if (downstreamResponse.status !== 202) {
    throw new Error(`unexpected downstream status: ${downstreamResponse.status}`);
  }
  if (fetchInit.headers.traceparent !== callerTraceparent) {
    throw new Error("fetchWithLogBrewSpan mutated caller headers");
  }
  res.statusCode = req.url?.startsWith("/captured") ? 204 : 404;
  res.end();
}, {
  client: captureClient,
  idFactory: () => "evt_node_request_auto",
  now: () => "2026-06-02T10:00:07Z",
  spanIdFactory: () => "b7ad6b7169203331",
  transport: captureTransport
}));
captureServer.listen(0);
await once(captureServer, "listening");
const capturePort = captureServer.address().port;
const captureResponse = await fetch(`http://127.0.0.1:${capturePort}/captured?coupon=summer`, {
  headers: {
    traceparent
  }
});
if (captureResponse.status !== 204) {
  throw new Error(`unexpected capture status: ${captureResponse.status}`);
}
await waitFor(() => captureTransport.sentBodies.length === 1 && activeTraceFromAsync);
await closeServer(captureServer);
await closeServer(downstreamServer);

let captureFailureCallbackRan = false;
const nonFatalCaptureResponse = await fetchWithLogBrewSpan("https://payments.example.invalid/capture-failure", undefined, {
  client: {
    span() {
      throw new Error("telemetry capture failed");
    }
  },
  fetchImpl: async () => new Response("accepted", { status: 203 }),
  onCaptureError(error) {
    captureFailureCallbackRan = error instanceof Error && error.message === "telemetry capture failed";
    throw new Error("callback failure should not replace fetch response");
  },
  spanIdFactory: () => "c7ad6b7169203332",
  trace: {
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "b7ad6b7169203331",
    parentSpanId: "00f067aa0ba902b7",
    sampled: true
  }
});
if (nonFatalCaptureResponse.status !== 203 || !captureFailureCallbackRan) {
  throw new Error("fetch span capture failures should not replace the fetch response");
}

const errorTransport = RecordingTransport.alwaysAccept();
const errorClient = createLogBrewNodeClient({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "node-error-smoke",
  sdkVersion: "0.1.0"
});
const errorServer = createServer(withLogBrewHttpHandler(() => {
  throw new Error("node handler exploded");
}, {
  client: errorClient,
  errorEvent(error, { req, trace }) {
    if (trace?.spanId !== "b7ad6b7169203332") {
      throw new Error(`missing error callback trace: ${JSON.stringify(trace)}`);
    }
    return createHttpErrorEvent(error, req, {
      idFactory: () => "evt_node_error_001",
      now: () => "2026-06-02T10:00:08Z"
    });
  },
  spanIdFactory: () => "b7ad6b7169203332",
  transport: errorTransport
}));
errorServer.listen(0);
await once(errorServer, "listening");
const errorPort = errorServer.address().port;
const errorResponse = await fetch(`http://127.0.0.1:${errorPort}/explode?coupon=summer`, {
  headers: {
    traceparent
  }
});
if (errorResponse.status !== 500) {
  throw new Error(`unexpected error status: ${errorResponse.status}`);
}
await waitFor(() => errorTransport.sentBodies.length === 1);
await closeServer(errorServer);

const manualErrorTransport = RecordingTransport.alwaysAccept();
const manualErrorClient = createLogBrewNodeClient({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "node-manual-error-smoke",
  sdkVersion: "0.1.0"
});
const manualServer = createServer(async (req, res) => {
  const context = createLogBrewNodeContext(manualErrorClient, manualErrorTransport);
  await captureHttpError(new Error("manual node failure"), req, res, context, {
    idFactory: () => "evt_node_error_manual",
    now: () => "2026-06-02T10:00:09Z"
  });
  res.end("captured");
});
manualServer.listen(0);
await once(manualServer, "listening");
const manualPort = manualServer.address().port;
const manualResponse = await fetch(`http://127.0.0.1:${manualPort}/manual?coupon=summer`);
if (manualResponse.status !== 200) {
  throw new Error(`unexpected manual status: ${manualResponse.status}`);
}
await waitFor(() => manualErrorTransport.sentBodies.length === 1);
await closeServer(manualServer);

const operationTrace = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "b7ad6b7169203331", sampled: true };

const databaseClient = createLogBrewNodeClient({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "node-database-span-smoke",
  sdkVersion: "0.1.0"
});
const databaseClock = [50, 87, 100, 119];
const databaseResult = await databaseOperationWithLogBrewSpan("orders.select_by_id", {
  client: databaseClient,
  databaseName: "checkout",
  id: "evt_node_database_span_001",
  metadata: {
    "db.statement": "SELECT * FROM orders WHERE id = 42",
    params: "sensitive-id",
    safeFeature: "checkout"
  },
  now: () => "2026-06-02T10:00:09Z",
  nowMs: () => databaseClock.shift() ?? 87,
  operation: async () => [{ id: 42 }],
  operationKind: "SELECT",
  rowCount: 1,
  spanIdFactory: () => "d7ad6b7169203331",
  statementTemplate: "SELECT * FROM orders WHERE id = ?",
  system: "postgresql",
  trace: operationTrace
});
if (databaseResult[0]?.id !== 42) {
  throw new Error(`database span helper changed the operation result: ${JSON.stringify(databaseResult)}`);
}
let databaseErrorRethrown = false;
await databaseOperationWithLogBrewSpan("orders.insert", {
  client: databaseClient,
  databaseName: "checkout",
  id: "evt_node_database_span_error",
  now: () => "2026-06-02T10:00:10Z",
  nowMs: () => databaseClock.shift() ?? 119,
  operation: async () => {
    throw new TypeError("duplicate key for email value@example.com");
  },
  operationKind: "INSERT",
  spanIdFactory: () => "d7ad6b7169203332",
  system: "postgresql",
  trace: operationTrace
}).catch((error) => {
  databaseErrorRethrown = error instanceof TypeError;
});
if (!databaseErrorRethrown) {
  throw new Error("database span helper should rethrow operation errors");
}
const databasePayload = JSON.parse(databaseClient.previewJson());
const databaseSpanEvent = databasePayload.events.find((event) => event.id === "evt_node_database_span_001");
const databaseErrorSpanEvent = databasePayload.events.find((event) => event.id === "evt_node_database_span_error");
if (!databaseSpanEvent || databaseSpanEvent.type !== "span") {
  throw new Error(`missing database span payload: ${databaseClient.previewJson()}`);
}
if (databaseSpanEvent.attributes.name !== "postgresql SELECT orders.select_by_id") {
  throw new Error(`unexpected database span name: ${databaseClient.previewJson()}`);
}
if (
  databaseSpanEvent.attributes.traceId !== "4bf92f3577b34da6a3ce929d0e0e4736" ||
  databaseSpanEvent.attributes.parentSpanId !== "b7ad6b7169203331" ||
  databaseSpanEvent.attributes.spanId !== "d7ad6b7169203331"
) {
  throw new Error(`database span did not correlate with request trace: ${databaseClient.previewJson()}`);
}
if (
  databaseSpanEvent.attributes.metadata.framework !== "node:database" ||
  databaseSpanEvent.attributes.metadata.dbSystem !== "postgresql" ||
  databaseSpanEvent.attributes.metadata.dbOperation !== "orders.select_by_id" ||
  databaseSpanEvent.attributes.metadata.dbOperationKind !== "SELECT" ||
  databaseSpanEvent.attributes.metadata.dbName !== "checkout" ||
  databaseSpanEvent.attributes.metadata.dbStatementTemplate !== "SELECT * FROM orders WHERE id = ?" ||
  databaseSpanEvent.attributes.metadata.rowCount !== 1 ||
  databaseSpanEvent.attributes.metadata.safeFeature !== "checkout"
) {
  throw new Error(`database span metadata was not useful and privacy bounded: ${databaseClient.previewJson()}`);
}
if (!databaseErrorSpanEvent || databaseErrorSpanEvent.attributes.status !== "error") {
  throw new Error(`database error span missing: ${databaseClient.previewJson()}`);
}
if (databaseErrorSpanEvent.attributes.metadata.errorType !== "TypeError") {
  throw new Error(`database error should include error type only: ${databaseClient.previewJson()}`);
}
const databasePayloadJson = JSON.stringify(databasePayload);
if (
  databasePayloadJson.includes("sens" + "itive-id") ||
  databasePayloadJson.includes("email") ||
  databasePayloadJson.includes("id = 42") ||
  databasePayloadJson.includes("params") ||
  databasePayloadJson.includes("db.statement")
) {
  throw new Error(`database span leaked query details or unsafe metadata: ${databaseClient.previewJson()}`);
}

const cacheClient = createLogBrewNodeClient({ serverApiKey: "LOGBREW_SERVER_API_KEY", sdkName: "node-cache-span-smoke", sdkVersion: "0.1.0" });
const cacheClock = [200, 214, 220, 235];
const cacheResult = await cacheOperationWithLogBrewSpan("profile.get", {
  cacheName: "profiles",
  client: cacheClient,
  hit: true,
  id: "evt_node_cache_span_001",
  itemCount: 1,
  itemSizeBytes: 128,
  metadata: {
    cacheKey: "user:42",
    safeFeature: "profile"
  },
  now: () => "2026-06-02T10:00:11Z",
  nowMs: () => cacheClock.shift() ?? 214,
  operation: async () => ({ name: "Ada" }),
  operationKind: "GET",
  spanIdFactory: () => "e7ad6b7169203331",
  system: "redis",
  trace: operationTrace
});
if (cacheResult.name !== "Ada") {
  throw new Error(`cache span helper changed the operation result: ${JSON.stringify(cacheResult)}`);
}
let cacheErrorRethrown = false;
await cacheOperationWithLogBrewSpan("profile.set", {
  client: cacheClient,
  id: "evt_node_cache_span_error",
  now: () => "2026-06-02T10:00:12Z",
  nowMs: () => cacheClock.shift() ?? 235,
  operation: async () => {
    throw new RangeError("redis value for user@example.com was too large");
  },
  operationKind: "SET",
  spanIdFactory: () => "e7ad6b7169203332",
  system: "redis",
  trace: operationTrace
}).catch((error) => {
  cacheErrorRethrown = error instanceof RangeError;
});
if (!cacheErrorRethrown) {
  throw new Error("cache span helper should rethrow operation errors");
}
const cachePayload = JSON.parse(cacheClient.previewJson());
const cacheSpanEvent = cachePayload.events.find((event) => event.id === "evt_node_cache_span_001");
const cacheErrorSpanEvent = cachePayload.events.find((event) => event.id === "evt_node_cache_span_error");
if (!cacheSpanEvent || cacheSpanEvent.type !== "span") {
  throw new Error(`missing cache span payload: ${cacheClient.previewJson()}`);
}
if (cacheSpanEvent.attributes.name !== "redis GET profile.get") {
  throw new Error(`unexpected cache span name: ${cacheClient.previewJson()}`);
}
if (
  cacheSpanEvent.attributes.metadata.framework !== "node:cache" ||
  cacheSpanEvent.attributes.metadata.cacheSystem !== "redis" ||
  cacheSpanEvent.attributes.metadata.cacheOperation !== "profile.get" ||
  cacheSpanEvent.attributes.metadata.cacheOperationKind !== "GET" ||
  cacheSpanEvent.attributes.metadata.cacheName !== "profiles" ||
  cacheSpanEvent.attributes.metadata.cacheHit !== true ||
  cacheSpanEvent.attributes.metadata.itemSizeBytes !== 128 ||
  cacheSpanEvent.attributes.metadata.itemCount !== 1 ||
  cacheSpanEvent.attributes.metadata.safeFeature !== "profile"
) {
  throw new Error(`cache span metadata was not useful and privacy bounded: ${cacheClient.previewJson()}`);
}
if (!cacheErrorSpanEvent || cacheErrorSpanEvent.attributes.metadata.errorType !== "RangeError") {
  throw new Error(`cache error should include error type only: ${cacheClient.previewJson()}`);
}
const cachePayloadJson = JSON.stringify(cachePayload);
if (
  cachePayloadJson.includes("user:42") ||
  cachePayloadJson.includes("user@example.com") ||
  cachePayloadJson.includes("cacheKey")
) {
  throw new Error(`cache span leaked key or value details: ${cacheClient.previewJson()}`);
}

const queueClient = createLogBrewNodeClient({ serverApiKey: "LOGBREW_SERVER_API_KEY", sdkName: "node-queue-span-smoke", sdkVersion: "0.1.0" });
const queueClock = [300, 329, 340, 377];
const queueResult = await queueOperationWithLogBrewSpan("email.publish", {
  client: queueClient,
  id: "evt_node_queue_span_001",
  messageCount: 2,
  metadata: {
    body: "hello user@example.com",
    safeFeature: "notifications"
  },
  now: () => "2026-06-02T10:00:13Z",
  nowMs: () => queueClock.shift() ?? 329,
  operation: async () => "queued",
  operationKind: "publish",
  queueName: "email",
  spanIdFactory: () => "f7ad6b7169203331",
  system: "amqp",
  taskName: "send_welcome_email",
  trace: operationTrace
});
if (queueResult !== "queued") {
  throw new Error(`queue span helper changed the operation result: ${JSON.stringify(queueResult)}`);
}
let queueErrorRethrown = false;
await queueOperationWithLogBrewSpan("email.process", {
  client: queueClient,
  id: "evt_node_queue_span_error",
  now: () => "2026-06-02T10:00:14Z",
  nowMs: () => queueClock.shift() ?? 377,
  operation: async () => {
    throw new SyntaxError("bad payload for user@example.com");
  },
  operationKind: "process",
  queueName: "email",
  spanIdFactory: () => "f7ad6b7169203332",
  system: "amqp",
  trace: operationTrace
}).catch((error) => {
  queueErrorRethrown = error instanceof SyntaxError;
});
if (!queueErrorRethrown) {
  throw new Error("queue span helper should rethrow operation errors");
}
const queuePayload = JSON.parse(queueClient.previewJson());
const queueSpanEvent = queuePayload.events.find((event) => event.id === "evt_node_queue_span_001");
const queueErrorSpanEvent = queuePayload.events.find((event) => event.id === "evt_node_queue_span_error");
if (!queueSpanEvent || queueSpanEvent.type !== "span") {
  throw new Error(`missing queue span payload: ${queueClient.previewJson()}`);
}
if (queueSpanEvent.attributes.name !== "amqp publish email.publish") {
  throw new Error(`unexpected queue span name: ${queueClient.previewJson()}`);
}
if (
  queueSpanEvent.attributes.metadata.framework !== "node:queue" ||
  queueSpanEvent.attributes.metadata.queueSystem !== "amqp" ||
  queueSpanEvent.attributes.metadata.queueOperation !== "email.publish" ||
  queueSpanEvent.attributes.metadata.queueOperationKind !== "publish" ||
  queueSpanEvent.attributes.metadata.queueName !== "email" ||
  queueSpanEvent.attributes.metadata.taskName !== "send_welcome_email" ||
  queueSpanEvent.attributes.metadata.messageCount !== 2 ||
  queueSpanEvent.attributes.metadata.safeFeature !== "notifications"
) {
  throw new Error(`queue span metadata was not useful and privacy bounded: ${queueClient.previewJson()}`);
}
if (!queueErrorSpanEvent || queueErrorSpanEvent.attributes.metadata.errorType !== "SyntaxError") {
  throw new Error(`queue error should include error type only: ${queueClient.previewJson()}`);
}
const queuePayloadJson = JSON.stringify(queuePayload);
if (
  queuePayloadJson.includes("hello user@example.com") ||
  queuePayloadJson.includes("bad payload") ||
  queuePayloadJson.includes("body")
) {
  throw new Error(`queue span leaked message details: ${queueClient.previewJson()}`);
}

const intakeRequests = [];
const intakeServer = createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    intakeRequests.push({
      authorization: req.headers.authorization,
      body,
      contentType: req.headers["content-type"],
      method: req.method,
      source: req.headers["x-logbrew-source"],
      url: req.url
    });
    res.statusCode = intakeRequests.length === 1 ? 503 : 202;
    res.end("accepted");
  });
});
intakeServer.listen(0);
await once(intakeServer, "listening");
const intakePort = intakeServer.address().port;
const httpClient = createLogBrewNodeClient({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  maxRetries: 1,
  sdkName: "node-fetch-transport-smoke",
  sdkVersion: "0.1.0"
});
const httpTransport = createNodeFetchTransport({
  endpoint: `http://127.0.0.1:${intakePort}/v1/events`,
  headers: {
    "x-logbrew-source": "node-smoke"
  }
});
httpClient.log("evt_node_fetch_transport", "2026-06-02T10:00:10Z", {
  message: "node fetch transport sent",
  level: "info",
  logger: "node"
});
const httpResponse = await httpClient.flush(httpTransport);
await closeServer(intakeServer);
if (httpResponse.statusCode !== 202 || httpResponse.attempts !== 2) {
  throw new Error(`unexpected fetch transport response: ${JSON.stringify(httpResponse)}`);
}
if (httpClient.pendingEvents() !== 0 || intakeRequests.length !== 2) {
  throw new Error(`unexpected fetch transport state: ${JSON.stringify({ pending: httpClient.pendingEvents(), requests: intakeRequests.length })}`);
}
if (intakeRequests[0].authorization !== "Bearer LOGBREW_SERVER_API_KEY") {
  throw new Error(`unexpected authorization header: ${intakeRequests[0].authorization}`);
}
if (intakeRequests[0].source !== "node-smoke" || intakeRequests[0].method !== "POST" || intakeRequests[0].url !== "/v1/events") {
  throw new Error(`unexpected intake request metadata: ${JSON.stringify(intakeRequests[0])}`);
}
const intakePayload = JSON.parse(intakeRequests[1].body);
if (intakePayload.events[0].id !== "evt_node_fetch_transport") {
  throw new Error(`unexpected fetch transport payload: ${intakeRequests[1].body}`);
}

const capturePayload = JSON.parse(captureTransport.lastBody());
const errorPayload = JSON.parse(errorTransport.lastBody());
const manualErrorPayload = JSON.parse(manualErrorTransport.lastBody());
const captureRequestEvent = capturePayload.events.find((event) => event.id === "evt_node_request_auto");
const fetchSpanEvent = capturePayload.events.find((event) => event.id === "evt_node_fetch_span_001");
if (!captureRequestEvent) {
  throw new Error(`unexpected request capture payload: ${captureTransport.lastBody()}`);
}
if (captureRequestEvent.attributes.metadata.path !== "/captured") {
  throw new Error(`request capture should omit query text: ${captureTransport.lastBody()}`);
}
if (captureRequestEvent.type !== "span") {
  throw new Error(`expected node request span payload: ${captureTransport.lastBody()}`);
}
if (captureRequestEvent.attributes.traceId !== "4bf92f3577b34da6a3ce929d0e0e4736") {
  throw new Error(`unexpected node trace id: ${captureTransport.lastBody()}`);
}
if (captureRequestEvent.attributes.parentSpanId !== "00f067aa0ba902b7") {
  throw new Error(`unexpected node parent span id: ${captureTransport.lastBody()}`);
}
if (captureRequestEvent.attributes.spanId !== "b7ad6b7169203331") {
  throw new Error(`unexpected node request span id: ${captureTransport.lastBody()}`);
}
if (captureRequestEvent.attributes.metadata.framework !== "node:http") {
  throw new Error(`missing node span metadata: ${captureTransport.lastBody()}`);
}
if (captureRequestEvent.attributes.metadata.sampled !== true) {
  throw new Error(`missing sampled request metadata: ${captureTransport.lastBody()}`);
}
if (activeTraceFromAsync?.spanId !== "b7ad6b7169203331") {
  throw new Error(`async trace context was not preserved: ${JSON.stringify(activeTraceFromAsync)}`);
}
if (!fetchSpanEvent) {
  throw new Error(`missing outbound fetch span: ${captureTransport.lastBody()}`);
}
if (fetchSpanEvent.type !== "span" || fetchSpanEvent.attributes.name !== "POST /payments/:paymentId") {
  throw new Error(`unexpected fetch span shape: ${captureTransport.lastBody()}`);
}
if (
  fetchSpanEvent.attributes.traceId !== "4bf92f3577b34da6a3ce929d0e0e4736" ||
  fetchSpanEvent.attributes.parentSpanId !== "b7ad6b7169203331" ||
  fetchSpanEvent.attributes.spanId !== "c7ad6b7169203331"
) {
  throw new Error(`fetch span did not correlate with active request trace: ${captureTransport.lastBody()}`);
}
if (fetchSpanEvent.attributes.durationMs !== 33 || fetchSpanEvent.attributes.status !== "ok") {
  throw new Error(`fetch span did not capture response timing/status: ${captureTransport.lastBody()}`);
}
if (
  fetchSpanEvent.attributes.metadata.framework !== "node:fetch" ||
  fetchSpanEvent.attributes.metadata.method !== "POST" ||
  fetchSpanEvent.attributes.metadata.path !== "/payments/:paymentId" ||
  fetchSpanEvent.attributes.metadata.statusCode !== 202
) {
  throw new Error(`fetch span metadata was not useful and privacy bounded: ${captureTransport.lastBody()}`);
}
if (downstreamRequests[0]?.traceparent !== "00-4bf92f3577b34da6a3ce929d0e0e4736-c7ad6b7169203331-01") {
  throw new Error(`fetch span did not inject one normalized traceparent: ${JSON.stringify(downstreamRequests)}`);
}
const capturePayloadJson = JSON.stringify(capturePayload);
if (capturePayloadJson.includes("coupon=summer") || capturePayloadJson.includes("11111111111111111111111111111111")) {
  throw new Error(`fetch span leaked query text or caller propagation headers: ${captureTransport.lastBody()}`);
}
if (errorPayload.events[0].id !== "evt_node_error_001") {
  throw new Error(`unexpected error payload: ${errorTransport.lastBody()}`);
}
if (errorPayload.events[0].attributes.metadata.path !== "/explode") {
  throw new Error(`error capture should omit query text: ${errorTransport.lastBody()}`);
}
if (errorPayload.events[0].attributes.metadata.traceId !== "4bf92f3577b34da6a3ce929d0e0e4736") {
  throw new Error(`error capture should include trace id: ${errorTransport.lastBody()}`);
}
if (errorPayload.events[0].attributes.metadata.spanId !== "b7ad6b7169203332") {
  throw new Error(`error capture should include request span id: ${errorTransport.lastBody()}`);
}
if (manualErrorPayload.events[0].id !== "evt_node_error_manual") {
  throw new Error(`unexpected manual error payload: ${manualErrorTransport.lastBody()}`);
}
if (manualErrorPayload.events[0].attributes.metadata.path !== "/manual") {
  throw new Error(`manual error capture should omit query text: ${manualErrorTransport.lastBody()}`);
}

console.log(payload);
console.error(JSON.stringify({
  ok: true,
  attempts: requestTransport.sentBodies.length,
  errorCaptured: errorPayload.events[0].attributes.title,
  events: JSON.parse(payload).events.length,
  httpAttempts: httpResponse.attempts,
  httpEvents: intakePayload.events.length,
  manualErrorCaptured: manualErrorPayload.events[0].attributes.title,
  databaseCaptured: databaseSpanEvent.attributes.name,
  fetchCaptured: fetchSpanEvent.attributes.name,
  requestCaptured: captureRequestEvent.attributes.name,
  requestTraceId: captureRequestEvent.attributes.traceId,
  requestHelper: "evt_node_request_001"
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
  throw new Error("timed out waiting for Node.js capture");
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
EOF

node smoke.mjs > "$tmp_dir/node-smoke.stdout.json" 2> "$tmp_dir/node-smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/node-smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/node-smoke.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/node-smoke.stderr.json"
grep -q '"attempts":2' "$tmp_dir/node-smoke.stderr.json"
grep -q '"events":6' "$tmp_dir/node-smoke.stderr.json"
grep -q '"httpAttempts":2' "$tmp_dir/node-smoke.stderr.json"
grep -q '"httpEvents":1' "$tmp_dir/node-smoke.stderr.json"
grep -q 'GET /explode failed' "$tmp_dir/node-smoke.stderr.json"
grep -q 'GET /manual failed' "$tmp_dir/node-smoke.stderr.json"
grep -q 'GET /captured' "$tmp_dir/node-smoke.stderr.json"
grep -q '4bf92f3577b34da6a3ce929d0e0e4736' "$tmp_dir/node-smoke.stderr.json"
grep -q '"requestHelper":"evt_node_request_001"' "$tmp_dir/node-smoke.stderr.json"

cat > consumer.ts <<'EOF'
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  cacheOperationWithLogBrewSpan,
  createNodeFetchTransport,
  fetchWithLogBrewSpan,
  createHttpRequestEvent,
  createLogBrewNodeClient,
  databaseOperationWithLogBrewSpan,
  getActiveLogBrewTrace,
  queueOperationWithLogBrewSpan,
  type LogBrewNodeContext,
  type LogBrewTraceContext,
  withLogBrewHttpHandler
} from "@logbrew/node";

const client = createLogBrewNodeClient({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "typed-node-smoke",
  sdkVersion: "0.1.0"
});
const transport = createNodeFetchTransport({
  endpoint: "http://127.0.0.1:4318/v1/events",
  fetchImpl: async () => new Response("accepted", { status: 202 })
});
const trace = getActiveLogBrewTrace();
await fetchWithLogBrewSpan("https://payments.example.invalid/payments/123?coupon=summer", {
  method: "POST"
}, {
  client,
  fetchImpl: async () => new Response("accepted", { status: 202 }),
  routeTemplate: "/payments/:paymentId",
  trace
});
const databaseResult = await databaseOperationWithLogBrewSpan("orders.select_by_id", {
  client,
  databaseName: "checkout",
  operation: async () => [{ id: 42 }],
  operationKind: "SELECT",
  rowCount: 1,
  statementTemplate: "SELECT * FROM orders WHERE id = ?",
  system: "postgresql",
  trace
});
databaseResult[0]?.id.toFixed();
const cacheResult = await cacheOperationWithLogBrewSpan("profile.get", {
  client,
  hit: true,
  operation: async () => ({ name: "Ada" }),
  operationKind: "GET",
  system: "redis",
  trace
});
cacheResult.name.toUpperCase();
const queueResult = await queueOperationWithLogBrewSpan("email.publish", {
  client,
  operation: async () => "queued",
  operationKind: "publish",
  queueName: "email",
  system: "amqp",
  trace
});
queueResult.toUpperCase();

const handler = withLogBrewHttpHandler((
  req: IncomingMessage,
  res: ServerResponse,
  context: LogBrewNodeContext
): void => {
  if (!req.logbrew) {
    throw new Error("missing request context");
  }
  const activeTrace: LogBrewTraceContext | undefined = getActiveLogBrewTrace();
  activeTrace?.traceId.toUpperCase();
  context.trace?.spanId.toUpperCase();
  const event = createHttpRequestEvent(req, res, {
    now: () => "2026-06-02T10:00:06Z",
    spanIdFactory: () => "b7ad6b7169203331"
  });
  if (event.type === "span") {
    event.attributes.parentSpanId?.toUpperCase();
    context.client.span(event.id, event.timestamp, event.attributes);
  } else {
    context.client.log(event.id, event.timestamp, event.attributes);
  }
  res.end(`${req.logbrew.client.pendingEvents()}`);
}, {
  client,
  captureRequests: false,
  transport
});

const server = createServer(handler);

export { handler, server };
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

node -e 'const node = require("@logbrew/node"); if (typeof node.withLogBrewHttpHandler !== "function") process.exit(1)'
node -e 'const node = require("@logbrew/node"); if (typeof node.createNodeFetchTransport !== "function") process.exit(1)'

node node_modules/@logbrew/node/examples/index.mjs --help > "$tmp_dir/launcher-help.txt"
grep -q 'node node_modules/@logbrew/node/examples/index.mjs first-useful-telemetry' "$tmp_dir/launcher-help.txt"
grep -q 'node node_modules/@logbrew/node/examples/index.mjs readme-example' "$tmp_dir/launcher-help.txt"
node node_modules/@logbrew/node/examples/index.mjs --list > "$tmp_dir/launcher-list.txt"
grep -q 'first-useful-telemetry -> node node_modules/@logbrew/node/examples/index.mjs first-useful-telemetry' "$tmp_dir/launcher-list.txt"
grep -q 'real-user-smoke -> node node_modules/@logbrew/node/examples/index.mjs real-user-smoke' "$tmp_dir/launcher-list.txt"
node node_modules/@logbrew/node/examples/index.mjs first-useful-telemetry > "$tmp_dir/example-first-useful.stdout.json" 2> "$tmp_dir/example-first-useful.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/example-first-useful.stdout.json" >/dev/null
python3 - "$tmp_dir/example-first-useful.stdout.json" "$tmp_dir/example-first-useful.stderr.json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
summary = json.loads(Path(sys.argv[2]).read_text())
events = payload.get("events", [])
ids = {event.get("id") for event in events}
required_ids = {
    "evt_release_checkout_api",
    "evt_environment_checkout_api",
    "evt_log_checkout_received",
    "evt_action_checkout_started",
    "evt_network_payment_authorized",
    "evt_metric_checkout_duration",
    "evt_span_checkout_request",
}
missing = sorted(required_ids - ids)
if missing:
    raise SystemExit(f"missing first useful telemetry ids: {missing}")
request_span = next(event for event in events if event["id"] == "evt_span_checkout_request")
if request_span["type"] != "span":
    raise SystemExit(f"expected request span, got {request_span}")
metadata = request_span["attributes"]["metadata"]
if metadata["path"] != "/checkout/123" or "coupon" in json.dumps(metadata):
    raise SystemExit(f"request span should omit query text: {metadata}")
network = next(event for event in events if event["id"] == "evt_network_payment_authorized")
if network["attributes"]["metadata"]["routeTemplate"] != "/payments/:paymentId":
    raise SystemExit(f"missing network route template: {network}")
if summary.get("events") != 7 or summary.get("traceId") != request_span["attributes"]["traceId"]:
    raise SystemExit(f"unexpected first useful summary: {summary}")
PY
node node_modules/@logbrew/node/examples/index.mjs readme-example > "$tmp_dir/example-readme.stdout.json" 2> "$tmp_dir/example-readme.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/example-readme.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/example-readme.stdout.json" >/dev/null
grep -q '"attempts":1' "$tmp_dir/example-readme.stderr.json"
grep -q '"requestHelper":"evt_node_request_001"' "$tmp_dir/example-readme.stderr.json"
node node_modules/@logbrew/node/examples/index.mjs > "$tmp_dir/example-default.stdout.json" 2> "$tmp_dir/example-default.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/example-default.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/example-default.stdout.json" >/dev/null
grep -q '"attempts":2' "$tmp_dir/example-default.stderr.json"
grep -q 'GET /explode failed' "$tmp_dir/example-default.stderr.json"
npm --prefix node_modules/@logbrew/node/examples run list > "$tmp_dir/npm-helper-list.txt"
grep -q 'first-useful-telemetry -> node node_modules/@logbrew/node/examples/index.mjs first-useful-telemetry' "$tmp_dir/npm-helper-list.txt"
grep -q 'readme-example -> node node_modules/@logbrew/node/examples/index.mjs readme-example' "$tmp_dir/npm-helper-list.txt"
npm --prefix node_modules/@logbrew/node/examples run help > "$tmp_dir/npm-helper-help.txt"
grep -q 'npm --prefix node_modules/@logbrew/node/examples run first-useful-telemetry' "$tmp_dir/npm-helper-help.txt"
grep -q 'npm --prefix node_modules/@logbrew/node/examples run real-user-smoke' "$tmp_dir/npm-helper-help.txt"
npm --prefix node_modules/@logbrew/node/examples run --silent first-useful-telemetry > "$tmp_dir/npm-helper-first-useful.stdout.json" 2> "$tmp_dir/npm-helper-first-useful.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/npm-helper-first-useful.stdout.json" >/dev/null
grep -q '"events":7' "$tmp_dir/npm-helper-first-useful.stderr.json"
npm --prefix node_modules/@logbrew/node/examples run --silent real-user-smoke > "$tmp_dir/npm-helper-smoke.stdout.json" 2> "$tmp_dir/npm-helper-smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/npm-helper-smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/npm-helper-smoke.stdout.json" >/dev/null
grep -q '"attempts":2' "$tmp_dir/npm-helper-smoke.stderr.json"

echo "node real-user smoke passed with $(node --version)"
