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
browser_pack_json="$tmp_dir/browser-pack.json"
(cd "$repo_root/js/logbrew-js" && npm pack --json --pack-destination "$tmp_dir") > "$core_pack_json"
(cd "$repo_root/js/logbrew-browser" && npm pack --json --pack-destination "$tmp_dir") > "$browser_pack_json"

core_tgz="$(python3 - "$core_pack_json" <<'PY'
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
browser_tgz="$tmp_dir/$browser_tgz"
test -f "$core_tgz"
test -f "$browser_tgz"

app_dir="$tmp_dir/browser-fake-intake-app"
mkdir -p "$app_dir"
cd "$app_dir"
npm init -y >/dev/null
npm pkg set type=module >/dev/null
npm install \
  --save-exact \
  --no-audit \
  --fund=false \
  "$core_tgz" \
  "$browser_tgz" \
  >/dev/null

grep -q '"@logbrew/sdk": "file:' package.json
grep -q '"@logbrew/browser": "file:' package.json
grep -q '"@logbrew/sdk"' package-lock.json
grep -q '"@logbrew/browser"' package-lock.json
npm ls @logbrew/sdk @logbrew/browser >/dev/null
npm list --depth=0 > "$tmp_dir/npm-list-depth0.txt"
grep -q '@logbrew/browser@0.1.0' "$tmp_dir/npm-list-depth0.txt"
grep -q "@logbrew/sdk@${sdk_package_version}" "$tmp_dir/npm-list-depth0.txt"

cat > smoke.mjs <<'EOF'
import http from "node:http";
import { createRequire } from "node:module";
import { createFetchTransport, createLogBrewBrowserClient, installLogBrewBrowser } from "@logbrew/browser";
import { SdkError, TransportError } from "@logbrew/sdk";

const require = createRequire(import.meta.url);
const { createFetchTransport: createCjsFetchTransport } = require("@logbrew/browser");
const highVolumeLogs = 250;
const clientKey = "LOGBREW_BROWSER_KEY";
const wrongClientKey = "WRONG_LOGBREW_BROWSER_KEY";
const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const parentSpanId = "00f067aa0ba902b7";
const childSpanId = "b7ad6b7169203331";

const retryIntake = await startFakeIntake({
  expectedAuthorization: `Bearer ${clientKey}`,
  statuses: [503, 202]
});
const invalidIntake = await startFakeIntake({
  expectedAuthorization: `Bearer ${wrongClientKey}`,
  statuses: [401]
});
const rateLimitIntake = await startFakeIntake({
  expectedAuthorization: `Bearer ${clientKey}`,
  statuses: [{
    headers: { "retry-after": "2" },
    status: 429
  }]
});
const lifecycleIntake = await startFakeIntake({
  expectedAuthorization: `Bearer ${clientKey}`,
  statuses: [202]
});
const onlineIntake = await startFakeIntake({
  expectedAuthorization: `Bearer ${clientKey}`,
  statuses: [202]
});
const shutdownIntake = await startFakeIntake({
  expectedAuthorization: `Bearer ${clientKey}`,
  statuses: [202]
});

