#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sdk_package_version="$(node -p "require('${repo_root}/js/logbrew-js/package.json').version")"
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

app_dir="$tmp_dir/js-high-load-app"
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
grep -q '@logbrew/node@0.1.0' "$tmp_dir/npm-list-depth0.txt"
test -f node_modules/@logbrew/sdk/index.js
test -f node_modules/@logbrew/node/index.js

cat > smoke.mjs <<'EOF'
import http from "node:http";
import { once } from "node:events";
import { LogBrewClient, SdkError } from "@logbrew/sdk";
import { createNodeFetchTransport } from "@logbrew/node";

const highVolumeLogs = 1500;
const maxQueueSize = 1000;
const serverApiKey = "LOGBREW_SERVER_API_KEY";
const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const drops = [];
const intakeRequests = [];
const client = LogBrewClient.create({
  apiKey: serverApiKey,
  maxRetries: 1,
  maxQueueSize,
  sdkName: "js-high-load-smoke",
  sdkVersion: "0.1.0",
  onEventDropped(drop) {
    drops.push(drop);
  }
});

for (let index = 0; index < highVolumeLogs; index += 1) {
  client.log(`evt_js_high_load_${index.toString().padStart(4, "0")}`, timestamp(index), {
    level: index % 10 === 0 ? "warning" : "info",
    logger: "checkout.high-load",
    message: "checkout queue heartbeat",
    metadata: {
      environment: "production",
      release: "checkout@1.2.3",
      sequence: index,
      traceId
    }
  });
}

assertEqual(client.pendingEvents(), maxQueueSize, "bounded queue size");
assertEqual(client.droppedEvents(), highVolumeLogs - maxQueueSize, "dropped event count");
assertEqual(drops.length, highVolumeLogs - maxQueueSize, "drop callback count");
assertEqual(drops[0].eventId, "evt_js_high_load_1000", "first dropped event id");
assertEqual(drops[0].reason, "queue_overflow", "drop reason");

const advisoryClient = LogBrewClient.create({
  apiKey: serverApiKey,
  maxQueueSize: 1,
  sdkName: "js-high-load-advisory-drop-smoke",
  sdkVersion: "0.1.0",
  onEventDropped() {
    throw new Error("drop callback must not interrupt logging");
  }
});
advisoryClient.log("evt_js_advisory_001", timestamp(2000), {
  level: "info",
  logger: "checkout.high-load",
  message: "queued"
});
advisoryClient.log("evt_js_advisory_002", timestamp(2001), {
  level: "info",
  logger: "checkout.high-load",
  message: "dropped"
});
assertEqual(advisoryClient.pendingEvents(), 1, "advisory client queue size");
assertEqual(advisoryClient.droppedEvents(), 1, "advisory client drops");

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
    "x-logbrew-source": "js-high-load-smoke"
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
  assertEqual(request.source, "js-high-load-smoke", "source header");
  assertEqual(request.url, "/v1/events", "request path");
  assertNoUnsafeContent(request.body);
}
const payload = JSON.parse(intakeRequests.at(-1).body);
assertEqual(payload.sdk.name, "js-high-load-smoke", "sdk name");
assertEqual(payload.events.length, maxQueueSize, "flushed event count");
assertEqual(payload.events[0].id, "evt_js_high_load_0000", "first flushed id");
assertEqual(payload.events.at(-1).id, "evt_js_high_load_0999", "last flushed id");
assertEqual(payload.events[0].attributes.metadata.traceId, traceId, "trace metadata");
assertEqual(payload.events[10].attributes.level, "warning", "canonical warning level");
if (payload.events.some((event) => event.id === "evt_js_high_load_1000")) {
  throw new Error("dropped event leaked into flushed payload");
}

const shutdownClient = LogBrewClient.create({
  apiKey: serverApiKey,
  sdkName: "js-high-load-shutdown-smoke",
  sdkVersion: "0.1.0"
});
shutdownClient.log("evt_js_shutdown_001", timestamp(3000), {
  level: "info",
  logger: "checkout.high-load",
  message: "shutdown flush"
});
const shutdownResponse = await shutdownClient.shutdown({
  async send() {
    return { statusCode: 202, attempts: 1 };
  }
});
assertEqual(shutdownResponse.statusCode, 202, "shutdown status");
const shutdownError = await captureError(() => Promise.resolve().then(() => {
  shutdownClient.log("evt_js_shutdown_after_001", timestamp(3001), {
    level: "info",
    logger: "checkout.high-load",
    message: "after shutdown"
  });
}));
if (!(shutdownError instanceof SdkError)) {
  throw new Error(`expected SdkError after shutdown, got ${shutdownError}`);
}
assertEqual(shutdownError.code, "shutdown_error", "post-shutdown error code");

console.log(JSON.stringify({
  ok: true,
  droppedEvents: client.droppedEvents(),
  flushedEvents: payload.events.length,
  highVolumeLogs,
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

function assertNoUnsafeContent(text) {
  for (const unsafe of [
    "LOGBREW_SERVER_API_KEY",
    "dev@example.test",
    "coupon=summer",
    "#fragment",
    "authorization"
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
    "droppedEvents": 500,
    "flushedEvents": 1000,
    "highVolumeLogs": 1500,
    "pendingEvents": 0,
    "retryAttempts": 2,
    "shutdownStatus": 202,
}
for key, value in expected.items():
    if summary.get(key) != value:
        raise SystemExit(f"unexpected {key}: {summary!r}")
PY

echo "javascript high-load installed-artifact smoke passed: 1500 logs, 1000 flushed, 500 dropped, retryAttempts=2"
