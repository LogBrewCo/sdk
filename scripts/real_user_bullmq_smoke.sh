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
bullmq_pack_json="$tmp_dir/bullmq-pack.json"
(cd "$repo_root/js/logbrew-js" && npm pack --json --pack-destination "$tmp_dir") > "$core_pack_json"
(cd "$repo_root/js/logbrew-node" && npm pack --json --pack-destination "$tmp_dir") > "$node_pack_json"
(cd "$repo_root/js/logbrew-bullmq" && npm pack --json --pack-destination "$tmp_dir") > "$bullmq_pack_json"

package_tgz() {
  python3 - "$1" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
print(payload[0]["filename"])
PY
}

core_tgz="$tmp_dir/$(package_tgz "$core_pack_json")"
node_tgz="$tmp_dir/$(package_tgz "$node_pack_json")"
bullmq_tgz="$tmp_dir/$(package_tgz "$bullmq_pack_json")"
test -f "$core_tgz"
test -f "$node_tgz"
test -f "$bullmq_tgz"

tar -tzf "$bullmq_tgz" > "$tmp_dir/bullmq-tarball.txt"
grep -q '^package/README.md$' "$tmp_dir/bullmq-tarball.txt"
grep -q '^package/index.js$' "$tmp_dir/bullmq-tarball.txt"
grep -q '^package/index.cjs$' "$tmp_dir/bullmq-tarball.txt"
grep -q '^package/index.d.ts$' "$tmp_dir/bullmq-tarball.txt"
grep -q '^package/index.d.cts$' "$tmp_dir/bullmq-tarball.txt"
grep -q '^package/examples/index.mjs$' "$tmp_dir/bullmq-tarball.txt"
grep -q '^package/examples/readme-example.mjs$' "$tmp_dir/bullmq-tarball.txt"
grep -q '^package/examples/real-user-smoke.mjs$' "$tmp_dir/bullmq-tarball.txt"
tar -xOf "$bullmq_tgz" package/README.md > "$tmp_dir/bullmq-readme.md"
grep -q 'npm install @logbrew/sdk @logbrew/node @logbrew/bullmq bullmq' "$tmp_dir/bullmq-readme.md"
grep -q 'pnpm add @logbrew/sdk @logbrew/node @logbrew/bullmq bullmq' "$tmp_dir/bullmq-readme.md"
grep -q 'LOGBREW_SERVER_API_KEY' "$tmp_dir/bullmq-readme.md"
grep -q 'project-scoped server ingest key' "$tmp_dir/bullmq-readme.md"
grep -q 'instrumentLogBrewBullMqProcessor' "$tmp_dir/bullmq-readme.md"
grep -q 'withLogBrewBullMqProcessor' "$tmp_dir/bullmq-readme.md"

app_dir="$tmp_dir/bullmq-smoke-app"
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
  "$bullmq_tgz" \
  bullmq@5.79.1 \
  typescript@6.0.3 \
  @types/node@26.0.1 \
  >/dev/null

grep -q '"@logbrew/sdk": "file:' package.json
grep -q '"@logbrew/node": "file:' package.json
grep -q '"@logbrew/bullmq": "file:' package.json
grep -q '"bullmq": "5.79.1"' package.json
grep -q '"@logbrew/bullmq"' package-lock.json
grep -q '"@logbrew/node"' package-lock.json
grep -q '"@logbrew/sdk"' package-lock.json
npm ls @logbrew/sdk @logbrew/node @logbrew/bullmq bullmq >/dev/null
npm list --depth=0 > "$tmp_dir/npm-list-depth0.txt"
grep -q "@logbrew/sdk@${sdk_package_version}" "$tmp_dir/npm-list-depth0.txt"
grep -q '@logbrew/node@0.1.0' "$tmp_dir/npm-list-depth0.txt"
grep -q '@logbrew/bullmq@0.1.0' "$tmp_dir/npm-list-depth0.txt"
grep -q 'bullmq@5.79.1' "$tmp_dir/npm-list-depth0.txt"
test -f node_modules/@logbrew/bullmq/index.js
test -f node_modules/@logbrew/bullmq/index.cjs
test -f node_modules/@logbrew/bullmq/index.d.ts

cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "noEmit": true,
    "strict": true,
    "target": "ES2022"
  },
  "include": ["types.ts"]
}
EOF

cat > types.ts <<'EOF'
import type { Job, Queue } from "bullmq";
import { LogBrewClient } from "@logbrew/sdk";
import {
  bullMqQueueAddBulkWithLogBrewSpan,
  bullMqQueueAddWithLogBrewSpan,
  createLogBrewBullMqJobOptions,
  extractLogBrewBullMqTraceparent,
  instrumentLogBrewBullMqProcessor,
  instrumentLogBrewBullMqQueue,
  withLogBrewBullMqProcessor
} from "@logbrew/bullmq";

const client = LogBrewClient.create({
  apiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "bullmq-type-smoke",
  sdkVersion: "0.1.0"
});
declare const queue: Pick<Queue<{ orderId: string }, string, "charge-card">, "add" | "addBulk" | "name">;
declare const job: Job<{ orderId: string }, string, "charge-card">;

const addJob = bullMqQueueAddWithLogBrewSpan(queue, "charge-card", { orderId: "ord_123" }, {}, { client });
const bulkJobs = bullMqQueueAddBulkWithLogBrewSpan(queue, [{ name: "charge-card", data: { orderId: "ord_124" } }], { client });
const processor = withLogBrewBullMqProcessor(async (currentJob: Job<{ orderId: string }, string, "charge-card">) => currentJob.data.orderId, { client });
class NestWorkerHostStyleProcessor {
  calls: string[] = [];

  async process(currentJob: Job<{ orderId: string }, string, "charge-card">, lock?: string, signal?: AbortSignal, extra?: string): Promise<string> {
    this.calls.push(`${currentJob.name}:${lock ?? "none"}:${signal?.aborted ?? false}:${extra ?? "none"}`);
    return currentJob.data.orderId;
  }
}
const nestProcessor = new NestWorkerHostStyleProcessor();
const processorMethodInstrumentation = instrumentLogBrewBullMqProcessor(nestProcessor, { client });
const instrumentation = instrumentLogBrewBullMqQueue(queue, { client });
const traceparent = extractLogBrewBullMqTraceparent(job);
const options = createLogBrewBullMqJobOptions({}, "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");

void addJob;
void bulkJobs;
void instrumentation;
void nestProcessor;
void processor;
void processorMethodInstrumentation;
void traceparent;
void options;
EOF

npx tsc --noEmit

cat > cjs-smoke.cjs <<'EOF'
const logbrewBullMq = require("@logbrew/bullmq");

if (typeof logbrewBullMq.withLogBrewBullMqProcessor !== "function") {
  throw new Error("missing CommonJS processor export");
}
if (typeof logbrewBullMq.instrumentLogBrewBullMqProcessor !== "function") {
  throw new Error("missing CommonJS processor instrumentation export");
}
if (typeof logbrewBullMq.instrumentLogBrewBullMqQueue !== "function") {
  throw new Error("missing CommonJS queue instrumentation export");
}
if (typeof logbrewBullMq.default.bullMqQueueAddWithLogBrewSpan !== "function") {
  throw new Error("missing CommonJS default export");
}
EOF

node cjs-smoke.cjs

cat > smoke.mjs <<'EOF'
import http from "node:http";
import { once } from "node:events";
import { LogBrewClient } from "@logbrew/sdk";
import { createNodeFetchTransport } from "@logbrew/node";
import {
  bullMqQueueAddBulkWithLogBrewSpan,
  bullMqQueueAddWithLogBrewSpan,
  createLogBrewBullMqJobOptions,
  extractLogBrewBullMqTraceparent,
  instrumentLogBrewBullMqProcessor,
  instrumentLogBrewBullMqQueue,
  withLogBrewBullMqProcessor
} from "@logbrew/bullmq";

