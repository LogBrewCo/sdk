#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
export npm_config_cache="$tmp_dir/npm-cache"
export npm_config_update_notifier=false
export npm_config_fund=false
export npm_config_audit=false
export CI=true

hosted_mode="${LOGBREW_INGEST_CONTRACT_HOSTED:-0}"
if [[ "$hosted_mode" != "0" && "$hosted_mode" != "1" ]]; then
  printf '%s\n' 'LOGBREW_INGEST_CONTRACT_HOSTED must be 0 or 1' >&2
  exit 1
fi
if [[ "$hosted_mode" == "1" ]]; then
  for variable in \
    LOGBREW_INGEST_CONTRACT_INGEST_KEY_FILE \
    LOGBREW_INGEST_CONTRACT_READ_AUTH_FILE \
    LOGBREW_INGEST_CONTRACT_PROJECT_ID
  do
    if [[ -z "${!variable:-}" ]]; then
      printf '%s is required in hosted mode\n' "$variable" >&2
      exit 1
    fi
  done
  for input_file in \
    "$LOGBREW_INGEST_CONTRACT_INGEST_KEY_FILE" \
    "$LOGBREW_INGEST_CONTRACT_READ_AUTH_FILE"
  do
    if [[ ! -f "$input_file" || ! -r "$input_file" ]]; then
      printf '%s\n' 'hosted input files must be readable regular files' >&2
      exit 1
    fi
  done
fi

cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

sdk_tgz="$(cd "$repo_root/js/logbrew-js" && npm pack --silent --pack-destination "$tmp_dir")"
node_tgz="$(cd "$repo_root/js/logbrew-node" && npm pack --silent --pack-destination "$tmp_dir")"
app_dir="$tmp_dir/app"
mkdir -p "$app_dir"

cat > "$app_dir/package.json" <<JSON
{
  "private": true,
  "type": "module",
  "dependencies": {
    "@logbrew/sdk": "file:../$sdk_tgz",
    "@logbrew/node": "file:../$node_tgz"
  }
}
JSON

cat > "$app_dir/index.mjs" <<'JS'
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

import { createLogBrewNodeClient, createNodeFetchTransport } from "@logbrew/node";

const expectedDefaultEndpoint = "https://api.logbrew.co/v1/events";
const ingestKey = "lbw_ingest_fake_node_contract_key";
const timestamp = "2026-07-09T12:00:00Z";
const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const secondTraceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const hostedMode = process.env.LOGBREW_INGEST_CONTRACT_HOSTED === "1";

function client(serverApiKey = ingestKey) {
  return createLogBrewNodeClient({
    serverApiKey,
    sdkName: "logbrew-node-ingest-contract-smoke",
    sdkVersion: "0.1.0",
  });
}

function enqueueReleaseContext(logbrew) {
  logbrew.release("evt_release_contract", timestamp, {
    version: "checkout@1.2.3",
    commit: "abc123def456",
    metadata: { service: "checkout-api" },
  });
  logbrew.environment("evt_environment_contract", timestamp, {
    name: "production",
    region: "global",
  });
}

function enqueueSignals(logbrew) {
  logbrew.issue("evt_issue_contract", timestamp, {
    title: "Checkout failed",
    level: "error",
    message: "checkout failed",
    metadata: {
      traceId,
    },
  });
  logbrew.log("evt_log_contract", timestamp, {
    message: "checkout failed",
    level: "error",
    logger: "checkout-api",
    metadata: {
      traceId,
    },
  });
  logbrew.log("evt_log_second_trace_contract", timestamp, {
    message: "another checkout started",
    level: "info",
    logger: "checkout-api",
    metadata: {
      traceId: secondTraceId,
    },
  });
  logbrew.span("evt_span_contract", timestamp, {
    name: "POST /checkout",
    traceId,
    spanId: "00f067aa0ba902b7",
    status: "error",
    durationMs: 42,
    metadata: {
      operation: "http.server",
    },
  });
  logbrew.action("evt_action_contract", timestamp, {
    name: "checkout_failed",
    status: "failure",
    metadata: {
      distinctId: "anonymous",
      traceId,
    },
  });
  logbrew.metric("evt_metric_contract", timestamp, {
    name: "checkout.duration",
    kind: "histogram",
    value: 42,
    unit: "ms",
    temporality: "delta",
    metadata: {
      traceId,
    },
  });
}

