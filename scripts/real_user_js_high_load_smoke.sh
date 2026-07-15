#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sdk_package_version="$(node -p "require('${repo_root}/js/logbrew-js/package.json').version")"
node_package_version="$(node -p "require('${repo_root}/js/logbrew-node/package.json').version")"
browser_package_version="$(node -p "require('${repo_root}/js/logbrew-browser/package.json').version")"
tmp_dir="$(mktemp -d)"
export npm_config_cache="$tmp_dir/npm-cache"

remove_tmp_dir() {
  rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT

core_pack_json="$tmp_dir/core-pack.json"
node_pack_json="$tmp_dir/node-pack.json"
browser_pack_json="$tmp_dir/browser-pack.json"
(cd "$repo_root/js/logbrew-js" && npm pack --json --pack-destination "$tmp_dir") > "$core_pack_json"
(cd "$repo_root/js/logbrew-node" && npm pack --json --pack-destination "$tmp_dir") > "$node_pack_json"
(cd "$repo_root/js/logbrew-browser" && npm pack --json --pack-destination "$tmp_dir") > "$browser_pack_json"

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
browser_tgz="$(python3 - "$browser_pack_json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
print(payload[0]["filename"])
PY
)"
core_tgz="$tmp_dir/$core_tgz"
node_tgz="$tmp_dir/$node_tgz"
browser_tgz="$tmp_dir/$browser_tgz"
test -f "$core_tgz"
test -f "$node_tgz"
test -f "$browser_tgz"

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
  "$browser_tgz" \
  >/dev/null

grep -q '"@logbrew/sdk": "file:' package.json
grep -q '"@logbrew/node": "file:' package.json
grep -q '"@logbrew/browser": "file:' package.json
grep -q '"@logbrew/sdk"' package-lock.json
grep -q '"@logbrew/node"' package-lock.json
grep -q '"@logbrew/browser"' package-lock.json
npm ls @logbrew/sdk @logbrew/node @logbrew/browser >/dev/null
npm list --depth=0 > "$tmp_dir/npm-list-depth0.txt"
grep -q "@logbrew/sdk@${sdk_package_version}" "$tmp_dir/npm-list-depth0.txt"
grep -q "@logbrew/node@${node_package_version}" "$tmp_dir/npm-list-depth0.txt"
grep -q "@logbrew/browser@${browser_package_version}" "$tmp_dir/npm-list-depth0.txt"
test -f node_modules/@logbrew/sdk/index.js
test -f node_modules/@logbrew/node/index.js
test -f node_modules/@logbrew/browser/index.js

cat > smoke.mjs <<'EOF'
import http from "node:http";
import { once } from "node:events";
import { createLogBrewBrowserClient } from "@logbrew/browser";
import { LogBrewClient, RecordingTransport, SdkError } from "@logbrew/sdk";
import { createLogBrewNodeClient, createNodeFetchTransport } from "@logbrew/node";

const highVolumeLogs = 1500;
const maxQueueSize = 1000;
const maxQueueBytes = 512 * 1024;
const maxBatchEvents = 100;
const maxBatchBytes = 16 * 1024;
const serverApiKey = "LOGBREW_SERVER_API_KEY";
const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const drops = [];
const intakeRequests = [];
const client = createLogBrewNodeClient({
  automaticDelivery: false,
  serverApiKey,
  maxBatchBytes,
  maxBatchEvents,
  maxRetries: 1,
  maxQueueBytes,
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
if (client.pendingBytes() <= 0 || client.pendingBytes() > maxQueueBytes) {
  throw new Error(`bounded queue bytes outside expected range: ${client.pendingBytes()}`);
}
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

const browserClient = createLogBrewBrowserClient({
  apiKey: serverApiKey,
  sdkName: "js-browser-batch-smoke",
  sdkVersion: "0.1.0"
});
browserClient.log("evt_js_browser_001", timestamp(2200), {
  level: "info",
  logger: "checkout.browser",
  message: "x".repeat(40 * 1024)
});
browserClient.log("evt_js_browser_002", timestamp(2201), {
  level: "warning",
  logger: "checkout.browser",
  message: "y".repeat(40 * 1024)
});
const browserTransport = RecordingTransport.alwaysAccept();
const browserResponse = await browserClient.flush(browserTransport);
assertEqual(browserResponse.batches, 2, "browser helper batch forwarding");
assertEqual(browserTransport.sentBodies.length, 2, "browser helper request count");
for (const body of browserTransport.sentBodies) {
  if (Buffer.byteLength(body, "utf8") > 64 * 1024) {
    throw new Error("browser helper exceeded the default keepalive byte limit");
  }
}

const firstRaceRequestStarted = deferred();
const releaseFirstRaceResponse = deferred();
let highLoadRequestCount = 0;
const intakeServer = http.createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    const source = req.headers["x-logbrew-source"];
    intakeRequests.push({
      authorization: req.headers.authorization,
      body,
      contentType: req.headers["content-type"],
      method: req.method,
      source,
      url: req.url
    });
    if (source === "js-race-smoke" && intakeRequests.filter((request) => request.source === source).length === 1) {
      firstRaceRequestStarted.resolve();
      void releaseFirstRaceResponse.promise.then(() => {
        res.statusCode = 202;
        res.end("accepted");
      });
      return;
    }
    if (source === "js-high-load-smoke") {
      highLoadRequestCount += 1;
      res.statusCode = highLoadRequestCount === 1 ? 503 : 202;
    } else {
      res.statusCode = 202;
    }
    res.end("accepted");
  });
});
intakeServer.listen(0, "127.0.0.1");
await once(intakeServer, "listening");
const intakePort = intakeServer.address().port;