const serverApiKey = "LOGBREW_SERVER_API_KEY";
const client = LogBrewClient.create({
  apiKey: serverApiKey,
  maxRetries: 1,
  sdkName: "bullmq-smoke-app",
  sdkVersion: "0.1.0"
});
const queueCalls = [];
const queue = {
  name: "email",
  async add(name, data, opts) {
    queueCalls.push({ data, name, opts, type: "add" });
    return { data, name, opts, queue: { name: "email" }, queueName: "email" };
  },
  async addBulk(jobs) {
    queueCalls.push({ jobs, type: "addBulk" });
    return jobs.map((job) => ({ ...job, queue: { name: "email" }, queueName: "email" }));
  }
};

const job = await bullMqQueueAddWithLogBrewSpan(queue, "welcome", { body: "example-body" }, {
  attempts: 2,
  telemetry: {
    metadata: JSON.stringify({ app: "mail" })
  }
}, {
  client,
  id: "evt_bullmq_add_001",
  now: () => "2026-06-25T10:00:00Z",
  nowMs: () => 10,
  spanIdFactory: () => "1111111111111111",
  traceIdFactory: () => "22222222222222222222222222222222"
});

const traceparent = extractLogBrewBullMqTraceparent(job);
assertEqual(traceparent, "00-22222222222222222222222222222222-1111111111111111-01", "producer traceparent");
const metadata = JSON.parse(queueCalls[0].opts.telemetry.metadata);
assertEqual(metadata.app, "mail", "existing metadata preserved");
assertEqual(metadata.logbrew.traceparent, traceparent, "LogBrew metadata injected");
assertEqual(job.data.body, "example-body", "queue payload preserved for app");

const processed = await withLogBrewBullMqProcessor(async (currentJob) => {
  assertEqual(currentJob.name, "welcome", "processor job name");
  return "processed";
}, {
  client,
  id: "evt_bullmq_process_001",
  now: () => "2026-06-25T10:00:01Z",
  nowMs: () => 30,
  spanIdFactory: () => "3333333333333333"
})(job, "worker-lock", new AbortController().signal);
assertEqual(processed, "processed", "processor result");

class NestWorkerHostStyleProcessor {
  constructor() {
    this.calls = [];
  }

  async process(currentJob, lock, signal, extra) {
    this.calls.push({
      extra,
      lock,
      name: currentJob.name,
      signalAborted: signal?.aborted ?? false,
      thisValue: this
    });
    return `method:${currentJob.name}:${extra}`;
  }
}
const nestProcessor = new NestWorkerHostStyleProcessor();
const originalNestProcess = nestProcessor.process;
assertEqual(Object.prototype.hasOwnProperty.call(nestProcessor, "process"), false, "processor method starts on prototype");
const nestProcessorInstrumentation = instrumentLogBrewBullMqProcessor(nestProcessor, {
  client,
  id: "evt_bullmq_processor_method_001",
  now: () => "2026-06-25T10:00:01.500Z",
  nowMs: () => 45,
  spanIdFactory: () => "1212121212121212"
});
assertEqual(nestProcessorInstrumentation.isInstalled(), true, "processor method instrumentation installed");
const methodResult = await nestProcessor.process(job, "nest-lock", new AbortController().signal, "extra-arg");
assertEqual(methodResult, "method:welcome:extra-arg", "processor method result");
assertEqual(nestProcessor.calls[0].thisValue, nestProcessor, "processor method this");
assertEqual(nestProcessor.calls[0].lock, "nest-lock", "processor method lock");
assertEqual(nestProcessor.calls[0].extra, "extra-arg", "processor method extra arg");

try {
  instrumentLogBrewBullMqProcessor(nestProcessor, { client });
  throw new Error("expected duplicate BullMQ processor instrumentation to fail");
} catch (error) {
  assertEqual(error.code, "configuration_error", "duplicate processor instrumentation code");
}

