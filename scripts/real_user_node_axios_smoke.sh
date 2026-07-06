#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sdk_package_version="$(node -p "require('${repo_root}/js/logbrew-js/package.json').version")"
node_package_version="$(node -p "require('${repo_root}/js/logbrew-node/package.json').version")"
axios_version="${LOGBREW_NODE_AXIOS_PACKAGE_VERSION:-1.18.1}"
tmp_dir="$(mktemp -d)"
export npm_config_cache="$tmp_dir/npm-cache"
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

app_dir="$tmp_dir/node-axios-smoke"
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
  "axios@${axios_version}" \
  "typescript@5.9.3" \
  "@types/node@24.10.1" \
  >/dev/null

npm uninstall @logbrew/node >/dev/null
npm install --save-exact --no-audit --fund=false "$node_tgz" >/dev/null

grep -q '"@logbrew/sdk": "file:' package.json
grep -q '"@logbrew/node": "file:' package.json
grep -q "\"axios\": \"${axios_version}\"" package.json
npm ls @logbrew/sdk @logbrew/node axios typescript @types/node >/dev/null
npm list --depth=0 > "$tmp_dir/npm-list-depth0.txt"
grep -q "@logbrew/sdk@${sdk_package_version}" "$tmp_dir/npm-list-depth0.txt"
grep -q "@logbrew/node@${node_package_version}" "$tmp_dir/npm-list-depth0.txt"
grep -q "axios@${axios_version}" "$tmp_dir/npm-list-depth0.txt"
test -f node_modules/@logbrew/sdk/index.js
test -f node_modules/@logbrew/node/index.js

cat > smoke.mjs <<'EOF'
import http from "node:http";
import { once } from "node:events";
import axios from "axios";
import {
  axiosRequestWithLogBrewSpan,
  createLogBrewNodeClient,
  instrumentLogBrewAxiosInstance
} from "@logbrew/node";

const serverApiKey = "LOGBREW_SERVER_API_KEY";
const requestRecords = [];
const operationTrace = {
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "00f067aa0ba902b7",
  sampled: true
};
let spanIdCounter = 0;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertMetadata(metadata, expected, message) {
  for (const [key, value] of Object.entries(expected)) {
    assertEqual(metadata?.[key], value, `${message} ${key}`);
  }
}

function assertJsonEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)}`);
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

function createServer() {
  return http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requestRecords.push({
        body,
        method: req.method,
        path: req.url,
        traceparent: req.headers.traceparent
      });
      if (req.url?.startsWith("/fail")) {
        res.statusCode = 503;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ message: "upstream response body must not be captured" }));
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
  });
}

function routeTemplateFactory({ path }) {
  if (path.startsWith("/checkout/")) return "/checkout/:id";
  if (path.startsWith("/bulk/")) return "/bulk/:id";
  return path;
}

function nextSpanId() {
  spanIdCounter += 1;
  return `a${String(spanIdCounter).padStart(15, "0")}`;
}

function assertTraceparent(record, spanId, message) {
  assertEqual(record.traceparent, `00-${operationTrace.traceId}-${spanId}-01`, message);
}

function assertNoUnsafeContent(preview) {
  for (const value of [
    "coupon=spring",
    "debug=1",
    "caller-header-value",
    "request-body-that-must-not-leak",
    "upstream response body must not be captured",
    "Request failed with status code 503",
    "127.0.0.1",
    "traceparent"
  ]) {
    if (preview.includes(value)) {
      throw new Error(`unsafe Axios detail leaked into payload: ${value}`);
    }
  }
}

const server = createServer();
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;
const baseURL = `http://127.0.0.1:${port}`;

