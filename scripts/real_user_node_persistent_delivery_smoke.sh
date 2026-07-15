#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sdk_package_version="$(node -p "require('${repo_root}/js/logbrew-js/package.json').version")"
node_package_version="$(node -p "require('${repo_root}/js/logbrew-node/package.json').version")"
tmp_dir="$(mktemp -d)"
export npm_config_cache="$tmp_dir/npm-cache"
trap 'rm -rf "$tmp_dir"' EXIT

core_pack_json="$tmp_dir/core-pack.json"
node_pack_json="$tmp_dir/node-pack.json"
(cd "$repo_root/js/logbrew-js" && npm pack --json --pack-destination "$tmp_dir") > "$core_pack_json"
(cd "$repo_root/js/logbrew-node" && npm pack --json --pack-destination "$tmp_dir") > "$node_pack_json"

core_tgz="$(python3 - "$core_pack_json" <<'PY'
import json
import sys
from pathlib import Path

print(json.loads(Path(sys.argv[1]).read_text())[0]["filename"])
PY
)"
node_tgz="$(python3 - "$node_pack_json" <<'PY'
import json
import sys
from pathlib import Path

print(json.loads(Path(sys.argv[1]).read_text())[0]["filename"])
PY
)"
core_tgz="$tmp_dir/$core_tgz"
node_tgz="$tmp_dir/$node_tgz"
test -f "$core_tgz"
test -f "$node_tgz"

tar -tzf "$node_tgz" > "$tmp_dir/node-files.txt"
grep -q '^package/persistent-event-store.cjs$' "$tmp_dir/node-files.txt"
grep -q '^package/persistent-event-store.js$' "$tmp_dir/node-files.txt"
grep -q '^package/index.d.ts$' "$tmp_dir/node-files.txt"
grep -q '^package/index.d.cts$' "$tmp_dir/node-files.txt"
grep -q '^package/examples/persistent-delivery.mjs$' "$tmp_dir/node-files.txt"
tar -xOf "$node_tgz" package/index.d.ts > "$tmp_dir/node-types.d.ts"
tar -xOf "$core_tgz" package/index.d.ts > "$tmp_dir/core-types.d.ts"
grep -q 'persistentQueue?: LogBrewNodePersistentQueueConfig' "$tmp_dir/node-types.d.ts"
grep -q 'eventStore?: EventStore' "$tmp_dir/core-types.d.ts"

app_dir="$tmp_dir/app"
mkdir -p "$app_dir"
cd "$app_dir"
npm init -y >/dev/null
npm pkg set type=module >/dev/null
npm install --save-exact --no-audit --fund=false "$core_tgz" "$node_tgz" >/dev/null
npm ls @logbrew/sdk @logbrew/node >/dev/null
npm --prefix node_modules/@logbrew/node test >/dev/null

cat > worker.mjs <<'EOF'
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { once } from "node:events";
import { createLogBrewNodeClient, createNodeFetchTransport } from "@logbrew/node";

const mode = process.env.SMOKE_MODE;
const queueDirectory = process.env.SMOKE_QUEUE_DIRECTORY;
const key = fs.readFileSync(process.env.SMOKE_KEY_FILE);
const resultFile = process.env.SMOKE_RESULT_FILE;
const apiKey = "LOGBREW_SERVER_API_KEY";
const warningCodes = [];
const drops = [];

if (mode === "a") {
  const client = makeClient();
  captureRange(client, 0, 900);
  assertEqual(client.pendingEvents(), 900, "process A pending events");
  process.exit(0);
}