let defaultRequest;
const defaultClient = client();
enqueueReleaseContext(defaultClient);
enqueueSignals(defaultClient);
await defaultClient.flush(createNodeFetchTransport({
  fetchImpl: async (endpoint, init) => {
    defaultRequest = { endpoint, init };
    return { status: 202 };
  },
}));

assert.equal(defaultRequest.endpoint, expectedDefaultEndpoint);
assert.equal(defaultRequest.init.method, "POST");
assert.equal(defaultRequest.init.headers.authorization, `Bearer ${ingestKey}`);
assert.equal(defaultRequest.init.headers["content-type"], "application/json");

const requests = [];
let signalAttempts = 0;
const server = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const payload = JSON.parse(body);
    const isSignalBatch = payload.events.some((event) => event.type === "metric");
    if (isSignalBatch) {
      signalAttempts += 1;
    }
    requests.push({
      authorization: request.headers.authorization,
      body,
      method: request.method,
      path: request.url,
    });
    const status = isSignalBatch && signalAttempts === 1 ? 503 : 202;
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ accepted: status === 202 }));
  });
});
server.listen(0, "127.0.0.1");
await once(server, "listening");

try {
  const address = server.address();
  assert.equal(typeof address, "object");
  const endpoint = `http://127.0.0.1:${address.port}/v1/events`;
  const releaseClient = client();
  enqueueReleaseContext(releaseClient);
  const releaseResult = await releaseClient.flush(createNodeFetchTransport({
    endpoint,
  }));
  const signalClient = client();
  enqueueSignals(signalClient);
  const signalResult = await signalClient.flush(createNodeFetchTransport({
    endpoint,
  }));

  assert.deepEqual(releaseResult, { statusCode: 202, attempts: 1 });
  assert.deepEqual(signalResult, { statusCode: 202, attempts: 2 });
  assert.equal(releaseClient.pendingEvents(), 0);
  assert.equal(signalClient.pendingEvents(), 0);
  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.method, "POST");
    assert.equal(request.path, "/v1/events");
    assert.equal(request.authorization, `Bearer ${ingestKey}`);
  }

  const releasePayload = JSON.parse(requests[0].body);
  const signalPayload = JSON.parse(requests[1].body);
  const retriedSignalPayload = JSON.parse(requests[2].body);
  for (const payload of [releasePayload, signalPayload, retriedSignalPayload]) {
    assert.deepEqual(Object.keys(payload).sort(), ["events", "sdk"]);
    assert.equal(payload.sdk.name, "logbrew-node-ingest-contract-smoke");
    assert.equal(payload.sdk.language, "javascript");
    assert.equal(payload.sdk.version, "0.1.0");
    assert.equal("project_id" in payload, false);
    assert.equal("items" in payload, false);
  }
  assert.deepEqual(releasePayload.events.map((event) => event.type), ["release", "environment"]);
  assert.deepEqual(signalPayload.events.map((event) => event.type), ["issue", "log", "log", "span", "action", "metric"]);
  assert.deepEqual(signalPayload.events.map((event) => event.id), [
    "evt_issue_contract",
    "evt_log_contract",
    "evt_log_second_trace_contract",
    "evt_span_contract",
    "evt_action_contract",
    "evt_metric_contract",
  ]);
  assert.deepEqual(
    signalPayload.events.filter((event) => event.type === "log").map((event) => event.attributes.metadata.traceId),
    [traceId, secondTraceId],
  );
  assert.deepEqual(retriedSignalPayload, signalPayload);
} finally {
  server.close();
  await once(server, "close");
}