nestProcessorInstrumentation.uninstall();
assertEqual(nestProcessorInstrumentation.isInstalled(), false, "processor method instrumentation uninstalled");
assertEqual(Object.prototype.hasOwnProperty.call(nestProcessor, "process"), false, "processor method back on prototype");
assertEqual(nestProcessor.process, originalNestProcess, "prior processor method active after uninstall");
await nestProcessor.process({ name: "after-uninstall" }, undefined, undefined, "raw");

const malformedMetadataJob = {
  name: "malformed",
  opts: { telemetry: { metadata: "{not-json" } },
  queueName: "email"
};
const malformedResult = await withLogBrewBullMqProcessor(async () => "fallback", {
  client,
  id: "evt_bullmq_malformed_001",
  now: () => "2026-06-25T10:00:02Z",
  spanIdFactory: () => "4444444444444444",
  traceIdFactory: () => "55555555555555555555555555555555"
})(malformedMetadataJob);
assertEqual(malformedResult, "fallback", "malformed metadata fallback");

try {
  await withLogBrewBullMqProcessor(async () => {
    throw new TypeError("processor failure sample detail");
  }, {
    client,
    id: "evt_bullmq_process_error_001",
    now: () => "2026-06-25T10:00:03Z",
    spanIdFactory: () => "6666666666666666"
  })(job);
  throw new Error("expected processor failure");
} catch (error) {
  if (!(error instanceof TypeError)) {
    throw error;
  }
}

const bulkJobs = await bullMqQueueAddBulkWithLogBrewSpan(queue, [
  { name: "welcome", data: { body: "example-bulk-1" } },
  { name: "digest", data: { body: "example-bulk-2" }, opts: { telemetry: { metadata: JSON.stringify({ batch: true }) } } }
], {
  client,
  id: "evt_bullmq_add_bulk_001",
  now: () => "2026-06-25T10:00:04Z",
  nowMs: () => 70,
  spanIdFactory: () => "7777777777777777",
  traceIdFactory: () => "88888888888888888888888888888888"
});
assertEqual(bulkJobs.length, 2, "bulk result count");
const bulkCall = queueCalls.find((call) => call.type === "addBulk");
assertEqual(bulkCall.jobs.length, 2, "bulk queue call count");
if (!extractLogBrewBullMqTraceparent({ opts: bulkCall.jobs[0].opts })) {
  throw new Error("missing bulk job traceparent");
}
assertEqual(JSON.parse(bulkCall.jobs[1].opts.telemetry.metadata).batch, true, "bulk metadata preserved");

const invalidStandalone = createLogBrewBullMqJobOptions({
  telemetry: { metadata: "{not-json" }
}, "00-99999999999999999999999999999999-aaaaaaaaaaaaaaaa-01");
assertEqual(invalidStandalone.telemetry.metadata, "{not-json", "invalid standalone metadata preserved");

const intakeRequests = [];
const intakeServer = http.createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    intakeRequests.push({ authorization: req.headers.authorization, body, url: req.url });
    res.statusCode = intakeRequests.length === 1 ? 503 : 202;
    res.end("accepted");
  });
});
intakeServer.listen(0, "127.0.0.1");
await once(intakeServer, "listening");
const response = await client.flush(createNodeFetchTransport({
  endpoint: `http://127.0.0.1:${intakeServer.address().port}/v1/events`
}));
await closeServer(intakeServer);

assertEqual(response.statusCode, 202, "flush status");
assertEqual(response.attempts, 2, "retry attempts");
assertEqual(intakeRequests.length, 2, "retry request count");
assertEqual(intakeRequests[0].authorization, `Bearer ${serverApiKey}`, "auth header");
assertEqual(intakeRequests[1].url, "/v1/events", "path-only fake intake");

