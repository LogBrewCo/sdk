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

app_dir="$tmp_dir/node-queue-high-load-app"
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

cat > smoke.mjs <<'EOF'
import http from "node:http";
import { once } from "node:events";
import { LogBrewClient, SdkError } from "@logbrew/sdk";
import {
  createNodeFetchTransport,
  queueBatchOperationWithLogBrewSpan
} from "@logbrew/node";

const highVolumeQueueSpans = 1500;
const maxQueueSize = 1000;
const serverApiKey = "LOGBREW_SERVER_API_KEY";
const drops = [];
const intakeRequests = [];
const client = LogBrewClient.create({
  apiKey: serverApiKey,
  maxRetries: 1,
  maxQueueSize,
  sdkName: "node-queue-high-load-smoke",
  sdkVersion: "0.1.0",
  onEventDropped(drop) {
    drops.push(drop);
  }
});

for (let index = 0; index < highVolumeQueueSpans; index += 1) {
  const traceId = hexId(index + 1, 32);
  const spanId = hexId(index + 1, 16);
  const upstreamSpanId = hexId(index + 2, 16);
  const peerTraceId = hexId(index + 2001, 32);
  const peerSpanId = hexId(index + 2001, 16);
  const result = await queueBatchOperationWithLogBrewSpan("email.high_load_batch", {
    client,
    id: `evt_node_queue_high_load_${index.toString().padStart(4, "0")}`,
    linkMetadata: {
      body: "hello dev@example.test",
      payload: `private-payload-${index}`,
      relation: "batch_item"
    },
    messages: [
      { headers: { traceparent: `00-${traceId}-${upstreamSpanId}-01` }, payload: `private-payload-${index}` },
      { headers: { traceparent: "not-a-traceparent" }, payload: "malformed" },
      { headers: { traceparent: Buffer.from(`00-${peerTraceId}-${peerSpanId}-00`) }, body: "hello dev@example.test" }
    ],
    now: () => timestamp(index),
    nowMs: () => index,
    operation: async () => "processed",
    operationKind: "process",
    queueName: "email",
    spanIdFactory: () => spanId,
    system: "amqp",
    traceIdFactory: () => traceId
  });
  assertEqual(result, "processed", "queue helper must preserve app result");
}

assertEqual(client.pendingEvents(), maxQueueSize, "bounded queue size");
assertEqual(client.droppedEvents(), highVolumeQueueSpans - maxQueueSize, "dropped event count");
assertEqual(drops.length, highVolumeQueueSpans - maxQueueSize, "drop callback count");
assertEqual(drops[0].eventId, "evt_node_queue_high_load_1000", "first dropped event id");
assertEqual(drops[0].eventType, "span", "first dropped event type");
assertEqual(drops[0].reason, "queue_overflow", "drop reason");

const advisoryClient = LogBrewClient.create({
  apiKey: serverApiKey,
  maxQueueSize: 1,
  sdkName: "node-queue-high-load-advisory-drop-smoke",
  sdkVersion: "0.1.0",
  onEventDropped() {
    throw new Error("drop callback must not interrupt queue processing");
  }
});
await queueBatchOperationWithLogBrewSpan("email.advisory_drop", {
  client: advisoryClient,
  id: "evt_node_queue_advisory_001",
  messages: [{ headers: { traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01" } }],
  operation: async () => "queued",
  queueName: "email",
  spanIdFactory: () => "1111111111111111",
  traceIdFactory: () => "11111111111111111111111111111111"
});
await queueBatchOperationWithLogBrewSpan("email.advisory_drop", {
  client: advisoryClient,
  id: "evt_node_queue_advisory_002",
  messages: [{ headers: { traceparent: "00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01" } }],
  operation: async () => "dropped",
  queueName: "email",
  spanIdFactory: () => "2222222222222222",
  traceIdFactory: () => "22222222222222222222222222222222"
});
assertEqual(advisoryClient.pendingEvents(), 1, "advisory queue size");
assertEqual(advisoryClient.droppedEvents(), 1, "advisory drops");

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
    "x-logbrew-source": "node-queue-high-load-smoke"
  }
}));
await closeServer(intakeServer);

assertEqual(response.statusCode, 202, "flush status");
assertEqual(response.attempts, 11, "retryAttempts");
assertEqual(intakeRequests.length, 11, "bounded batch request count");
assertEqual(intakeRequests[1].body, intakeRequests[0].body, "first batch retry body identity");
assertEqual(client.pendingEvents(), 0, "queue after successful flush");
for (const request of intakeRequests) {
  assertEqual(request.authorization, `Bearer ${serverApiKey}`, "authorization header");
  assertEqual(request.contentType, "application/json", "content type");
  assertEqual(request.method, "POST", "request method");
  assertEqual(request.source, "node-queue-high-load-smoke", "source header");
  assertEqual(request.url, "/v1/events", "request path");
  assertNoUnsafeContent(request.body);
}

const requestPayloads = intakeRequests.map((request) => JSON.parse(request.body));
const acceptedPayloads = requestPayloads.slice(1);
assertEqual(acceptedPayloads.length, 10, "accepted bounded batch count");
for (const payload of requestPayloads) {
  assertEqual(payload.sdk.name, "node-queue-high-load-smoke", "sdk name");
  assertEqual(payload.events.length, 100, "bounded batch event count");
}

