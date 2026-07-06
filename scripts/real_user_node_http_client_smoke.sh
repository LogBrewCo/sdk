#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sdk_package_version="$(node -p "require('${repo_root}/js/logbrew-js/package.json').version")"
node_package_version="$(node -p "require('${repo_root}/js/logbrew-node/package.json').version")"
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

app_dir="$tmp_dir/node-http-client-smoke"
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
  "typescript@5.9.3" \
  "@types/node@24.10.1" \
  >/dev/null

npm uninstall @logbrew/node >/dev/null
npm install --save-exact --no-audit --fund=false "$node_tgz" >/dev/null

grep -q '"@logbrew/sdk": "file:' package.json
grep -q '"@logbrew/node": "file:' package.json
npm ls @logbrew/sdk @logbrew/node typescript @types/node >/dev/null
npm list --depth=0 > "$tmp_dir/npm-list-depth0.txt"
grep -q "@logbrew/sdk@${sdk_package_version}" "$tmp_dir/npm-list-depth0.txt"
grep -q "@logbrew/node@${node_package_version}" "$tmp_dir/npm-list-depth0.txt"
test -f node_modules/@logbrew/sdk/index.js
test -f node_modules/@logbrew/node/index.js

cat > smoke.mjs <<'EOF'
import http from "node:http";
import { once } from "node:events";
import {
  createLogBrewNodeClient,
  createNodeFetchTransport,
  installLogBrewHttpClientInstrumentation
} from "@logbrew/node";

const serverApiKey = "LOGBREW_SERVER_API_KEY";
const operationTrace = {
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "00f067aa0ba902b7",
  sampled: true
};
const requestRecords = [];
const intakeRequests = [];
let intakeAttempts = 0;
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

function nextSpanId() {
  spanIdCounter += 1;
  return `c${String(spanIdCounter).padStart(15, "0")}`;
}

function shouldCapture({ path }) {
  return (
    path.startsWith("/checkout/") ||
    path.startsWith("/fail/") ||
    path.startsWith("/get/") ||
    path.startsWith("/bulk/")
  );
}

function routeTemplateFactory({ path }) {
  if (path.startsWith("/checkout/")) return "/checkout/:id";
  if (path.startsWith("/get/")) return "/get/:id";
  if (path.startsWith("/bulk/")) return "/bulk/:id";
  return path;
}

function assertNoUnsafeContent(preview) {
  for (const value of [
    "coupon=spring",
    "debug=1",
    "caller-header-value",
    "request-body-that-must-not-leak",
    "upstream response body must not be captured",
    "127.0.0.1",
    "traceparent"
  ]) {
    if (preview.includes(value)) {
      throw new Error(`unsafe Node HTTP detail leaked into payload: ${value}`);
    }
  }
}

function createServer() {
  return http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (req.url === "/v1/events") {
        intakeAttempts += 1;
        intakeRequests.push({
          authorization: req.headers.authorization,
          body,
          contentType: req.headers["content-type"],
          method: req.method,
          source: req.headers["x-logbrew-source"],
          url: req.url
        });
        res.statusCode = intakeAttempts === 1 ? 503 : 202;
        res.end("accepted");
        return;
      }

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

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function httpRequest(url, options = {}, body = undefined) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      let responseBody = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        responseBody += chunk;
      });
      res.on("end", () => {
        resolve({ body: responseBody, statusCode: res.statusCode });
      });
    });
    req.on("error", reject);
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let responseBody = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        responseBody += chunk;
      });
      res.on("end", () => {
        resolve({ body: responseBody, statusCode: res.statusCode });
      });
    });
    req.on("error", reject);
  });
}

const server = createServer();
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;
const baseURL = `http://127.0.0.1:${port}`;
const originalRequest = http.request;
const originalGet = http.get;