try {
  const retryClient = createLogBrewBrowserClient({
    clientKey,
    maxRetries: 1,
    sdkName: "logbrew-browser-fake-intake-smoke",
    sdkVersion: "0.1.0"
  });
  queueAccountRecoveryEvents(retryClient);
  for (let index = 0; index < highVolumeLogs; index += 1) {
    retryClient.log(`evt_browser_fake_intake_load_${index.toString().padStart(3, "0")}`, timestamp(index + 10), {
      level: index % 5 === 0 ? "warning" : "info",
      logger: "browser.account-recovery",
      message: "account recovery heartbeat",
      metadata: baseMetadata({
        sequence: index,
        traceId
      })
    });
  }

  const retryResponse = await retryClient.flush(createFetchTransport({
    endpoint: `${retryIntake.url}/v1/events`,
    keepalive: false
  }));
  const retryPayload = parsePayload(retryIntake.requests.at(-1)?.body);
  assertEqual(retryResponse.statusCode, 202, "retry flush status");
  assertEqual(retryResponse.attempts, 2, "retry flush attempts");
  assertEqual(retryIntake.requests.length, 2, "retry request count");
  assertEqual(retryPayload.events.length, highVolumeLogs + 7, "retry payload event count");
  assertEqual(retryClient.pendingEvents(), 0, "retry client queue after flush");
  assertNoUnsafeContent(retryIntake.requests);
  assertCorrelation(retryPayload);

  const invalidClient = createLogBrewBrowserClient({
    clientKey: wrongClientKey,
    maxRetries: 1,
    sdkName: "logbrew-browser-fake-intake-smoke",
    sdkVersion: "0.1.0"
  });
  invalidClient.log("evt_browser_invalid_key_001", timestamp(500), {
    level: "error",
    logger: "browser.account-recovery",
    message: "invalid client key smoke",
    metadata: baseMetadata({ traceId })
  });

  const invalidError = await captureError(() => invalidClient.flush(createFetchTransport({
    endpoint: `${invalidIntake.url}/v1/events`
  })));
  if (!(invalidError instanceof SdkError)) {
    throw new Error(`expected SdkError for invalid key, got ${invalidError}`);
  }
  assertEqual(invalidError.code, "unauthenticated", "invalid key error code");
  if (String(invalidError.message).includes(wrongClientKey)) {
    throw new Error("invalid key error leaked the rejected key");
  }
  assertEqual(invalidClient.pendingEvents(), 1, "invalid key keeps event queued");

  const rateLimitClient = createLogBrewBrowserClient({
    clientKey,
    maxRetries: 2,
    sdkName: "logbrew-browser-fake-intake-smoke",
    sdkVersion: "0.1.0"
  });
  rateLimitClient.log("evt_browser_rate_limit_001", timestamp(600), {
    level: "warning",
    logger: "browser.account-recovery",
    message: "rate limit smoke",
    metadata: baseMetadata({ traceId })
  });
  const rateLimitError = await captureError(() => rateLimitClient.flush(createFetchTransport({
    endpoint: `${rateLimitIntake.url}/v1/events`
  })));
  if (!(rateLimitError instanceof SdkError)) {
    throw new Error(`expected SdkError for rate limit, got ${rateLimitError}`);
  }
  assertEqual(rateLimitError.code, "rate_limited", "rate limit error code");
  assertEqual(rateLimitError.retryAfterMs, 2000, "rate limit retry-after milliseconds");
  assertEqual(rateLimitClient.pendingEvents(), 1, "rate limit keeps event queued");
  assertEqual(rateLimitIntake.requests.length, 1, "rate limit should not retry immediately");

  const lifecycleReason = await assertBrowserEventFlush({
    eventType: "pagehide",
    intake: lifecycleIntake,
    label: "pagehide",
    reason: "pagehide",
    timestampOffset: 650
  });
  const onlineReason = await assertBrowserEventFlush({
    eventType: "online",
    intake: onlineIntake,
    label: "online",
    reason: "online",
    timestampOffset: 660
  });

  const shutdownClient = createLogBrewBrowserClient({
    clientKey,
    maxRetries: 0,
    sdkName: "logbrew-browser-fake-intake-smoke",
    sdkVersion: "0.1.0"
  });
  shutdownClient.log("evt_browser_shutdown_001", timestamp(700), {
    level: "info",
    logger: "browser.account-recovery",
    message: "shutdown flush smoke",
    metadata: baseMetadata({ traceId })
  });
  const shutdownResponse = await shutdownClient.shutdown(createFetchTransport({
    endpoint: `${shutdownIntake.url}/v1/events`
  }));
  assertEqual(shutdownResponse.statusCode, 202, "shutdown status");
  const shutdownError = await captureError(() => Promise.resolve().then(() => {
    shutdownClient.log("evt_browser_shutdown_after_001", timestamp(701), {
      level: "info",
      message: "after shutdown"
    });
  }));
  assertEqual(shutdownError.code, "shutdown_error", "post-shutdown error code");

  let keepaliveFetchCalls = 0;
  const keepaliveLimitedTransport = createFetchTransport({
    fetchImpl: async () => {
      keepaliveFetchCalls += 1;
      return { status: 202 };
    },
    maxKeepaliveBodyBytes: 64
  });
  const keepaliveBodyError = await captureError(() => keepaliveLimitedTransport.send(
    clientKey,
    JSON.stringify({ message: "x".repeat(80) })
  ));
  if (!(keepaliveBodyError instanceof TransportError)) {
    throw new Error(`expected TransportError for oversized keepalive body, got ${keepaliveBodyError}`);
  }
  assertEqual(keepaliveBodyError.code, "keepalive_body_too_large", "oversized keepalive error code");
  assertEqual(keepaliveBodyError.retryable, false, "oversized keepalive retryability");
  assertEqual(keepaliveFetchCalls, 0, "oversized keepalive should not call fetch");

  const largeBodyTransport = createFetchTransport({
    fetchImpl: async (_endpoint, init = {}) => {
      keepaliveFetchCalls += 1;
      assertEqual(init.keepalive, false, "large non-keepalive request option");
      return { status: 202 };
    },
    keepalive: false,
    maxKeepaliveBodyBytes: 64
  });
  const largeBodyResponse = await largeBodyTransport.send(clientKey, JSON.stringify({ message: "x".repeat(80) }));
  assertEqual(largeBodyResponse.statusCode, 202, "large non-keepalive status");
  assertEqual(keepaliveFetchCalls, 1, "large non-keepalive fetch call");

  const cjsKeepaliveTransport = createCjsFetchTransport({
    fetchImpl: async () => {
      throw new Error("CJS oversized keepalive should not call fetch");
    },
    maxKeepaliveBodyBytes: 16
  });
  const cjsKeepaliveError = await captureError(() => cjsKeepaliveTransport.send(
    clientKey,
    JSON.stringify({ message: "cjs-over-limit" })
  ));
  assertEqual(cjsKeepaliveError.code, "keepalive_body_too_large", "CJS oversized keepalive error code");

  const dropped = [];
  const boundedClient = createLogBrewBrowserClient({
    clientKey,
    maxQueueSize: 2,
    onEventDropped(drop) {
      dropped.push(drop);
    },
    sdkName: "logbrew-browser-fake-intake-smoke",
    sdkVersion: "0.1.0"
  });
  boundedClient.log("evt_browser_queue_001", timestamp(800), {
    level: "info",
    logger: "browser.queue",
    message: "first bounded event"
  });
  boundedClient.log("evt_browser_queue_002", timestamp(801), {
    level: "info",
    logger: "browser.queue",
    message: "second bounded event"
  });
  boundedClient.log("evt_browser_queue_003", timestamp(802), {
    level: "warning",
    logger: "browser.queue",
    message: "dropped bounded event"
  });
  assertEqual(boundedClient.pendingEvents(), 2, "bounded browser client queue count");
  assertEqual(boundedClient.droppedEvents(), 1, "bounded browser client dropped count");
  assertEqual(dropped.length, 1, "bounded browser client drop callback count");
  assertEqual(dropped[0].reason, "queue_overflow", "bounded browser client drop reason");
  assertEqual(dropped[0].eventId, "evt_browser_queue_003", "bounded browser client drop event id");

  const originalTextEncoder = globalThis.TextEncoder;
  let utf8FallbackFetchCalls = 0;
  try {
    globalThis.TextEncoder = undefined;
    const utf8FallbackTransport = createFetchTransport({
      fetchImpl: async () => {
        utf8FallbackFetchCalls += 1;
        return { status: 202 };
      },
      maxKeepaliveBodyBytes: 18
    });
    const utf8FallbackError = await captureError(() => utf8FallbackTransport.send(
      clientKey,
      JSON.stringify({ message: "€€" })
    ));
    assertEqual(utf8FallbackError.code, "keepalive_body_too_large", "UTF-8 fallback keepalive error code");
    assertEqual(utf8FallbackFetchCalls, 0, "UTF-8 fallback oversized keepalive should not call fetch");
  } finally {
    globalThis.TextEncoder = originalTextEncoder;
  }

  console.error(JSON.stringify({
    fakeIntakeAttempts: retryResponse.attempts,
    fakeIntakeEvents: retryPayload.events.length,
    fakeIntakeHighVolumeLogs: highVolumeLogs,
    fakeIntakeInvalidKey: invalidError.code,
    fakeIntakeKeepaliveBodyLimit: keepaliveBodyError.code,
    fakeIntakeKeepaliveCjs: cjsKeepaliveError.code,
    fakeIntakeQueueDrops: boundedClient.droppedEvents(),
    fakeIntakeLifecycleReason: lifecycleReason,
    fakeIntakeOnlineReason: onlineReason,
    fakeIntakeRateLimit: rateLimitError.code,
    fakeIntakeRateLimitRetryAfterMs: rateLimitError.retryAfterMs,
    fakeIntakeUtf8Fallback: utf8FallbackFetchCalls,
    fakeIntakeRequests: retryIntake.requests.length,
    fakeIntakeShutdownStatus: shutdownResponse.statusCode,
    ok: true
  }));
} finally {
  await retryIntake.close();
  await invalidIntake.close();
  await rateLimitIntake.close();
  await lifecycleIntake.close();
  await onlineIntake.close();
  await shutdownIntake.close();
}