const acceptedEvents = acceptedPayloads.flatMap((payload) => payload.events);
assertEqual(acceptedEvents.length, maxQueueSize, "flushed event count");
for (let index = 0; index < acceptedEvents.length; index += 1) {
  assertEqual(
    acceptedEvents[index].id,
    `evt_node_queue_high_load_${index.toString().padStart(4, "0")}`,
    `accepted event order ${index}`
  );
}
assertEqual(acceptedEvents[0].type, "span", "first event type");
if (acceptedEvents.some((event) => event.id === "evt_node_queue_high_load_1000")) {
  throw new Error("dropped queue span leaked into flushed payload");
}
const firstSpan = acceptedEvents[0].attributes;
assertEqual(firstSpan.name, "amqp process email.high_load_batch", "span name");
assertEqual(firstSpan.status, "ok", "span status");
assertEqual(firstSpan.metadata.framework, "node:queue", "queue framework metadata");
assertEqual(firstSpan.metadata["messaging.system"], "amqp", "messaging system");
assertEqual(firstSpan.metadata["messaging.destination.name"], "email", "queue destination");
assertEqual(firstSpan.metadata["messaging.batch.message_count"], 3, "semantic message count");
assertEqual(firstSpan.metadata.messageCount, 3, "message count metadata");
assertEqual(firstSpan.links.length, 2, "safe generated queue links");
assertEqual(firstSpan.links[0].metadata.relation, "batch_item", "safe link metadata");
if (Object.prototype.hasOwnProperty.call(firstSpan.links[0].metadata, "payload")) {
  throw new Error("unsafe queue link payload metadata leaked");
}

const shutdownClient = LogBrewClient.create({
  apiKey: serverApiKey,
  sdkName: "node-queue-high-load-shutdown-smoke",
  sdkVersion: "0.1.0"
});
await queueBatchOperationWithLogBrewSpan("email.shutdown", {
  client: shutdownClient,
  id: "evt_node_queue_shutdown_001",
  messages: [{ headers: { traceparent: "00-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-ffffffffffffffff-01" } }],
  operation: async () => "shutdown",
  queueName: "email",
  spanIdFactory: () => "3333333333333333",
  traceIdFactory: () => "33333333333333333333333333333333"
});
const shutdownResponse = await shutdownClient.shutdown({
  async send() {
    return { statusCode: 202, attempts: 1 };
  }
});
assertEqual(shutdownResponse.statusCode, 202, "shutdown status");
const afterShutdownResult = await queueBatchOperationWithLogBrewSpan("email.after_shutdown", {
  client: shutdownClient,
  id: "evt_node_queue_shutdown_after_001",
  messages: [{ headers: { traceparent: "00-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-ffffffffffffffff-01" } }],
  operation: async () => "after-shutdown",
  queueName: "email",
  spanIdFactory: () => "4444444444444444",
  traceIdFactory: () => "44444444444444444444444444444444"
});
assertEqual(afterShutdownResult, "after-shutdown", "queue helper must not interrupt app result after shutdown");
assertEqual(shutdownClient.pendingEvents(), 0, "shutdown client queue after helper capture failure");
const shutdownError = await captureError(() => Promise.resolve().then(() => {
  shutdownClient.span("evt_node_direct_after_shutdown", timestamp(2000), {
    name: "amqp process email.after_shutdown",
    traceId: "55555555555555555555555555555555",
    spanId: "5555555555555555",
    status: "ok"
  });
}));
if (!(shutdownError instanceof SdkError)) {
  throw new Error(`expected SdkError after shutdown, got ${shutdownError}`);
}
assertEqual(shutdownError.code, "shutdown_error", "post-shutdown error code");

console.log(JSON.stringify({
  ok: true,
  acceptedBatches: acceptedPayloads.length,
  droppedEvents: client.droppedEvents(),
  flushedSpans: acceptedEvents.length,
  highVolumeQueueSpans,
  pendingEvents: client.pendingEvents(),
  requestCount: intakeRequests.length,
  retryAttempts: response.attempts,
  shutdownStatus: shutdownResponse.statusCode
}));

function timestamp(offset) {
  return new Date(Date.UTC(2026, 5, 25, 10, 0, offset)).toISOString();
}

function hexId(value, width) {
  return value.toString(16).padStart(width, "0");
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertNoUnsafeContent(text) {
  for (const unsafe of [
    "LOGBREW_SERVER_API_KEY",
    "dev@example.test",
    "private-payload",
    "not-a-traceparent",
    "traceparent",
    "authorization",
    "coupon=summer",
    "#fragment"
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

node smoke.mjs > "$tmp_dir/smoke-summary.json"
python3 - "$tmp_dir/smoke-summary.json" <<'PY'
import json
import sys
from pathlib import Path

summary = json.loads(Path(sys.argv[1]).read_text())
expected = {
    "ok": True,
    "acceptedBatches": 10,
    "droppedEvents": 500,
    "flushedSpans": 1000,
    "highVolumeQueueSpans": 1500,
    "pendingEvents": 0,
    "requestCount": 11,
    "retryAttempts": 11,
    "shutdownStatus": 202,
}
for key, value in expected.items():
    if summary.get(key) != value:
        raise SystemExit(f"{key}: expected {value!r}, got {summary.get(key)!r}")
PY

echo "node queue high-load fake-intake smoke passed with $(node --version)"