const raceClient = createLogBrewNodeClient({
  automaticDelivery: false,
  serverApiKey,
  sdkName: "js-race-smoke",
  sdkVersion: "0.1.0"
});
const raceTransport = createNodeFetchTransport({
  endpoint: `http://127.0.0.1:${intakePort}/v1/events`,
  headers: {
    "x-logbrew-source": "js-race-smoke"
  }
});
raceClient.log("evt_js_before_flush", timestamp(2500), {
  level: "info",
  logger: "checkout.race",
  message: "before flush"
});
const firstRaceFlush = raceClient.flush(raceTransport);
await firstRaceRequestStarted.promise;
raceClient.log("evt_js_during_flush", timestamp(2501), {
  level: "warning",
  logger: "checkout.race",
  message: "during flush"
});
releaseFirstRaceResponse.resolve();
const firstRaceResponse = await firstRaceFlush;
assertEqual(firstRaceResponse.batches, 1, "race first batch count");
assertEqual(raceClient.pendingEvents(), 1, "race capture retained after first flush");
const secondRaceResponse = await raceClient.flush(raceTransport);
assertEqual(secondRaceResponse.batches, 1, "race second batch count");
assertEqual(raceClient.pendingEvents(), 0, "race queue after second flush");
const raceRequests = intakeRequests.filter((request) => request.source === "js-race-smoke");
assertEqual(raceRequests.length, 2, "race request count");
assertEqual(JSON.parse(raceRequests[0].body).events[0].id, "evt_js_before_flush", "race first event");
assertEqual(JSON.parse(raceRequests[1].body).events[0].id, "evt_js_during_flush", "race retained event");

const response = await client.flush(createNodeFetchTransport({
  endpoint: `http://127.0.0.1:${intakePort}/v1/events`,
  headers: {
    "x-logbrew-source": "js-high-load-smoke"
  }
}));
await closeServer(intakeServer);