function queueAccountRecoveryEvents(client) {
  client.release("rel_browser_fake_intake_001", timestamp(0), {
    version: "web-2026.06.22",
    metadata: baseMetadata({ serviceName: "example-web" })
  });
  client.environment("env_browser_fake_intake_001", timestamp(1), {
    name: "local-fake-intake",
    metadata: baseMetadata({ serviceName: "example-web" })
  });
  client.log("evt_browser_fake_intake_log_001", timestamp(2), {
    level: "info",
    logger: "browser.account-recovery",
    message: "account recovery started",
    metadata: baseMetadata({
      release: "web-2026.06.22",
      traceId
    })
  });
  client.issue("iss_browser_fake_intake_001", timestamp(3), {
    level: "error",
    message: "Account recovery request returned a retryable response",
    title: "Account recovery request failed",
    metadata: baseMetadata({
      recoveryStep: "send-link",
      traceId
    })
  });
  client.span("span_browser_fake_intake_001", timestamp(4), {
    durationMs: 842,
    name: "POST /api/recovery",
    parentSpanId,
    spanId: childSpanId,
    status: "error",
    traceId,
    metadata: baseMetadata({
      method: "POST",
      routeTemplate: "/api/recovery",
      statusCode: 503
    })
  });
  client.action("act_browser_fake_intake_001", timestamp(5), {
    name: "account.recovery",
    status: "failure",
    metadata: baseMetadata({
      routeTemplate: "/account/recovery",
      traceId
    })
  });
  client.metric("met_browser_fake_intake_001", timestamp(6), {
    kind: "counter",
    name: "account.recovery.attempts",
    temporality: "delta",
    unit: "attempt",
    value: 1,
    metadata: baseMetadata({
      routeTemplate: "/account/recovery",
      traceId
    })
  });
}