try {
  const client = createLogBrewNodeClient({
    serverApiKey,
    sdkName: "node-axios-smoke",
    sdkVersion: "0.1.0"
  });
  const axiosClient = axios.create({
    baseURL,
    headers: {
      "x-caller-context": "caller-header-value"
    }
  });
  const instrumentation = instrumentLogBrewAxiosInstance(axiosClient, {
    client,
    metadata: {
      safeFeature: "axios-real-package"
    },
    now: (() => {
      let index = 0;
      return () => `2026-07-06T10:00:${String(index++).padStart(2, "0")}Z`;
    })(),
    nowMs: (() => {
      let now = 1000;
      return () => {
        now += 11;
        return now;
      };
    })(),
    routeTemplateFactory,
    spanIdFactory: nextSpanId,
    trace: operationTrace
  });

  assert(instrumentation.isInstalled(), "Axios instrumentation should be installed");
  const success = await axiosClient.get("/checkout/123?coupon=spring");
  assertEqual(success.status, 200, "Axios success response status");
  assertEqual(success.data.ok, true, "Axios success response body");
  const successTraceparent = requestRecords.at(-1).traceparent;
  assert(successTraceparent?.startsWith(`00-${operationTrace.traceId}-`), "Axios success traceparent must use active trace id");

  let axiosError;
  try {
    await axiosClient.get("/fail/503?coupon=spring");
  } catch (error) {
    axiosError = error;
  }
  assert(axiosError?.isAxiosError, "Axios error should be preserved");
  assertEqual(axiosError.response.status, 503, "Axios error response status");
  const errorTraceparent = requestRecords.at(-1).traceparent;
  assert(errorTraceparent?.startsWith(`00-${operationTrace.traceId}-`), "Axios error traceparent must use active trace id");

  instrumentation.uninstall();
  assert(!instrumentation.isInstalled(), "Axios instrumentation should uninstall");
  const requestCountBeforeUninstrumentedCall = requestRecords.length;
  await axiosClient.get("/after-uninstall");
  assertEqual(requestRecords.length, requestCountBeforeUninstrumentedCall + 1, "uninstrumented request count");
  assertEqual(requestRecords.at(-1).traceparent, undefined, "uninstalled Axios instance should not inject traceparent");

  const directResponse = await axiosRequestWithLogBrewSpan(axiosClient, {
    method: "POST",
    url: "/orders/456?debug=1",
    headers: {
      "x-caller-context": "caller-header-value"
    },
    data: {
      payload: "request-body-that-must-not-leak"
    }
  }, {
    client,
    metadata: {
      safeFeature: "axios-direct-helper"
    },
    now: () => "2026-07-06T10:01:00Z",
    nowMs: (() => {
      let now = 2000;
      return () => {
        now += 13;
        return now;
      };
    })(),
    routeTemplate: "/orders/:id",
    spanIdFactory: nextSpanId,
    trace: operationTrace
  });
  assertEqual(directResponse.status, 200, "direct Axios helper response status");
  const directTraceparent = requestRecords.at(-1).traceparent;
  assert(directTraceparent?.startsWith(`00-${operationTrace.traceId}-`), "direct Axios helper traceparent must use active trace id");

  const preview = client.previewJson();
  assertNoUnsafeContent(preview);
  const payload = JSON.parse(preview);
  const successSpanId = successTraceparent.split("-")[2];
  const errorSpanId = errorTraceparent.split("-")[2];
  const directSpanId = directTraceparent.split("-")[2];
  const successSpan = payload.events.find((event) => event.attributes?.spanId === successSpanId);
  const errorSpan = payload.events.find((event) => event.attributes?.spanId === errorSpanId);
  const directSpan = payload.events.find((event) => event.attributes?.spanId === directSpanId);
  assert(successSpan, `missing Axios success span: ${preview}`);
  assert(errorSpan, `missing Axios error span: ${preview}`);
  assert(directSpan, `missing direct Axios span: ${preview}`);
  assertEqual(successSpan.attributes.name, "GET /checkout/:id", "Axios success span name");
  assertEqual(successSpan.attributes.status, "ok", "Axios success span status");
  assertEqual(successSpan.attributes.traceId, operationTrace.traceId, "Axios success trace id");
  assertEqual(successSpan.attributes.parentSpanId, operationTrace.spanId, "Axios success parent span id");
  assertMetadata(successSpan.attributes.metadata, {
    framework: "node:axios",
    "http.request.method": "GET",
    "http.response.status_code": 200,
    "http.route": "/checkout/:id",
    method: "GET",
    path: "/checkout/:id",
    sampled: true,
    safeFeature: "axios-real-package",
    statusCode: 200,
    "url.path": "/checkout/:id"
  }, "Axios success metadata");
  assertEqual(errorSpan.attributes.name, "GET /fail/503", "Axios error span name");
  assertEqual(errorSpan.attributes.status, "error", "Axios error span status");
  assertMetadata(errorSpan.attributes.metadata, {
    errorType: "AxiosError",
    framework: "node:axios",
    "http.request.method": "GET",
    "http.response.status_code": 503,
    "http.route": "/fail/503",
    statusCode: 503
  }, "Axios error metadata");
  assertJsonEqual(errorSpan.attributes.events, exceptionEvents("AxiosError"), "Axios error span events");
  assertEqual(directSpan.attributes.name, "POST /orders/:id", "direct Axios span name");
  assertMetadata(directSpan.attributes.metadata, {
    framework: "node:axios",
    "http.request.method": "POST",
    "http.route": "/orders/:id",
    safeFeature: "axios-direct-helper"
  }, "direct Axios metadata");

  const highLoadDrops = [];
  const highLoadClient = createLogBrewNodeClient({
    serverApiKey,
    maxQueueSize: 20,
    sdkName: "node-axios-high-load-smoke",
    sdkVersion: "0.1.0",
    onEventDropped(drop) {
      highLoadDrops.push(drop);
    }
  });
  const highLoadAxios = axios.create({ baseURL });
  instrumentLogBrewAxiosInstance(highLoadAxios, {
    client: highLoadClient,
    routeTemplateFactory,
    spanIdFactory: (() => {
      let index = 0;
      return () => `b${String(index++).padStart(15, "0")}`;
    })(),
    trace: operationTrace
  });
  await Promise.all(Array.from({ length: 30 }, (_, index) => highLoadAxios.get(`/bulk/${index}?debug=1`)));
  assertEqual(highLoadClient.pendingEvents(), 20, "Axios high-load bounded queue size");
  assertEqual(highLoadClient.droppedEvents(), 10, "Axios high-load dropped count");
  assertEqual(highLoadDrops.length, 10, "Axios high-load drop callback count");
} finally {
  server.close();
  await once(server, "close");
}
EOF

