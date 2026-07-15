#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
core_version="$(node -p "require('${repo_root}/js/logbrew-js/package.json').version")"
node_version="$(node -p "require('${repo_root}/js/logbrew-node/package.json').version")"
tmp_dir="$(mktemp -d)"
export npm_config_cache="$tmp_dir/npm-cache"
trap 'rm -rf "$tmp_dir"' EXIT

(cd "$repo_root/js/logbrew-js" && npm pack --json --pack-destination "$tmp_dir") > "$tmp_dir/core-pack.json"
(cd "$repo_root/js/logbrew-node" && npm pack --json --pack-destination "$tmp_dir") > "$tmp_dir/node-pack.json"

pack_filename() {
  python3 - "$1" <<'PY'
import json
import sys
from pathlib import Path

print(json.loads(Path(sys.argv[1]).read_text())[0]["filename"])
PY
}

core_tgz="$tmp_dir/$(pack_filename "$tmp_dir/core-pack.json")"
node_tgz="$tmp_dir/$(pack_filename "$tmp_dir/node-pack.json")"
core_digest="$(shasum -a 256 "$core_tgz" | awk '{print $1}')"
node_digest="$(shasum -a 256 "$node_tgz" | awk '{print $1}')"

tar -xOf "$core_tgz" package/index.d.ts > "$tmp_dir/core-types.d.ts"
tar -xOf "$node_tgz" package/index.d.ts > "$tmp_dir/node-types.d.ts"
grep -q 'deliveryHealth(): DeliveryHealthSnapshot' "$tmp_dir/core-types.d.ts"
grep -q 'automaticDelivery?: boolean' "$tmp_dir/core-types.d.ts"
grep -q 'pausedReason: "none" | "authentication" | "rate_limit" | "non_retryable"' "$tmp_dir/core-types.d.ts"
grep -q 'retryDelayMs: number' "$tmp_dir/core-types.d.ts"
grep -q 'automaticDelivery?: boolean' "$tmp_dir/node-types.d.ts"

app_dir="$tmp_dir/app"
mkdir -p "$app_dir"
cd "$app_dir"
npm init -y >/dev/null
npm pkg set type=module >/dev/null
npm install --save-exact --no-audit --fund=false \
  "$core_tgz" \
  "$node_tgz" \
  @types/node@22.18.0 \
  typescript@6.0.3 \
  >/dev/null
npm ls @logbrew/sdk @logbrew/node >/dev/null

cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "noEmit": true,
    "strict": true,
    "target": "ES2022",
    "types": ["node"]
  },
  "include": ["type-proof.ts", "type-proof.cts"]
}
EOF

cat > type-proof.ts <<'EOF'
import { LogBrewClient, RecordingTransport, type DeliveryHealthSnapshot } from "@logbrew/sdk";
import { createLogBrewNodeClient } from "@logbrew/node";

const transport = RecordingTransport.alwaysAccept();
const core = LogBrewClient.create({
  apiKey: "LOGBREW_API_KEY",
  automaticDelivery: true,
  deliveryIntervalMs: 5000,
  deliveryQueueThreshold: 50,
  sdkName: "type-proof",
  sdkVersion: "0.1.0",
  transport
});
const health: DeliveryHealthSnapshot = core.deliveryHealth();
void health.lifecycle;
void health.pausedReason;
void health.retryDelayMs;
void core.flush();

const node = createLogBrewNodeClient({
  automaticDelivery: false,
  deliveryIntervalMs: 5000,
  deliveryQueueThreshold: 50,
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  transport
});
void node.shutdown();
EOF

cat > type-proof.cts <<'EOF'
import sdk = require("@logbrew/sdk");
import nodeSdk = require("@logbrew/node");

const transport = sdk.RecordingTransport.alwaysAccept();
const client = nodeSdk.createLogBrewNodeClient({
  automaticDelivery: true,
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  transport
});
const health: sdk.DeliveryHealthSnapshot = client.deliveryHealth();
void health.automaticDelivery;
void health.pausedReason;
void health.retryDelayMs;
void client.shutdown();
EOF

./node_modules/.bin/tsc --project tsconfig.json