function baseMetadata(extra = {}) {
  return {
    environment: "local-fake-intake",
    routeTemplate: "/account/recovery",
    serviceName: "example-web",
    ...extra
  };
}

async function startFakeIntake({ expectedAuthorization, statuses }) {
  const requests = [];
  const pendingStatuses = [...statuses];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({
      authorization: request.headers.authorization,
      body,
      method: request.method,
      url: request.url
    });

    const statusEntry = pendingStatuses.length > 0 ? pendingStatuses.shift() : 202;
    const status = typeof statusEntry === "number" ? statusEntry : statusEntry.status;
    const responseHeaders = {
      "content-type": "application/json",
      ...(typeof statusEntry === "number" ? {} : statusEntry.headers ?? {})
    };
    if (request.method !== "POST" || request.url !== "/v1/events") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "not_found" }));
      return;
    }
    if (request.headers.authorization !== expectedAuthorization) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "ingest_key_invalid" }));
      return;
    }
    response.writeHead(status, responseHeaders);
    response.end(JSON.stringify({ ok: status >= 200 && status < 300 }));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    })
  };
}

function parsePayload(body) {
  if (typeof body !== "string" || body.trim() === "") {
    throw new Error("expected fake intake body");
  }
  return JSON.parse(body);
}

function assertCorrelation(payload) {
  const events = payload.events;
  if (!events.some((event) => event.type === "release")) {
    throw new Error("missing release event");
  }
  if (!events.some((event) => event.type === "environment")) {
    throw new Error("missing environment event");
  }
  if (!events.some((event) => event.type === "log" && event.attributes.logger === "browser.account-recovery")) {
    throw new Error("missing logger-correlated log event");
  }
  if (!events.some((event) => event.type === "span" && event.attributes.traceId === traceId && event.attributes.parentSpanId === parentSpanId)) {
    throw new Error("missing request trace/span correlation");
  }
  if (!events.every((event) => event.attributes.metadata?.serviceName === "example-web")) {
    throw new Error("missing primitive serviceName metadata");
  }
}

function assertNoUnsafeContent(requests) {
  for (const request of requests) {
    if (request.authorization !== `Bearer ${clientKey}`) {
      throw new Error(`unexpected auth header: ${request.authorization}`);
    }
    if (!request.body.includes("LOGBREW_BROWSER_KEY")) {
      continue;
    }
    throw new Error("payload body echoed the client key");
  }
  const body = requests.map((request) => request.body).join("\n");
  if (body.includes("dev@example.test") || body.includes("?email=") || body.includes("#section")) {
    throw new Error("payload body included query, hash, or email data");
  }
}