const payload = JSON.parse(intakeRequests.at(-1).body);
assertEqual(payload.sdk.name, "bullmq-smoke-app", "sdk name");
assertEqual(payload.events.length, 6, "span event count");
const producerSpan = payload.events.find((event) => event.id === "evt_bullmq_add_001").attributes;
assertEqual(producerSpan.name, "bullmq publish add", "producer span name");
assertEqual(producerSpan.metadata.framework, "node:queue", "producer framework");
assertEqual(producerSpan.metadata["messaging.system"], "bullmq", "producer messaging system");
assertEqual(producerSpan.metadata["messaging.operation.type"], "publish", "producer operation type");
assertEqual(producerSpan.metadata["messaging.destination.name"], "email", "producer destination");
assertEqual(producerSpan.metadata.taskName, "welcome", "producer task name");
if (JSON.stringify(producerSpan).includes("example-body")) {
  throw new Error("producer span leaked job payload");
}

const consumerSpan = payload.events.find((event) => event.id === "evt_bullmq_process_001").attributes;
assertEqual(consumerSpan.traceId, "22222222222222222222222222222222", "consumer trace id");
assertEqual(consumerSpan.parentSpanId, "1111111111111111", "consumer parent span id");
assertEqual(consumerSpan.metadata["messaging.operation.type"], "process", "consumer operation type");

const processorMethodSpan = payload.events.find((event) => event.id === "evt_bullmq_processor_method_001").attributes;
assertEqual(processorMethodSpan.traceId, "22222222222222222222222222222222", "processor method trace id");
assertEqual(processorMethodSpan.parentSpanId, "1111111111111111", "processor method parent span id");
assertEqual(processorMethodSpan.metadata["messaging.destination.name"], "email", "processor method destination");
assertEqual(processorMethodSpan.metadata["messaging.operation.type"], "process", "processor method operation type");
assertEqual(processorMethodSpan.metadata.taskName, "welcome", "processor method task name");

const malformedSpan = payload.events.find((event) => event.id === "evt_bullmq_malformed_001").attributes;
assertEqual(malformedSpan.traceId, "55555555555555555555555555555555", "malformed fallback trace id");

const errorSpan = payload.events.find((event) => event.id === "evt_bullmq_process_error_001").attributes;
assertEqual(errorSpan.status, "error", "processor error status");
assertEqual(errorSpan.events[0].metadata.exceptionType, "TypeError", "processor exception type");
assertEqual(errorSpan.metadata.errorType, "TypeError", "processor error metadata");
if (JSON.stringify(errorSpan).includes("processor failure sample detail")) {
  throw new Error("processor error message leaked");
}

const bulkSpan = payload.events.find((event) => event.id === "evt_bullmq_add_bulk_001").attributes;
assertEqual(bulkSpan.metadata["messaging.batch.message_count"], 2, "bulk semantic count");
assertEqual(bulkSpan.metadata.messageCount, 2, "bulk metadata count");
if (JSON.stringify(payload).includes("example-bulk") || JSON.stringify(payload).includes("example-body")) {
  throw new Error("job payload leaked into telemetry body");
}