node smoke.mjs

cat > typecheck.ts <<'EOF'
import axios from "axios";
import {
  axiosRequestWithLogBrewSpan,
  createLogBrewNodeClient,
  instrumentLogBrewAxiosInstance,
  type LogBrewAxiosInstrumentation
} from "@logbrew/node";

async function main(): Promise<void> {
  const client = createLogBrewNodeClient({
    serverApiKey: "LOGBREW_SERVER_API_KEY",
    sdkName: "node-axios-typecheck",
    sdkVersion: "0.1.0"
  });
  const instance = axios.create({ baseURL: "http://127.0.0.1:1" });
  const handle: LogBrewAxiosInstrumentation = instrumentLogBrewAxiosInstance(instance, {
    client,
    routeTemplateFactory: ({ path }) => path,
    spanIdFactory: () => "cccccccccccccccc",
    trace: {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      sampled: true
    }
  });
  handle.uninstall();
  await axiosRequestWithLogBrewSpan(instance, { method: "GET", url: "/" }, {
    client,
    spanIdFactory: () => "dddddddddddddddd",
    traceIdFactory: () => "11111111111111111111111111111111"
  });
}

void main;
EOF

npx tsc --noEmit --module NodeNext --moduleResolution NodeNext --target ES2022 --lib ES2022,DOM typecheck.ts

cat > cjs-smoke.cjs <<'EOF'
const assert = require("node:assert/strict");
const {
  axiosRequestWithLogBrewSpan,
  instrumentLogBrewAxiosInstance
} = require("@logbrew/node");

assert.equal(typeof axiosRequestWithLogBrewSpan, "function");
assert.equal(typeof instrumentLogBrewAxiosInstance, "function");
EOF

node cjs-smoke.cjs
echo "Node Axios installed-package smoke passed with axios@${axios_version}"
