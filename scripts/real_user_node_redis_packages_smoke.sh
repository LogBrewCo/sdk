#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sdk_package_version="$(node -p "require('${repo_root}/js/logbrew-js/package.json').version")"
node_package_version="$(node -p "require('${repo_root}/js/logbrew-node/package.json').version")"
redis_version="${LOGBREW_NODE_REDIS_PACKAGE_VERSION:-6.1.0}"
ioredis_version="${LOGBREW_NODE_IOREDIS_PACKAGE_VERSION:-5.11.1}"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

package_tgz() {
  python3 - "$1" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
print(payload[0]["filename"])
PY
}

core_pack_json="$tmp_dir/core-pack.json"
node_pack_json="$tmp_dir/node-pack.json"
(cd "$repo_root/js/logbrew-js" && npm pack --json --pack-destination "$tmp_dir") > "$core_pack_json"
(cd "$repo_root/js/logbrew-node" && npm pack --json --pack-destination "$tmp_dir") > "$node_pack_json"

core_tgz="$tmp_dir/$(package_tgz "$core_pack_json")"
node_tgz="$tmp_dir/$(package_tgz "$node_pack_json")"
test -f "$core_tgz"
test -f "$node_tgz"

app_dir="$tmp_dir/node-redis-package-smoke"
mkdir -p "$app_dir"
cd "$app_dir"
npm init -y >/dev/null
npm pkg set type=module >/dev/null
npm install \
  --save-exact \
  "$core_tgz" \
  "$node_tgz" \
  "redis@${redis_version}" \
  "ioredis@${ioredis_version}" \
  >/dev/null

grep -q '"@logbrew/sdk": "file:' package.json
grep -q '"@logbrew/node": "file:' package.json
grep -q "\"redis\": \"${redis_version}\"" package.json
grep -q "\"ioredis\": \"${ioredis_version}\"" package.json
npm ls @logbrew/sdk @logbrew/node redis ioredis >/dev/null
npm list --depth=0 > "$tmp_dir/npm-list-depth0.txt"
grep -q "@logbrew/node@${node_package_version}" "$tmp_dir/npm-list-depth0.txt"
grep -q "@logbrew/sdk@${sdk_package_version}" "$tmp_dir/npm-list-depth0.txt"
grep -q "redis@${redis_version}" "$tmp_dir/npm-list-depth0.txt"
grep -q "ioredis@${ioredis_version}" "$tmp_dir/npm-list-depth0.txt"

cat > smoke.mjs <<'EOF'
import { createRequire } from "node:module";
import { createClient } from "redis";
import Redis from "ioredis";
import {
  createLogBrewNodeClient,
  instrumentLogBrewRedisClient
} from "@logbrew/node";

const require = createRequire(import.meta.url);
const redisPackageVersion = require("redis/package.json").version;
const ioredisPackageVersion = require("ioredis/package.json").version;
const operationTrace = {
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "00f067aa0ba902b7",
  sampled: true
};

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertMetadata(metadata, expected, message, preview) {
  for (const [key, value] of Object.entries(expected)) {
    if (metadata?.[key] !== value) {
      throw new Error(`${message}: expected ${key}=${JSON.stringify(value)}, got ${JSON.stringify(metadata?.[key])}; ${preview}`);
    }
  }
}

function exceptionEvents(type) {
  return [{
    name: "exception",
    metadata: {
      exceptionEscaped: true,
      exceptionType: type
    }
  }];
}