try {
  const client = createLogBrewNodeClient({
    serverApiKey,
    maxRetries: 1,
    sdkName: "node-http-client-smoke",
    sdkVersion: "0.1.0"
  });
  const instrumentation = installLogBrewHttpClientInstrumentation({
    client,
    captureTargets: shouldCapture,
    metadata: {
      safeFeature: "node-http-client-real-package"
    },
    modules: {
      http
    },
    now: (() => {
      let index = 0;
      return () => `2026-07-06T12:00:${String(index++).padStart(2, "0")}Z`;
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
    trace: operationTrace,
    tracePropagationTargets: shouldCapture
  });

  assert(instrumentation.isInstalled(), "Node HTTP instrumentation should install");
  assert(http.request !== originalRequest, "http.request should be wrapped");
  assert(http.get !== originalGet, "http.get should be wrapped");

  const callerHeaders = {
    "x-caller-context": "caller-header-value"
  };
  const callerOptions = {
    headers: callerHeaders,
    method: "POST"
  };
  const success = await httpRequest(new URL(`${baseURL}/checkout/123?coupon=spring`), callerOptions, "request-body-that-must-not-leak");
  assertEqual(success.statusCode, 200, "Node HTTP success status");
  assertEqual(callerHeaders.traceparent, undefined, "caller headers must not be mutated");
  const successTraceparent = requestRecords.at(-1).traceparent;
  assert(successTraceparent?.startsWith(`00-${operationTrace.traceId}-`), "Node HTTP success traceparent must use active trace id");

  const getResponse = await httpGet(`${baseURL}/get/456?debug=1`);
  assertEqual(getResponse.statusCode, 200, "Node HTTP get status");
  const getTraceparent = requestRecords.at(-1).traceparent;
  assert(getTraceparent?.startsWith(`00-${operationTrace.traceId}-`), "Node HTTP get traceparent must use active trace id");

  const failure = await httpRequest(`${baseURL}/fail/503?coupon=spring`, { method: "GET" });
  assertEqual(failure.statusCode, 503, "Node HTTP 503 status");
  const failureTraceparent = requestRecords.at(-1).traceparent;
  assert(failureTraceparent?.startsWith(`00-${operationTrace.traceId}-`), "Node HTTP failure traceparent must use active trace id");

  await httpRequest(`${baseURL}/unmatched?debug=1`, { method: "GET" });
  assertEqual(requestRecords.at(-1).traceparent, undefined, "unmatched target should not receive traceparent");
  await httpGet(`${baseURL}/unmatched-get?debug=1`);
  assertEqual(requestRecords.at(-1).traceparent, undefined, "unmatched http.get target should not receive traceparent");

  instrumentation.uninstall();
  assert(!instrumentation.isInstalled(), "Node HTTP instrumentation should uninstall");
  assertEqual(http.request, originalRequest, "http.request should be restored");
  assertEqual(http.get, originalGet, "http.get should be restored");
  await httpRequest(`${baseURL}/checkout/after-uninstall?coupon=spring`, { method: "GET" });
  assertEqual(requestRecords.at(-1).traceparent, undefined, "uninstalled Node HTTP module should not inject traceparent");

  const preview = client.previewJson();
  assertNoUnsafeContent(preview);
  const payload = JSON.parse(preview);
  const successSpanId = successTraceparent.split("-")[2];
  const getSpanId = getTraceparent.split("-")[2];
  const failureSpanId = failureTraceparent.split("-")[2];
  const successSpan = payload.events.find((event) => event.attributes?.spanId === successSpanId);
  const getSpan = payload.events.find((event) => event.attributes?.spanId === getSpanId);
  const failureSpan = payload.events.find((event) => event.attributes?.spanId === failureSpanId);
  assert(successSpan, `missing Node HTTP success span: ${preview}`);
  assert(getSpan, `missing Node HTTP get span: ${preview}`);
  assert(failureSpan, `missing Node HTTP failure span: ${preview}`);
  assertEqual(successSpan.attributes.name, "POST /checkout/:id", "Node HTTP success span name");
  assertEqual(successSpan.attributes.status, "ok", "Node HTTP success span status");
  assertEqual(successSpan.attributes.traceId, operationTrace.traceId, "Node HTTP success trace id");
  assertEqual(successSpan.attributes.parentSpanId, operationTrace.spanId, "Node HTTP success parent span id");
  assertMetadata(successSpan.attributes.metadata, {
    framework: "node:http",
    "http.request.method": "POST",
    "http.response.status_code": 200,
    "http.route": "/checkout/:id",
    method: "POST",
    path: "/checkout/:id",
    sampled: true,
    safeFeature: "node-http-client-real-package",
    statusCode: 200,
    "url.path": "/checkout/:id"
  }, "Node HTTP success metadata");
  assertEqual(getSpan.attributes.name, "GET /get/:id", "Node HTTP get span name");
  assertEqual(failureSpan.attributes.name, "GET /fail/503", "Node HTTP failure span name");
  assertEqual(failureSpan.attributes.status, "error", "Node HTTP failure span status");
  assertMetadata(failureSpan.attributes.metadata, {
    framework: "node:http",
    "http.request.method": "GET",
    "http.response.status_code": 503,
    "http.route": "/fail/503",
    statusCode: 503
  }, "Node HTTP failure metadata");
  assertJsonEqual(failureSpan.attributes.events, exceptionEvents("HttpStatusError"), "Node HTTP failure span events");

  const flushResponse = await client.flush(createNodeFetchTransport({
    endpoint: `${baseURL}/v1/events`,
    headers: {
      "x-logbrew-source": "node-http-client-smoke"
    }
  }));
  assertEqual(flushResponse.statusCode, 202, "flush status");
  assertEqual(flushResponse.attempts, 2, "flush retry attempts");
  assertEqual(intakeRequests.length, 2, "intake retry request count");
  assertEqual(client.pendingEvents(), 0, "queue after flush");
  for (const request of intakeRequests) {
    assertEqual(request.authorization, `Bearer ${serverApiKey}`, "authorization header");
    assertEqual(request.contentType, "application/json", "content type");
    assertEqual(request.method, "POST", "intake method");
    assertEqual(request.source, "node-http-client-smoke", "intake source");
    assertEqual(request.url, "/v1/events", "intake path");
    assertNoUnsafeContent(request.body);
  }

  const highLoadDrops = [];
  const highLoadClient = createLogBrewNodeClient({
    serverApiKey,
    maxQueueSize: 20,
    sdkName: "node-http-client-high-load-smoke",
    sdkVersion: "0.1.0",
    onEventDropped(drop) {
      highLoadDrops.push(drop);
    }
  });
  const highLoadInstrumentation = installLogBrewHttpClientInstrumentation({
    client: highLoadClient,
    captureTargets: ({ path }) => path.startsWith("/bulk/"),
    modules: { http },
    routeTemplateFactory,
    spanIdFactory: (() => {
      let index = 0;
      return () => `d${String(index++).padStart(15, "0")}`;
    })(),
    trace: operationTrace,
    tracePropagationTargets: ({ path }) => path.startsWith("/bulk/")
  });
  await Promise.all(Array.from({ length: 30 }, (_, index) => httpGet(`${baseURL}/bulk/${index}?debug=1`)));
  highLoadInstrumentation.uninstall();
  assertEqual(highLoadClient.pendingEvents(), 20, "Node HTTP high-load bounded queue size");
  assertEqual(highLoadClient.droppedEvents(), 10, "Node HTTP high-load dropped count");
  assertEqual(highLoadDrops.length, 10, "Node HTTP high-load drop callback count");
} finally {
  if (http.request !== originalRequest || http.get !== originalGet) {
    http.request = originalRequest;
    http.get = originalGet;
  }
  await closeServer(server);
}
EOF

node smoke.mjs

cat > typecheck.ts <<'EOF'
import * as http from "node:http";
import {
  createLogBrewNodeClient,
  installLogBrewHttpClientInstrumentation,
  type LogBrewHttpClientInstrumentation
} from "@logbrew/node";

const client = createLogBrewNodeClient({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "node-http-client-typecheck",
  sdkVersion: "0.1.0"
});

const handle: LogBrewHttpClientInstrumentation = installLogBrewHttpClientInstrumentation({
  client,
  captureTargets: ({ path }) => path.startsWith("/api/"),
  modules: {
    http
  },
  routeTemplateFactory: ({ path }) => path,
  spanIdFactory: () => "eeeeeeeeeeeeeeee",
  trace: {
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
    sampled: true
  },
  tracePropagationTargets: [/^http:\/\/127\.0\.0\.1/u]
});

handle.uninstall();
EOF

npx tsc --noEmit --module NodeNext --moduleResolution NodeNext --target ES2022 --lib ES2022,DOM typecheck.ts

cat > cjs-smoke.cjs <<'EOF'
const assert = require("node:assert/strict");
const { installLogBrewHttpClientInstrumentation } = require("@logbrew/node");

assert.equal(typeof installLogBrewHttpClientInstrumentation, "function");
EOF

node cjs-smoke.cjs
echo "Node HTTP client installed-package smoke passed"