cat > esm-proof.mjs <<'EOF'
import http from "node:http";
import { once } from "node:events";
import { createLogBrewNodeClient, createNodeFetchTransport } from "@logbrew/node";

const requests = [];
const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  requests.push({
    authorization: request.headers.authorization,
    body: Buffer.concat(chunks).toString("utf8"),
    contentType: request.headers["content-type"],
    method: request.method,
    path: request.url
  });
  const pathRequests = requests.filter((entry) => entry.path === request.url).length;
  if (request.url === "/v1/events") {
    response.statusCode = pathRequests === 1 ? 503 : 202;
  } else if (request.url === "/v1/direct-rate-limit" || request.url === "/v1/automatic-rate-limit") {
    response.statusCode = 429;
    response.setHeader("retry-after", "2");
  } else {
    response.statusCode = 404;
  }
  response.end();
});
server.listen(0, "127.0.0.1");
await once(server, "listening");

const client = createLogBrewNodeClient({
  deliveryIntervalMs: 20,
  deliveryQueueThreshold: 10,
  endpoint: `http://127.0.0.1:${server.address().port}/v1/events`,
  maxRetries: 1,
  sdkName: "installed-auto-esm",
  sdkVersion: "0.1.0",
  serverApiKey: "LOGBREW_SERVER_API_KEY"
});
client.log("evt_auto_esm_001", "2026-07-15T10:00:00Z", {
  level: "info",
  message: "automatic installed delivery"
});

await waitFor(() => client.pendingEvents() === 0 && requests.length === 2);
const activeHealth = client.deliveryHealth();
assertExactKeys(activeHealth, [
  "attempts",
  "automaticDelivery",
  "batches",
  "coalesced",
  "consecutiveFailures",
  "droppedEvents",
  "failures",
  "flushes",
  "inFlight",
  "lastOutcome",
  "lifecycle",
  "pausedReason",
  "queueBytes",
  "queueEvents",
  "retryDelayMs",
  "scheduled"
]);
assert(activeHealth.automaticDelivery === true, "automatic delivery disabled");
assert(activeHealth.lastOutcome === "accepted", "automatic outcome not accepted");
assert(activeHealth.attempts === 2 && activeHealth.batches === 1, "automatic counters mismatch");
assert(activeHealth.flushes === 1 && activeHealth.failures === 0, "automatic flush counters mismatch");
assert(requests[0].body === requests[1].body, "retry body changed");
for (const request of requests) {
  assert(request.method === "POST", "wrong request method");
  assert(request.path === "/v1/events", "wrong request path");
  assert(request.authorization === "Bearer LOGBREW_SERVER_API_KEY", "wrong authorization");
  assert(request.contentType === "application/json", "wrong content type");
}
assert(JSON.parse(requests[0].body).events[0].id === "evt_auto_esm_001", "wrong event body");

const shutdown = await client.shutdown();
assert(shutdown.statusCode === 204 && shutdown.attempts === 0, "shutdown did extra I/O");
assert(client.deliveryHealth().lifecycle === "closed", "client did not close");

const directRateLimit = createNodeFetchTransport({
  endpoint: `http://127.0.0.1:${server.address().port}/v1/direct-rate-limit`
});
const directRateLimitResponse = await directRateLimit.send("LOGBREW_SERVER_API_KEY", '{"events":[]}');
assert(directRateLimitResponse.statusCode === 429, "direct rate-limit status changed");
assert(directRateLimitResponse.retryAfterMs === 2000, "Node transport did not preserve Retry-After");