assertEqual(response.statusCode, 202, "flush status");
if (response.batches < 10) {
  throw new Error(`expected at least 10 bounded batches, got ${response.batches}`);
}
assertEqual(response.attempts, response.batches + 1, "retry attempts across batches");
assertEqual(client.pendingEvents(), 0, "queue after successful flush");
assertEqual(client.pendingBytes(), 0, "queue bytes after successful flush");
for (const request of intakeRequests) {
  assertEqual(request.authorization, `Bearer ${serverApiKey}`, "authorization header");
  assertEqual(request.contentType, "application/json", "content type");
  assertEqual(request.method, "POST", "request method");
  if (request.source !== "js-high-load-smoke" && request.source !== "js-race-smoke") {
    throw new Error(`unexpected source header ${request.source}`);
  }
  assertEqual(request.url, "/v1/events", "request path");
  assertNoUnsafeContent(request.body);
}
const highLoadRequests = intakeRequests.filter((request) => request.source === "js-high-load-smoke");
assertEqual(highLoadRequests.length, response.attempts, "high-load request count");
assertEqual(highLoadRequests[0].body, highLoadRequests[1].body, "stable retry body");
const acceptedPayloads = highLoadRequests.slice(1).map((request) => JSON.parse(request.body));
assertEqual(acceptedPayloads.length, response.batches, "accepted batch count");
for (let index = 0; index < acceptedPayloads.length; index += 1) {
  const payload = acceptedPayloads[index];
  assertEqual(payload.sdk.name, "js-high-load-smoke", "sdk name");
  if (payload.events.length > maxBatchEvents) {
    throw new Error(`batch ${index} exceeded event limit: ${payload.events.length}`);
  }
  if (Buffer.byteLength(highLoadRequests[index + 1].body, "utf8") > maxBatchBytes) {
    throw new Error(`batch ${index} exceeded byte limit`);
  }
}
const flushedEvents = acceptedPayloads.flatMap((payload) => payload.events);
assertEqual(flushedEvents.length, maxQueueSize, "flushed event count");
assertEqual(flushedEvents[0].id, "evt_js_high_load_0000", "first flushed id");
assertEqual(flushedEvents.at(-1).id, "evt_js_high_load_0999", "last flushed id");
assertEqual(flushedEvents[0].attributes.metadata.traceId, traceId, "trace metadata");
assertEqual(flushedEvents[10].attributes.level, "warning", "canonical warning level");
if (flushedEvents.some((event) => event.id === "evt_js_high_load_1000")) {
  throw new Error("dropped event leaked into flushed payload");
}

const shutdownClient = LogBrewClient.create({
  apiKey: serverApiKey,
  maxRetries: 0,
  sdkName: "js-high-load-shutdown-smoke",
  sdkVersion: "0.1.0"
});
shutdownClient.log("evt_js_shutdown_001", timestamp(3000), {
  level: "info",
  logger: "checkout.high-load",
  message: "shutdown flush"
});
const failedShutdown = await captureError(() => shutdownClient.shutdown({
  async send() {
    return { statusCode: 500 };
  }
}));
if (!(failedShutdown instanceof SdkError)) {
  throw new Error(`expected SdkError after failed shutdown, got ${failedShutdown}`);
}
assertEqual(failedShutdown.code, "transport_error", "failed shutdown error code");
assertEqual(shutdownClient.pendingEvents(), 1, "failed shutdown retained queue");
shutdownClient.log("evt_js_shutdown_retry_001", timestamp(3001), {
  level: "warning",
  logger: "checkout.high-load",
  message: "shutdown retry"
});
let shutdownBody;
const shutdownResponse = await shutdownClient.shutdown({
  async send(_apiKey, body) {
    shutdownBody = body;
    return { statusCode: 202 };
  }
});
assertEqual(shutdownResponse.statusCode, 202, "shutdown status");
assertEqual(shutdownResponse.batches, 1, "shutdown batch count");
assertEqual(JSON.parse(shutdownBody).events.length, 2, "shutdown retained event count");
const shutdownError = await captureError(() => Promise.resolve().then(() => {
  shutdownClient.log("evt_js_shutdown_after_001", timestamp(3002), {
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
  batches: response.batches,
  browserBatches: browserResponse.batches,
  droppedEvents: client.droppedEvents(),
  flushedEvents: flushedEvents.length,
  highVolumeLogs,
  pendingEvents: client.pendingEvents(),
  raceRequests: raceRequests.length,
  retryAttempts: response.attempts,
  shutdownStatus: shutdownResponse.statusCode
}));

function deferred() {
  let resolve;
  const promise = new Promise((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

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
    "browserBatches": 2,
    "droppedEvents": 500,
    "flushedEvents": 1000,
    "highVolumeLogs": 1500,
    "pendingEvents": 0,
    "raceRequests": 2,
    "shutdownStatus": 202,
}
for key, value in expected.items():
    if summary.get(key) != value:
        raise SystemExit(f"unexpected {key}: {summary!r}")
if summary.get("batches", 0) < 10:
    raise SystemExit(f"expected at least 10 batches: {summary!r}")
if summary.get("retryAttempts") != summary.get("batches") + 1:
    raise SystemExit(f"unexpected retry attempts: {summary!r}")
print(
    "javascript high-load installed-artifact smoke passed: "
    f"1500 logs, 1000 flushed, 500 dropped, batches={summary['batches']}, "
    f"attempts={summary['retryAttempts']}, race_requests={summary['raceRequests']}"
)
PY