if (hostedMode) {
  const hostedIngestKey = readValueFile("LOGBREW_INGEST_CONTRACT_INGEST_KEY_FILE");
  const readAuth = readValueFile("LOGBREW_INGEST_CONTRACT_READ_AUTH_FILE");
  const projectId = requireProjectId(process.env.LOGBREW_INGEST_CONTRACT_PROJECT_ID);
  const hostedTransport = createNodeFetchTransport();

  const hostedReleaseClient = client(hostedIngestKey);
  enqueueReleaseContext(hostedReleaseClient);
  const hostedReleaseResult = await hostedReleaseClient.flush(hostedTransport);
  assert.ok(hostedReleaseResult.statusCode >= 200 && hostedReleaseResult.statusCode < 300);

  const hostedSignalClient = client(hostedIngestKey);
  enqueueSignals(hostedSignalClient);
  const hostedSignalResult = await hostedSignalClient.flush(hostedTransport);
  assert.ok(hostedSignalResult.statusCode >= 200 && hostedSignalResult.statusCode < 300);

  const apiOrigin = new URL(expectedDefaultEndpoint).origin;
  const readOptions = {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${readAuth}`,
    },
  };
  const release = "checkout@1.2.3";
  const environment = "production";
  const serviceName = "checkout-api";

  await waitForReadback("issue", async () => {
    const rows = await readJson(apiUrl(apiOrigin, "/api/telemetry/issues", {
      environment,
      limit: "100",
      project_id: projectId,
      release,
    }), readOptions);
    return Array.isArray(rows) && rows.some((row) => (
      row.title === "Checkout failed"
      && row.trace_id === traceId
      && row.release === release
      && row.environment === environment
      && row.service_name === serviceName
    ));
  });
  await waitForReadback("logs", async () => {
    const firstTraceLogs = await readJson(apiUrl(apiOrigin, "/api/logs", {
      environment,
      limit: "100",
      project_id: projectId,
      release,
      search: "checkout",
      trace_id: traceId,
    }), readOptions);
    const secondTraceLogs = await readJson(apiUrl(apiOrigin, "/api/logs", {
      environment,
      limit: "100",
      project_id: projectId,
      release,
      search: "checkout",
      trace_id: secondTraceId,
    }), readOptions);
    return [firstTraceLogs, secondTraceLogs].every((rows, index) => (
      Array.isArray(rows)
      && rows.some((row) => (
        row.trace_id === [traceId, secondTraceId][index]
        && row.release === release
        && row.environment === environment
        && row.service_name === serviceName
      ))
    ));
  });
  await waitForReadback("trace", async () => {
    const rows = await readJson(apiUrl(apiOrigin, `/api/telemetry/traces/${traceId}`, {
      environment,
      project_id: projectId,
      release,
    }), readOptions);
    return Array.isArray(rows) && rows.some((row) => (
      row.span_id === "00f067aa0ba902b7"
      && row.release === release
      && row.environment === environment
      && row.service_name === serviceName
    ));
  });
  await waitForReadback("action", async () => {
    const rows = await readJson(apiUrl(apiOrigin, "/api/telemetry/actions", {
      environment,
      limit: "100",
      name: "checkout_failed",
      project_id: projectId,
      release,
    }), readOptions);
    return Array.isArray(rows) && rows.some((row) => (
      row.trace_id === traceId
      && row.release === release
      && row.environment === environment
    ));
  });
  await waitForReadback("metric", async () => {
    const rows = await readJson(apiUrl(apiOrigin, "/api/telemetry/metrics", {
      limit: "100",
      name: "checkout.duration",
      project_id: projectId,
    }), readOptions);
    return Array.isArray(rows) && rows.some((row) => (
      row.event_id === "evt_metric_contract"
      && row.trace_id === traceId
      && row.release === release
      && row.environment === environment
      && row.service_name === serviceName
    ));
  });
  await waitForReadback("release", async () => {
    const rows = await readJson(apiUrl(apiOrigin, "/api/telemetry/releases", {
      environment,
      limit: "100",
      project_id: projectId,
      release,
    }), readOptions);
    return Array.isArray(rows) && rows.some((row) => (
      row.release === release
      && row.environment === environment
      && row.service_name === serviceName
      && row.issue_count >= 1
      && row.log_count >= 2
      && row.trace_span_count >= 1
      && row.action_count >= 1
      && row.metric_count >= 1
    ));
  });

  process.stdout.write('{"status":"ok","contract":"node-v1-events","hosted":"verified"}\n');
} else {
  process.stdout.write('{"status":"ok","contract":"node-v1-events"}\n');
}

function readValueFile(variable) {
  const path = process.env[variable];
  assert.ok(path, `${variable} is required`);
  const value = readFileSync(path, "utf8").trim();
  assert.ok(value, `${variable} must point to a non-empty file`);
  return value;
}

function requireProjectId(value) {
  assert.match(value ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
  return value;
}

function apiUrl(origin, path, params) {
  const url = new URL(path, origin);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url;
}

async function readJson(url, options) {
  const response = await fetch(url, options);
  assert.equal(response.status, 200, "hosted readback request failed");
  return response.json();
}

async function waitForReadback(label, probe) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await probe()) {
      return;
    }
    await delay(500);
  }
  throw new Error(`${label} readback was not visible within the bounded polling window`);
}
JS

(
  cd "$app_dir"
  npm install --silent --ignore-scripts
  npm ls @logbrew/sdk @logbrew/node >/dev/null
  node index.mjs
)