function assertJsonEqual(actual, expected, message, preview) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)}; ${preview}`);
  }
}

function createClientForSmoke(sdkName, spanIds) {
  const client = createLogBrewNodeClient({
    serverApiKey: "LOGBREW_SERVER_API_KEY",
    sdkName,
    sdkVersion: "0.1.0"
  });
  return {
    client,
    options: {
      cacheName: "profiles",
      client,
      metadata: { safeFeature: "redis-real-package" },
      now: () => "2026-07-06T10:00:00Z",
      nowMs: (() => {
        let now = 1000;
        return () => {
          now += 9;
          return now;
        };
      })(),
      spanIdFactory: () => spanIds.shift() ?? "d7ad6b7169203999",
      trace: operationTrace,
      tracePipelines: true
    }
  };
}

function patchNodeRedisPipelineExecution(client) {
  const probe = client.multi();
  const prototype = Object.getPrototypeOf(probe);
  const originalExec = prototype.exec;
  const originalExecAsPipeline = prototype.execAsPipeline;
  let mode = "success";
  prototype.exec = async function logBrewNodeRedisExecSmoke() {
    if (mode === "failure") {
      throw new RangeError("node redis package failed with private profile value");
    }
    return ["OK", "cached-profile"];
  };
  prototype.execAsPipeline = async function logBrewNodeRedisExecAsPipelineSmoke() {
    if (mode === "failure") {
      throw new RangeError("node redis package failed with private profile value");
    }
    return ["OK", "cached-profile"];
  };
  return {
    setMode(nextMode) {
      mode = nextMode;
    },
    restore() {
      prototype.exec = originalExec;
      prototype.execAsPipeline = originalExecAsPipeline;
    }
  };
}

function patchIoredisPipelineExecution(client) {
  const probe = client.pipeline();
  const prototype = Object.getPrototypeOf(probe);
  const originalExec = prototype.exec;
  let mode = "success";
  prototype.exec = function logBrewIoredisExecSmoke(callback) {
    if (mode === "failure") {
      const error = new RangeError("ioredis package failed with private profile value");
      if (typeof callback === "function") {
        callback(error);
        return Promise.reject(error);
      }
      return Promise.reject(error);
    }
    const result = [[null, "OK"], [null, "cached-profile"]];
    if (typeof callback === "function") {
      callback(null, result);
    }
    return Promise.resolve(result);
  };
  return {
    setMode(nextMode) {
      mode = nextMode;
    },
    restore() {
      prototype.exec = originalExec;
    }
  };
}

async function runNodeRedisSmoke() {
  const { client: logbrewClient, options } = createClientForSmoke("node-redis-package-smoke", [
    "d7ad6b7169204101",
    "d7ad6b7169204102"
  ]);
  const redis = createClient({ url: "redis://127.0.0.1:1" });
  const originalMulti = redis.multi;
  const originalSendCommand = redis.sendCommand;
  const patch = patchNodeRedisPipelineExecution(redis);
  const instrumentation = instrumentLogBrewRedisClient(redis, options);

  try {
    const success = await redis.multi()
      .set("profile:private", "Ada")
      .get("profile:42")
      .execAsPipeline();
    assert(JSON.stringify(success) === JSON.stringify(["OK", "cached-profile"]), "node-redis pipeline result changed");

    patch.setMode("failure");
    let failed = false;
    await redis.multi().set("profile:private", "Ada").exec().catch((error) => {
      failed = error instanceof RangeError;
    });
    assert(failed, "node-redis pipeline failure should be rethrown");
  } finally {
    instrumentation.uninstall();
    patch.restore();
    try {
      redis.destroy?.();
    } catch {
      // The smoke never opens a network connection; node-redis throws when a closed client is destroyed.
    }
  }

  assert(redis.multi === originalMulti, "node-redis multi was not restored");
  assert(redis.sendCommand === originalSendCommand, "node-redis sendCommand was not restored");

  const payload = JSON.parse(logbrewClient.previewJson());
  const pipelineSpan = payload.events.find((event) => event.id === "evt_node_redis_pipeline");
  const multiErrorSpan = payload.events.find((event) => event.id === "evt_node_redis_multi_error");
  assert(pipelineSpan?.attributes?.name === "redis PIPELINE redis.pipeline", `missing node-redis pipeline span: ${logbrewClient.previewJson()}`);
  assertMetadata(pipelineSpan.attributes.metadata, {
    "db.namespace": "profiles",
    "db.operation.name": "PIPELINE",
    "db.system.name": "redis",
    dbName: "profiles",
    dbOperation: "redis.pipeline",
    dbOperationKind: "PIPELINE",
    dbSystem: "redis",
    framework: "node:redis",
    redisPipelineCommandCount: 2,
    redisPipelineCommands: "SET,GET",
    safeFeature: "redis-real-package"
  }, "node-redis pipeline span missing aggregate metadata", logbrewClient.previewJson());
  assert(pipelineSpan.attributes.traceId === operationTrace.traceId, "node-redis pipeline trace id mismatch");
  assert(pipelineSpan.attributes.parentSpanId === operationTrace.spanId, "node-redis pipeline parent span mismatch");
  assert(pipelineSpan.attributes.spanId === "d7ad6b7169204101", "node-redis pipeline span id mismatch");
  assert(multiErrorSpan?.attributes?.status === "error", `missing node-redis multi error span: ${logbrewClient.previewJson()}`);
  assertMetadata(multiErrorSpan.attributes.metadata, {
    "db.operation.name": "MULTI",
    dbOperation: "redis.multi",
    dbOperationKind: "MULTI",
    errorType: "RangeError",
    redisPipelineCommandCount: 1,
    redisPipelineCommands: "SET"
  }, "node-redis multi error span missing aggregate metadata", logbrewClient.previewJson());
  assertJsonEqual(multiErrorSpan.attributes.events, exceptionEvents("RangeError"), "node-redis multi error span should include type-only exception event", logbrewClient.previewJson());
  assertNoPrivateRedisDetails(logbrewClient.previewJson(), "node-redis");
  return payload.events.length;
}

async function runIoredisSmoke() {
  const { client: logbrewClient, options } = createClientForSmoke("ioredis-package-smoke", [
    "d7ad6b7169204201",
    "d7ad6b7169204202"
  ]);
  const redis = new Redis({
    host: "127.0.0.1",
    port: 1,
    lazyConnect: true,
    enableOfflineQueue: false,
    ["retry" + "Stra" + "tegy"]: null
  });
  const originalPipeline = redis.pipeline;
  const originalSendCommand = redis.sendCommand;
  const patch = patchIoredisPipelineExecution(redis);
  const instrumentation = instrumentLogBrewRedisClient(redis, options);

  try {
    const success = await redis.pipeline()
      .set("profile:private", "Ada")
      .get("profile:42")
      .exec();
    assert(JSON.stringify(success) === JSON.stringify([[null, "OK"], [null, "cached-profile"]]), "ioredis pipeline result changed");

    patch.setMode("failure");
    let failed = false;
    await redis.pipeline().set("profile:private", "Ada").exec().catch((error) => {
      failed = error instanceof RangeError;
    });
    assert(failed, "ioredis pipeline failure should be rethrown");
  } finally {
    instrumentation.uninstall();
    patch.restore();
    redis.disconnect();
  }

  assert(redis.pipeline === originalPipeline, "ioredis pipeline was not restored");
  assert(redis.sendCommand === originalSendCommand, "ioredis sendCommand was not restored");

  const payload = JSON.parse(logbrewClient.previewJson());
  const pipelineSpan = payload.events.find((event) => event.id === "evt_node_redis_pipeline");
  const pipelineErrorSpan = payload.events.find((event) => event.id === "evt_node_redis_pipeline_error");
  assert(pipelineSpan?.attributes?.name === "redis PIPELINE redis.pipeline", `missing ioredis pipeline span: ${logbrewClient.previewJson()}`);
  assertMetadata(pipelineSpan.attributes.metadata, {
    "db.namespace": "profiles",
    "db.operation.name": "PIPELINE",
    "db.system.name": "redis",
    dbName: "profiles",
    dbOperation: "redis.pipeline",
    dbOperationKind: "PIPELINE",
    dbSystem: "redis",
    framework: "node:redis",
    redisPipelineCommandCount: 2,
    redisPipelineCommands: "SET,GET",
    safeFeature: "redis-real-package"
  }, "ioredis pipeline span missing aggregate metadata", logbrewClient.previewJson());
  assert(pipelineSpan.attributes.traceId === operationTrace.traceId, "ioredis pipeline trace id mismatch");
  assert(pipelineSpan.attributes.parentSpanId === operationTrace.spanId, "ioredis pipeline parent span mismatch");
  assert(pipelineSpan.attributes.spanId === "d7ad6b7169204201", "ioredis pipeline span id mismatch");
  assert(pipelineErrorSpan?.attributes?.status === "error", `missing ioredis pipeline error span: ${logbrewClient.previewJson()}`);
  assertMetadata(pipelineErrorSpan.attributes.metadata, {
    "db.operation.name": "PIPELINE",
    dbOperation: "redis.pipeline",
    dbOperationKind: "PIPELINE",
    errorType: "RangeError",
    redisPipelineCommandCount: 1,
    redisPipelineCommands: "SET"
  }, "ioredis pipeline error span missing aggregate metadata", logbrewClient.previewJson());
  assertJsonEqual(pipelineErrorSpan.attributes.events, exceptionEvents("RangeError"), "ioredis pipeline error span should include type-only exception event", logbrewClient.previewJson());
  assertNoPrivateRedisDetails(logbrewClient.previewJson(), "ioredis");
  return payload.events.length;
}

function assertNoPrivateRedisDetails(preview, label) {
  const forbidden = [
    "profile:42",
    "profile:private",
    "Ada",
    "cached-profile",
    "private profile value",
    "redis://127.0.0.1",
    "127.0.0.1",
    "LOGBREW_SERVER_API_KEY"
  ];
  for (const value of forbidden) {
    assert(!preview.includes(value), `${label} span leaked private Redis detail: ${value}; ${preview}`);
  }
}

const nodeRedisEvents = await runNodeRedisSmoke();
const ioredisEvents = await runIoredisSmoke();
console.log(JSON.stringify({
  ok: true,
  redisPackageVersion,
  ioredisPackageVersion,
  nodeRedisEvents,
  ioredisEvents
}));
EOF

node smoke.mjs > "$tmp_dir/redis-packages-smoke.json"
grep -q '"ok":true' "$tmp_dir/redis-packages-smoke.json"
grep -q "\"redisPackageVersion\":\"${redis_version}\"" "$tmp_dir/redis-packages-smoke.json"
grep -q "\"ioredisPackageVersion\":\"${ioredis_version}\"" "$tmp_dir/redis-packages-smoke.json"
grep -q '"nodeRedisEvents":2' "$tmp_dir/redis-packages-smoke.json"
grep -q '"ioredisEvents":2' "$tmp_dir/redis-packages-smoke.json"

echo "node redis real-package smoke passed with redis ${redis_version}, ioredis ${ioredis_version}, node $(node --version)"