const rateLimitedClient = createLogBrewNodeClient({
  deliveryIntervalMs: 20,
  deliveryQueueThreshold: 1,
  endpoint: `http://127.0.0.1:${server.address().port}/v1/automatic-rate-limit`,
  maxRetries: 0,
  sdkName: "installed-auto-rate-limit",
  sdkVersion: "0.1.0",
  serverApiKey: "LOGBREW_SERVER_API_KEY"
});
rateLimitedClient.log("evt_auto_rate_limit_001", "2026-07-15T10:00:02Z", {
  level: "warning",
  message: "automatic rate limit"
});
await waitFor(() => rateLimitedClient.deliveryHealth().pausedReason === "rate_limit");
await new Promise((resolve) => setTimeout(resolve, 75));
const automaticRateLimitRequests = requests.filter((request) => request.path === "/v1/automatic-rate-limit");
assert(automaticRateLimitRequests.length === 1, "automatic rate limit entered a retry loop");
assert(rateLimitedClient.pendingEvents() === 1, "rate-limited event was not retained");
assert(rateLimitedClient.deliveryHealth().scheduled === false, "rate-limited delivery remained scheduled");
assert(rateLimitedClient.deliveryHealth().retryDelayMs === 0, "rate limit exposed a misleading retry delay");
const rateLimitHealthJson = JSON.stringify(rateLimitedClient.deliveryHealth());
for (const forbidden of ["LOGBREW_SERVER_API_KEY", "evt_auto_rate_limit_001", "automatic rate limit", "127.0.0.1", "/v1/automatic-rate-limit", "429"]) {
  assert(!rateLimitHealthJson.includes(forbidden), "rate-limit health leaked private delivery input");
}
rateLimitedClient.purgePendingEvents();
await rateLimitedClient.shutdown();

server.close();
await once(server, "close");

const healthJson = JSON.stringify(client.deliveryHealth());
for (const forbidden of ["LOGBREW_SERVER_API_KEY", "evt_auto_esm_001", "automatic installed delivery", "127.0.0.1", "/v1/events"]) {
  assert(!healthJson.includes(forbidden), "health leaked private delivery input");
}
console.log(JSON.stringify({
  attempts: requests.filter((request) => request.path === "/v1/events").length,
  rateLimitRequests: automaticRateLimitRequests.length,
  retryAfterMs: directRateLimitResponse.retryAfterMs,
  stableRetry: requests[0].body === requests[1].body
}));

async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("automatic delivery timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

function assertExactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  assert(JSON.stringify(actual) === JSON.stringify(expected), "unexpected health fields");
}
EOF

cat > cjs-proof.cjs <<'EOF'
"use strict";

const { RecordingTransport } = require("@logbrew/sdk");
const { createLogBrewNodeClient } = require("@logbrew/node");

void (async () => {
  const transport = RecordingTransport.alwaysAccept();
  const client = createLogBrewNodeClient({
    deliveryIntervalMs: 60000,
    deliveryQueueThreshold: 1,
    sdkName: "installed-auto-cjs",
    sdkVersion: "0.1.0",
    serverApiKey: "LOGBREW_SERVER_API_KEY",
    transport
  });
  client.log("evt_auto_cjs_001", "2026-07-15T10:00:01Z", {
    level: "info",
    message: "CommonJS automatic delivery"
  });
  await waitFor(() => client.pendingEvents() === 0);
  if (transport.sentBodies.length !== 1 || client.deliveryHealth().lastOutcome !== "accepted") {
    throw new Error("CommonJS automatic delivery failed");
  }
  await client.shutdown();
  console.log(JSON.stringify({ accepted: 1, lifecycle: client.deliveryHealth().lifecycle }));
})();

async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("CommonJS automatic delivery timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
EOF

node esm-proof.mjs > "$tmp_dir/esm-result.json"
node cjs-proof.cjs > "$tmp_dir/cjs-result.json"

python3 - "$tmp_dir/esm-result.json" "$tmp_dir/cjs-result.json" <<'PY'
import json
import sys
from pathlib import Path

esm = json.loads(Path(sys.argv[1]).read_text())
cjs = json.loads(Path(sys.argv[2]).read_text())
if esm != {"attempts": 2, "rateLimitRequests": 1, "retryAfterMs": 2000, "stableRetry": True}:
    raise SystemExit(f"unexpected ESM proof: {esm}")
if cjs != {"accepted": 1, "lifecycle": "closed"}:
    raise SystemExit(f"unexpected CommonJS proof: {cjs}")
PY

printf '{"automatic_attempts":2,"cjs_accepted":1,"core_digest":"%s","core_version":"%s","node_digest":"%s","node_version":"%s","rate_limit_requests":1,"retry_after_ms":2000,"stable_retry":true}\n' \
  "$core_digest" "$core_version" "$node_digest" "$node_version"