const instrumentedQueueCalls = [];
const instrumentedQueue = {
  name: "notifications",
  async add(name, data, opts) {
    instrumentedQueueCalls.push({ data, name, opts, thisValue: this, type: "add" });
    return { data, name, opts, queueName: "notifications" };
  },
  async addBulk(jobs) {
    instrumentedQueueCalls.push({ jobs, thisValue: this, type: "addBulk" });
    return jobs.map((currentJob) => ({ ...currentJob, queueName: "notifications" }));
  }
};
const priorInstrumentedAdd = instrumentedQueue.add;
const priorInstrumentedAddBulk = instrumentedQueue.addBulk;
const instrumentation = instrumentLogBrewBullMqQueue(instrumentedQueue, {
  client,
  now: () => "2026-06-25T10:00:05Z",
  nowMs: () => 90,
  spanIdFactory: nextSpanId(["9999999999999999", "aaaaaaaaaaaaaaaa"]),
  traceIdFactory: nextTraceId(["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "cccccccccccccccccccccccccccccccc"])
});
assertEqual(instrumentation.isInstalled(), true, "instrumentation installed");

const instrumentedJob = await instrumentedQueue.add("receipt", { body: "instrumented-payload" }, {});
assertEqual(instrumentedQueueCalls[0].thisValue, instrumentedQueue, "instrumented add this");
assertEqual(
  extractLogBrewBullMqTraceparent(instrumentedJob),
  "00-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-9999999999999999-01",
  "instrumented add traceparent"
);

await instrumentedQueue.addBulk([
  { name: "receipt-bulk", data: { body: "instrumented-bulk" } }
]);
const instrumentedBulkCall = instrumentedQueueCalls.find((call) => call.type === "addBulk");
if (!extractLogBrewBullMqTraceparent({ opts: instrumentedBulkCall.jobs[0].opts })) {
  throw new Error("instrumented addBulk did not inject traceparent");
}

try {
  instrumentLogBrewBullMqQueue(instrumentedQueue, { client });
  throw new Error("expected duplicate BullMQ instrumentation to fail");
} catch (error) {
  assertEqual(error.code, "configuration_error", "duplicate instrumentation code");
}

instrumentation.uninstall();
assertEqual(instrumentation.isInstalled(), false, "instrumentation uninstalled");
assertEqual(instrumentedQueue.add, priorInstrumentedAdd, "prior add active after uninstall");
assertEqual(instrumentedQueue.addBulk, priorInstrumentedAddBulk, "prior addBulk active after uninstall");
await instrumentedQueue.add("after-uninstall", { body: "after uninstall" }, {});
if (instrumentedQueueCalls.at(-1).opts?.telemetry?.metadata) {
  throw new Error("BullMQ instrumentation kept modifying jobs after uninstall");
}

const restartIntakeRequests = [];
const restartIntakeServer = http.createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    restartIntakeRequests.push({ body });
    res.statusCode = 202;
    res.end("accepted");
  });
});
restartIntakeServer.listen(0, "127.0.0.1");
await once(restartIntakeServer, "listening");
const postInstrumentationResponse = await client.flush(createNodeFetchTransport({
  endpoint: `http://127.0.0.1:${restartIntakeServer.address().port}/v1/events`
}));
await closeServer(restartIntakeServer);

assertEqual(postInstrumentationResponse.statusCode, 202, "post-instrumentation flush status");
assertEqual(postInstrumentationResponse.attempts, 1, "post-instrumentation attempts");
assertEqual(restartIntakeRequests.length, 1, "post-instrumentation request count");
const instrumentationPayload = JSON.parse(restartIntakeRequests.at(-1).body);
assertEqual(instrumentationPayload.events.length, 2, "instrumented queue span count");
const instrumentedAddSpan = instrumentationPayload.events.find((event) => event.attributes.name === "bullmq publish add").attributes;
assertEqual(instrumentedAddSpan.metadata["messaging.destination.name"], "notifications", "instrumented queue destination");
const instrumentedBulkSpan = instrumentationPayload.events.find((event) => event.attributes.name === "bullmq publish addBulk").attributes;
assertEqual(instrumentedBulkSpan.metadata.messageCount, 1, "instrumented bulk count");
if (JSON.stringify(instrumentationPayload).includes("instrumented-payload") || JSON.stringify(instrumentationPayload).includes("instrumented-bulk")) {
  throw new Error("instrumented queue payload leaked into telemetry body");
}

console.log(JSON.stringify({
  attempts: response.attempts + postInstrumentationResponse.attempts,
  events: payload.events.length + instrumentationPayload.events.length,
  ok: true,
  package: "@logbrew/bullmq"
}));

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function nextSpanId(values) {
  let index = 0;
  return () => values[index++] ?? "dddddddddddddddd";
}

function nextTraceId(values) {
  let index = 0;
  return () => values[index++] ?? "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
}
EOF

node smoke.mjs

printf '%s\n' "BullMQ real-user smoke passed"