if (mode === "b") {
  const client = makeClient();
  assertEqual(client.pendingEvents(), 900, "process B recovered events");
  const requests = [];
  const firstRequestStarted = deferred();
  const releaseFirstResponse = deferred();
  const server = http.createServer((request, response) => {
    collectRequest(request).then((body) => {
      requests.push(body);
      if (requests.length === 1) {
        firstRequestStarted.resolve();
        void releaseFirstResponse.promise.then(() => {
          response.statusCode = 202;
          response.end("accepted");
        });
        return;
      }
      response.statusCode = 503;
      response.end("retry");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const transport = createNodeFetchTransport({
    endpoint: `http://127.0.0.1:${server.address().port}/v1/events`
  });
  const flush = client.flush(transport);
  await firstRequestStarted.promise;
  captureRange(client, 900, 600);
  assertEqual(client.pendingEvents(), 1000, "process B bounded queue during in-flight send");
  assertEqual(client.droppedEvents(), 500, "process B dropped events");
  releaseFirstResponse.resolve();
  await assertRejects(flush, "process B flush");
  assertEqual(client.pendingEvents(), 900, "process B accepted-prefix remainder");
  await assertRejects(client.shutdown(transport), "process B shutdown");
  assertEqual(requests.length, 3, "process B request count");
  assertEqual(requests[1], requests[2], "process B failed shutdown body");
  fs.writeFileSync(resultFile, JSON.stringify({
    acceptedIds: JSON.parse(requests[0]).events.map((event) => event.id),
    drops: drops.length,
    failedBodyHash: digest(requests[1]),
    pending: client.pendingEvents(),
    requestCount: requests.length,
    warnings: warningCodes
  }));
  server.close();
  await once(server, "close");
  process.exit(0);
}

if (mode === "c") {
  const client = makeClient();
  assertEqual(client.pendingEvents(), 900, "process C recovered events");
  const requests = [];
  const acceptedBodies = [];
  const server = http.createServer((request, response) => {
    collectRequest(request).then((body) => {
      requests.push(body);
      response.statusCode = requests.length === 1 ? 503 : 202;
      if (response.statusCode === 202) {
        acceptedBodies.push(body);
      }
      response.end(response.statusCode === 202 ? "accepted" : "retry");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const transport = createNodeFetchTransport({
    endpoint: `http://127.0.0.1:${server.address().port}/v1/events`
  });
  const response = await client.shutdown(transport);
  server.close();
  await once(server, "close");
  assertEqual(response.statusCode, 202, "process C shutdown status");
  assertEqual(response.batches, 9, "process C accepted batches");
  assertEqual(requests.length, 10, "process C request count");
  assertEqual(requests[0], requests[1], "process C stable retry body");
  fs.writeFileSync(resultFile, JSON.stringify({
    acceptedIds: acceptedBodies.flatMap((body) => JSON.parse(body).events.map((event) => event.id)),
    firstBodyHash: digest(requests[0]),
    pending: client.pendingEvents(),
    requestCount: requests.length,
    warnings: warningCodes
  }));
  process.exit(0);
}

throw new Error("unknown smoke mode");

function makeClient() {
  return createLogBrewNodeClient({
    automaticDelivery: false,
    serverApiKey: apiKey,
    maxBatchEvents: 100,
    maxRetries: mode === "c" ? 1 : 0,
    maxQueueSize: 1000,
    onEventDropped(drop) {
      drops.push(drop);
    },
    persistentQueue: {
      directory: queueDirectory,
      encryptionKey: key,
      onWarning(warning) {
        warningCodes.push(warning.code);
      }
    },
    sdkName: "node-persistent-smoke",
    sdkVersion: "0.1.0"
  });
}

function captureRange(client, start, count) {
  for (let index = start; index < start + count; index += 1) {
    client.log(`evt_node_persistent_${String(index).padStart(4, "0")}`, timestamp(index), {
      level: "info",
      logger: "checkout.delivery",
      message: "delivery heartbeat",
      metadata: { sequence: index }
    });
  }
}

function timestamp(index) {
  return new Date(Date.UTC(2026, 6, 14, 10, 0, 0, index)).toISOString();
}

function deferred() {
  let resolve;
  const promise = new Promise((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function collectRequest(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, received ${actual}`);
  }
}

async function assertRejects(promise, label) {
  try {
    await promise;
  } catch {
    return;
  }
  throw new Error(`${label}: expected rejection`);
}
EOF

cat > driver.mjs <<'EOF'
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = fs.realpathSync(process.env.SMOKE_ROOT);
const queueDirectory = path.join(root, "queue");
const keyFile = path.join(root, "queue.key");
const resultB = path.join(root, "result-b.json");
const resultC = path.join(root, "result-c.json");
const key = crypto.randomBytes(32);
fs.writeFileSync(keyFile, key, { mode: 0o600 });

run("a", path.join(root, "result-a.json"));
assertPrivateCiphertext(queueDirectory, key);
run("b", resultB);
assertPrivateCiphertext(queueDirectory, key);
run("c", resultC);

const b = JSON.parse(fs.readFileSync(resultB, "utf8"));
const c = JSON.parse(fs.readFileSync(resultC, "utf8"));
assertEqual(b.drops, 500, "drop count");
assertEqual(b.pending, 900, "failed-shutdown remainder");
assertEqual(c.pending, 0, "final queue");
assertEqual(b.requestCount, 3, "process B requests");
assertEqual(c.requestCount, 10, "process C requests");
assertEqual(b.failedBodyHash, c.firstBodyHash, "cross-process stable body");
assertEqual(b.warnings.includes("stale_lock_recovered"), true, "process B stale lock warning");
assertEqual(c.warnings.includes("stale_lock_recovered"), true, "process C stale lock warning");

const acceptedIds = [...b.acceptedIds, ...c.acceptedIds];
assertEqual(acceptedIds.length, 1000, "accepted event count");
assertEqual(new Set(acceptedIds).size, 1000, "unique accepted event count");
assertEqual(b.acceptedIds[0], "evt_node_persistent_0000", "first accepted id");
assertEqual(c.acceptedIds[0], "evt_node_persistent_0100", "first recovered id");
assertEqual(c.acceptedIds.at(-1), "evt_node_persistent_0999", "last recovered id");

const queueEntries = fs.readdirSync(queueDirectory);
assertEqual(queueEntries.some((entry) => entry.endsWith(".lbq")), false, "drained event files");
assertEqual(queueEntries.includes(".lock"), false, "released owner lock");

console.log(JSON.stringify({
  acceptedBatches: 10,
  acceptedEvents: acceptedIds.length,
  droppedEvents: b.drops,
  encryptedAtRest: true,
  failedShutdownRecovered: true,
  stableReplay: true
}));

function run(mode, resultFile) {
  const result = spawnSync(process.execPath, ["worker.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      SMOKE_KEY_FILE: keyFile,
      SMOKE_MODE: mode,
      SMOKE_QUEUE_DIRECTORY: queueDirectory,
      SMOKE_RESULT_FILE: resultFile
    }
  });
  if (result.status !== 0) {
    throw new Error(`worker ${mode} failed`);
  }
}

function assertPrivateCiphertext(directory, encryptionKey) {
  const files = fs.readdirSync(directory, { recursive: true })
    .map((entry) => path.join(directory, entry))
    .filter((entry) => fs.lstatSync(entry).isFile());
  const content = Buffer.concat(files.map((file) => fs.readFileSync(file)));
  for (const forbidden of [
    "evt_node_persistent_",
    "delivery heartbeat",
    "LOGBREW_SERVER_API_KEY",
    "127.0.0.1",
    process.cwd(),
    encryptionKey.toString("base64")
  ]) {
    if (content.includes(Buffer.from(forbidden))) {
      throw new Error("persistent queue leaked forbidden plaintext");
    }
  }
  for (const file of files) {
    const stat = fs.lstatSync(file);
    assertEqual(stat.mode & 0o777, 0o600, "private queue file mode");
    assertEqual(stat.nlink, 1, "single-linked queue file");
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, received ${actual}`);
  }
}
EOF

cat > cjs-smoke.cjs <<'EOF'
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { RecordingTransport } = require("@logbrew/sdk");
const { createLogBrewNodeClient } = require("@logbrew/node");

void (async () => {
  const root = fs.realpathSync(process.env.SMOKE_ROOT);
  const client = createLogBrewNodeClient({
    automaticDelivery: false,
    serverApiKey: "LOGBREW_SERVER_API_KEY",
    persistentQueue: {
      directory: path.join(root, "cjs-queue"),
      encryptionKey: crypto.randomBytes(32)
    }
  });
  client.log("evt_cjs_persistent_001", "2026-07-14T10:00:00Z", {
    level: "info",
    message: "CommonJS persistent delivery"
  });
  const response = await client.shutdown(RecordingTransport.alwaysAccept());
  if (response.statusCode !== 202 || client.pendingEvents() !== 0) {
    throw new Error("CommonJS persistent delivery failed");
  }
})();
EOF

mkdir -p "$tmp_dir/runtime"
SMOKE_ROOT="$tmp_dir/runtime" node cjs-smoke.cjs
SMOKE_ROOT="$tmp_dir/runtime" node driver.mjs > "$tmp_dir/result.json"

python3 - "$tmp_dir/result.json" "$sdk_package_version" "$node_package_version" <<'PY'
import json
import sys
from pathlib import Path

result = json.loads(Path(sys.argv[1]).read_text())
expected = {
    "acceptedBatches": 10,
    "acceptedEvents": 1000,
    "droppedEvents": 500,
    "encryptedAtRest": True,
    "failedShutdownRecovered": True,
    "stableReplay": True,
}
if result != expected:
    raise SystemExit(f"unexpected installed persistent delivery result: {result}")
print(json.dumps({
    "accepted_batches": result["acceptedBatches"],
    "accepted_events": result["acceptedEvents"],
    "core_version": sys.argv[2],
    "dropped_events": result["droppedEvents"],
    "encrypted_at_rest": result["encryptedAtRest"],
    "failed_shutdown_recovered": result["failedShutdownRecovered"],
    "node_version": sys.argv[3],
    "stable_replay": result["stableReplay"],
}, sort_keys=True))
PY
