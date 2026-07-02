#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sdk_package_version="$(node -p "require('${repo_root}/js/logbrew-js/package.json').version")"
node_package_version="$(node -p "require('${repo_root}/js/logbrew-node/package.json').version")"
tmp_dir="$(mktemp -d)"
export npm_config_cache="$tmp_dir/npm-cache"

remove_tmp_dir() {
  rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT

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

app_dir="$tmp_dir/node-undici-high-load-app"
mkdir -p "$app_dir"
cd "$app_dir"
npm init -y >/dev/null
npm pkg set type=module >/dev/null
npm install \
  --save-exact \
  --no-audit \
  --fund=false \
  "$core_tgz" \
  "$node_tgz" \
  >/dev/null

grep -q '"@logbrew/sdk": "file:' package.json
grep -q '"@logbrew/node": "file:' package.json
grep -q '"@logbrew/sdk"' package-lock.json
grep -q '"@logbrew/node"' package-lock.json
npm ls @logbrew/sdk @logbrew/node >/dev/null
npm list --depth=0 > "$tmp_dir/npm-list-depth0.txt"
grep -q "@logbrew/sdk@${sdk_package_version}" "$tmp_dir/npm-list-depth0.txt"
grep -q "@logbrew/node@${node_package_version}" "$tmp_dir/npm-list-depth0.txt"
test -f node_modules/@logbrew/sdk/index.js
test -f node_modules/@logbrew/node/index.js
test -f node_modules/@logbrew/node/undici.js
test -f node_modules/@logbrew/node/undici.cjs

cat > smoke.mjs <<'EOF'
import http from "node:http";
import { once } from "node:events";
import { LogBrewClient, SdkError } from "@logbrew/sdk";
import {
  createNodeFetchTransport,
  installLogBrewUndiciInstrumentation
} from "@logbrew/node";

const highVolumeRequests = 1500;
const maxQueueSize = 1000;
const requestBatchSize = 100;
const serverApiKey = "LOGBREW_SERVER_API_KEY";
const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const parentSpanId = "00f067aa0ba902b7";
const drops = [];
const intakeRequests = [];
const targetRequests = [];
let spanSequence = 0;

const client = LogBrewClient.create({
  apiKey: serverApiKey,
  maxRetries: 1,
  maxQueueSize,
  sdkName: "node-undici-high-load-smoke",
  sdkVersion: "0.1.0",
  onEventDropped(drop) {
    drops.push(drop);
  }
});

const targetServer = http.createServer((req, res) => {
  targetRequests.push({
    traceparent: req.headers.traceparent,
    url: req.url
  });
  const itemIndex = Number(req.url?.match(/\/items\/(\d+)/)?.[1] ?? 0);
  res.statusCode = itemIndex % 10 === 0 ? 503 : 202;
  res.setHeader("content-length", res.statusCode === 503 ? "9" : "8");
  res.end(res.statusCode === 503 ? "try later" : "accepted");
});
targetServer.listen(0, "127.0.0.1");
await once(targetServer, "listening");
const targetPort = targetServer.address().port;
const targetOrigin = `http://127.0.0.1:${targetPort}`;

const instrumentation = installLogBrewUndiciInstrumentation({
  captureTargets: [`${targetOrigin}/api/`],
  client,
  metadata: {
    release: "checkout-api@1.2.3",
    service: "checkout-api",
    headers: "must not leak"
  },
  routeTemplateFactory({ path }) {
    return path.replace(/\/\d+/gu, "/:id");
  },
  spanIdFactory() {
    spanSequence += 1;
    return hexId(spanSequence, 16);
  },
  trace: {
    traceId,
    spanId: parentSpanId,
    sampled: true
  }
});
if (!instrumentation.isInstalled()) {
  throw new Error("expected undici high-load instrumentation to report installed");
}

for (let offset = 0; offset < highVolumeRequests; offset += requestBatchSize) {
  const requests = [];
  for (let index = offset; index < Math.min(offset + requestBatchSize, highVolumeRequests); index += 1) {
    requests.push(fetch(`${targetOrigin}/api/items/${index}?email=dev@example.test#fragment`, {
      method: index % 2 === 0 ? "POST" : "GET"
    }).then(async (response) => {
      await response.text();
      return response.status;
    }));
  }
  await Promise.all(requests);
}

instrumentation.uninstall();
if (instrumentation.isInstalled()) {
  throw new Error("expected undici high-load instrumentation to uninstall");
}
await fetch(`${targetOrigin}/api/items/after-uninstall?email=dev@example.test`);
await closeServer(targetServer);

assertEqual(targetRequests.length, highVolumeRequests + 1, "target request count");
for (const [index, request] of targetRequests.entries()) {
  if (index === highVolumeRequests) {
    assertEqual(request.traceparent, undefined, "traceparent after uninstall");
    continue;
  }
  if (!request.traceparent?.startsWith(`00-${traceId}-`)) {
    throw new Error(`missing propagated traceparent for request ${index}: ${request.traceparent}`);
  }
  if (request.url.includes("#fragment")) {
    throw new Error(`server saw a URL fragment: ${request.url}`);
  }
}

assertEqual(client.pendingEvents(), maxQueueSize, "bounded queue size");
assertEqual(client.droppedEvents(), highVolumeRequests - maxQueueSize, "dropped event count");
assertEqual(drops.length, highVolumeRequests - maxQueueSize, "drop callback count");
assertEqual(drops[0].eventType, "span", "first dropped event type");
assertEqual(drops[0].reason, "queue_overflow", "drop reason");

const intakeServer = http.createServer((req, res) => {
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
intakeServer.listen(0, "127.0.0.1");
await once(intakeServer, "listening");
const intakePort = intakeServer.address().port;
const response = await client.flush(createNodeFetchTransport({
  endpoint: `http://127.0.0.1:${intakePort}/v1/events`,
  headers: {
    "x-logbrew-source": "node-undici-high-load-smoke"
  }
}));
await closeServer(intakeServer);

assertEqual(response.statusCode, 202, "flush status");
assertEqual(response.attempts, 2, "retryAttempts");
assertEqual(intakeRequests.length, 2, "retry request count");
assertEqual(client.pendingEvents(), 0, "queue after successful flush");
for (const request of intakeRequests) {
  assertEqual(request.authorization, `Bearer ${serverApiKey}`, "authorization header");
  assertEqual(request.contentType, "application/json", "content type");
  assertEqual(request.method, "POST", "request method");
  assertEqual(request.source, "node-undici-high-load-smoke", "source header");
  assertEqual(request.url, "/v1/events", "request path");
  assertNoUnsafeContent(request.body);
}

const payload = JSON.parse(intakeRequests.at(-1).body);
assertEqual(payload.sdk.name, "node-undici-high-load-smoke", "sdk name");
assertEqual(payload.events.length, maxQueueSize, "flushed span count");
assertEqual(payload.events[0].type, "span", "first event type");
const spans = payload.events.map((event) => event.attributes);
const errorSpans = spans.filter((span) => span.status === "error");
if (errorSpans.length < 90) {
  throw new Error(`expected many HTTP error spans, got ${errorSpans.length}`);
}
for (const span of spans.slice(0, 25)) {
  if (!span.parentSpanId || span.traceId !== traceId || span.parentSpanId !== parentSpanId) {
    throw new Error(`span correlation missing: ${JSON.stringify(span)}`);
  }
  assertEqual(span.metadata.framework, "node:undici", "undici framework metadata");
  assertEqual(span.metadata["http.route"], "/api/items/:id", "route template");
  assertEqual(span.metadata["url.path"], "/api/items/:id", "url path");
  assertEqual(span.metadata.service, "checkout-api", "service metadata");
  assertEqual(span.metadata.release, "checkout-api@1.2.3", "release metadata");
  assertFiniteNonNegative(span.durationMs, "span duration");
  assertFiniteNonNegative(span.metadata["http.phase.request_ms"], "request phase");
  assertFiniteNonNegative(span.metadata["http.phase.wait_ms"], "wait phase");
  assertFiniteNonNegative(span.metadata["http.phase.response_ms"], "response phase");
  assertFiniteNonNegative(span.metadata["http.response_content_length"], "response content length");
}

const shutdownClient = LogBrewClient.create({
  apiKey: serverApiKey,
  sdkName: "node-undici-high-load-shutdown-smoke",
  sdkVersion: "0.1.0"
});
const shutdownServer = http.createServer((_req, res) => {
  res.statusCode = 202;
  res.end("accepted");
});
shutdownServer.listen(0, "127.0.0.1");
await once(shutdownServer, "listening");
const shutdownPort = shutdownServer.address().port;
const shutdownInstrumentation = installLogBrewUndiciInstrumentation({
  captureTargets: [`http://127.0.0.1:${shutdownPort}/`],
  client: shutdownClient,
  spanIdFactory: () => "1111111111111111",
  trace: {
    traceId,
    spanId: parentSpanId,
    sampled: true
  }
});
await fetch(`http://127.0.0.1:${shutdownPort}/before-shutdown`);
const shutdownResponse = await shutdownClient.shutdown({
  async send() {
    return { statusCode: 202, attempts: 1 };
  }
});
assertEqual(shutdownResponse.statusCode, 202, "shutdown status");
await fetch(`http://127.0.0.1:${shutdownPort}/after-shutdown`);
shutdownInstrumentation.uninstall();
await closeServer(shutdownServer);
const shutdownError = await captureError(() => Promise.resolve().then(() => {
  shutdownClient.span("evt_node_direct_after_shutdown", timestamp(2000), {
    name: "GET /after-shutdown",
    traceId,
    spanId: "2222222222222222",
    status: "ok"
  });
}));
if (!(shutdownError instanceof SdkError)) {
  throw new Error(`expected SdkError after shutdown, got ${shutdownError}`);
}
assertEqual(shutdownError.code, "shutdown_error", "post-shutdown error code");

console.log(JSON.stringify({
  ok: true,
  droppedSpans: client.droppedEvents(),
  flushedSpans: payload.events.length,
  highVolumeRequests,
  pendingEvents: client.pendingEvents(),
  retryAttempts: response.attempts,
  shutdownStatus: shutdownResponse.statusCode
}));

function timestamp(offset) {
  return new Date(Date.UTC(2026, 5, 2, 10, 0, offset)).toISOString();
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertFiniteNonNegative(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label}: expected finite non-negative number, got ${JSON.stringify(value)}`);
  }
}

function assertNoUnsafeContent(text) {
  for (const unsafe of [
    "dev@example.test",
    "email=dev",
    "#fragment",
    "headers",
    "authorization",
    "traceparent",
    "try later",
    "accepted"
  ]) {
    if (text.includes(unsafe)) {
      throw new Error(`payload included unsafe content ${unsafe}`);
    }
  }
}

async function captureError(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("expected operation to throw");
}

function hexId(value, length) {
  return value.toString(16).padStart(length, "0").slice(-length);
}

function closeServer(server) {
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
EOF

node smoke.mjs > "$tmp_dir/node-undici-high-load.stdout.json"
grep -q '"ok":true' "$tmp_dir/node-undici-high-load.stdout.json"
grep -q '"highVolumeRequests":1500' "$tmp_dir/node-undici-high-load.stdout.json"
grep -q '"flushedSpans":1000' "$tmp_dir/node-undici-high-load.stdout.json"
grep -q '"droppedSpans":500' "$tmp_dir/node-undici-high-load.stdout.json"
grep -q '"retryAttempts":2' "$tmp_dir/node-undici-high-load.stdout.json"
grep -q '"shutdownStatus":202' "$tmp_dir/node-undici-high-load.stdout.json"

echo "node undici high-load fake-intake smoke passed with $(node --version)"