async function assertBrowserEventFlush({ eventType, intake, label, reason, timestampOffset }) {
  const browserWindow = createFakeBrowserWindow();
  const flushes = [];
  const context = installLogBrewBrowser({
    browserWindow,
    capturePageViews: false,
    clientKey,
    flushOnCapture: false,
    onFlush(response, browserContext, details) {
      flushes.push({
        pendingEvents: browserContext.client.pendingEvents(),
        reason: details?.reason,
        statusCode: response.statusCode
      });
    },
    sdkName: "logbrew-browser-fake-intake-smoke",
    sdkVersion: "0.1.0",
    transport: createFetchTransport({
      endpoint: `${intake.url}/v1/events`
    })
  });
  context.client.log(`evt_browser_${label}_001`, timestamp(timestampOffset), {
    level: "info",
    logger: "browser.lifecycle",
    message: `${reason} flush smoke`,
    metadata: baseMetadata({ traceId })
  });
  browserWindow.dispatchEvent(eventType);
  await waitFor(`${reason} lifecycle flush`, () => flushes.length === 1);
  assertEqual(flushes[0].reason, reason, `${reason} flush reason`);
  assertEqual(flushes[0].statusCode, 202, `${reason} flush status`);
  assertEqual(flushes[0].pendingEvents, 0, `${reason} flush queue count`);
  assertEqual(intake.requests.length, 1, `${reason} fake intake request count`);
  assertNoUnsafeContent(intake.requests);
  context.client.log(`evt_browser_${label}_002`, timestamp(timestampOffset + 1), {
    level: "info",
    logger: "browser.lifecycle",
    message: `post-uninstall ${reason} smoke`,
    metadata: baseMetadata({ traceId })
  });
  context.uninstall();
  browserWindow.dispatchEvent(eventType);
  await delay(20);
  assertEqual(flushes.length, 1, `uninstalled ${reason} should not flush`);
  return flushes[0].reason;
}

async function captureError(callback) {
  try {
    await callback();
  } catch (error) {
    return error;
  }
  throw new Error("expected callback to throw");
}

function createFakeBrowserWindow() {
  const listeners = new Map();
  const documentListeners = new Map();
  const document = {
    visibilityState: "visible",
    addEventListener(type, listener) {
      addListener(documentListeners, type, listener);
    },
    removeEventListener(type, listener) {
      removeListener(documentListeners, type, listener);
    }
  };
  return {
    document,
    addEventListener(type, listener) {
      addListener(listeners, type, listener);
    },
    removeEventListener(type, listener) {
      removeListener(listeners, type, listener);
    },
    dispatchDocumentEvent(type) {
      dispatchListeners(documentListeners, type, {});
    },
    dispatchEvent(type, event = {}) {
      dispatchListeners(listeners, type, event);
    }
  };
}

function addListener(listeners, type, listener) {
  const existing = listeners.get(type) ?? [];
  existing.push(listener);
  listeners.set(type, existing);
}

function removeListener(listeners, type, listener) {
  listeners.set(type, (listeners.get(type) ?? []).filter((candidate) => candidate !== listener));
}

function dispatchListeners(listeners, type, event) {
  for (const listener of listeners.get(type) ?? []) {
    listener(event);
  }
}

async function waitFor(label, predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await delay(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function timestamp(offsetSeconds) {
  return new Date(Date.UTC(2026, 5, 22, 10, 0, offsetSeconds)).toISOString();
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}
EOF

if ! node smoke.mjs > "$tmp_dir/browser-fake-intake.stdout.json" 2> "$tmp_dir/browser-fake-intake.stderr.json"; then
  cat "$tmp_dir/browser-fake-intake.stdout.json" >&2
  cat "$tmp_dir/browser-fake-intake.stderr.json" >&2
  exit 1
fi
grep -q '"ok":true' "$tmp_dir/browser-fake-intake.stderr.json"
grep -q '"fakeIntakeEvents":257' "$tmp_dir/browser-fake-intake.stderr.json"
grep -q '"fakeIntakeAttempts":2' "$tmp_dir/browser-fake-intake.stderr.json"
grep -q '"fakeIntakeRequests":2' "$tmp_dir/browser-fake-intake.stderr.json"
grep -q '"fakeIntakeInvalidKey":"unauthenticated"' "$tmp_dir/browser-fake-intake.stderr.json"
grep -q '"fakeIntakeLifecycleReason":"pagehide"' "$tmp_dir/browser-fake-intake.stderr.json"
grep -q '"fakeIntakeOnlineReason":"online"' "$tmp_dir/browser-fake-intake.stderr.json"
grep -q '"fakeIntakeRateLimit":"rate_limited"' "$tmp_dir/browser-fake-intake.stderr.json"
grep -q '"fakeIntakeRateLimitRetryAfterMs":2000' "$tmp_dir/browser-fake-intake.stderr.json"
grep -q '"fakeIntakeShutdownStatus":202' "$tmp_dir/browser-fake-intake.stderr.json"
grep -q '"fakeIntakeHighVolumeLogs":250' "$tmp_dir/browser-fake-intake.stderr.json"
