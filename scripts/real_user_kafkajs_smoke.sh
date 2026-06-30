#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sdk_package_version="$(node -p "require('${repo_root}/js/logbrew-js/package.json').version")"
node_package_version="$(node -p "require('${repo_root}/js/logbrew-node/package.json').version")"
kafkajs_package_version="$(node -p "require('${repo_root}/js/logbrew-kafkajs/package.json').version")"
tmp_dir="$(mktemp -d)"
export npm_config_cache="$tmp_dir/npm-cache"

remove_tmp_dir() {
  rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT

core_pack_json="$tmp_dir/core-pack.json"
node_pack_json="$tmp_dir/node-pack.json"
kafkajs_pack_json="$tmp_dir/kafkajs-pack.json"
(cd "$repo_root/js/logbrew-js" && npm pack --json --pack-destination "$tmp_dir") > "$core_pack_json"
(cd "$repo_root/js/logbrew-node" && npm pack --json --pack-destination "$tmp_dir") > "$node_pack_json"
(cd "$repo_root/js/logbrew-kafkajs" && npm pack --json --pack-destination "$tmp_dir") > "$kafkajs_pack_json"

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
kafkajs_tgz="$tmp_dir/$(package_tgz "$kafkajs_pack_json")"
test -f "$core_tgz"
test -f "$node_tgz"
test -f "$kafkajs_tgz"

tar -tzf "$kafkajs_tgz" > "$tmp_dir/kafkajs-tarball.txt"
grep -q '^package/README.md$' "$tmp_dir/kafkajs-tarball.txt"
grep -q '^package/index.js$' "$tmp_dir/kafkajs-tarball.txt"
grep -q '^package/index.cjs$' "$tmp_dir/kafkajs-tarball.txt"
grep -q '^package/index.d.ts$' "$tmp_dir/kafkajs-tarball.txt"
grep -q '^package/index.d.cts$' "$tmp_dir/kafkajs-tarball.txt"
grep -q '^package/examples/index.mjs$' "$tmp_dir/kafkajs-tarball.txt"
grep -q '^package/examples/readme-example.mjs$' "$tmp_dir/kafkajs-tarball.txt"
grep -q '^package/examples/real-user-smoke.mjs$' "$tmp_dir/kafkajs-tarball.txt"
tar -xOf "$kafkajs_tgz" package/README.md > "$tmp_dir/kafkajs-readme.md"
grep -q 'npm install @logbrew/sdk @logbrew/node @logbrew/kafkajs kafkajs' "$tmp_dir/kafkajs-readme.md"
grep -q 'pnpm add @logbrew/sdk @logbrew/node @logbrew/kafkajs kafkajs' "$tmp_dir/kafkajs-readme.md"
grep -q 'LOGBREW_SERVER_API_KEY' "$tmp_dir/kafkajs-readme.md"
grep -q 'project-scoped server ingest key' "$tmp_dir/kafkajs-readme.md"
grep -q 'instrumentLogBrewKafkaJsProducer' "$tmp_dir/kafkajs-readme.md"
grep -q 'instrumentLogBrewKafkaJsConsumer' "$tmp_dir/kafkajs-readme.md"
grep -q 'withLogBrewKafkaJsEachMessage' "$tmp_dir/kafkajs-readme.md"
grep -q 'withLogBrewKafkaJsEachBatch' "$tmp_dir/kafkajs-readme.md"

app_dir="$tmp_dir/kafkajs-smoke-app"
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
  "$kafkajs_tgz" \
  kafkajs@2.2.4 \
  typescript@6.0.3 \
  @types/node@26.0.1 \
  >/dev/null

grep -q '"@logbrew/sdk": "file:' package.json
grep -q '"@logbrew/node": "file:' package.json
grep -q '"@logbrew/kafkajs": "file:' package.json
grep -q '"kafkajs": "2.2.4"' package.json
grep -q '"@logbrew/kafkajs"' package-lock.json
grep -q '"@logbrew/node"' package-lock.json
grep -q '"@logbrew/sdk"' package-lock.json
npm ls @logbrew/sdk @logbrew/node @logbrew/kafkajs kafkajs >/dev/null
npm list --depth=0 > "$tmp_dir/npm-list-depth0.txt"
grep -q "@logbrew/sdk@${sdk_package_version}" "$tmp_dir/npm-list-depth0.txt"
grep -q "@logbrew/node@${node_package_version}" "$tmp_dir/npm-list-depth0.txt"
grep -q "@logbrew/kafkajs@${kafkajs_package_version}" "$tmp_dir/npm-list-depth0.txt"
grep -q 'kafkajs@2.2.4' "$tmp_dir/npm-list-depth0.txt"
test -f node_modules/@logbrew/kafkajs/index.js
test -f node_modules/@logbrew/kafkajs/index.cjs
test -f node_modules/@logbrew/kafkajs/index.d.ts

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
import type { EachBatchPayload, EachMessagePayload, Producer, ProducerBatch, ProducerRecord } from "kafkajs";
import { LogBrewClient } from "@logbrew/sdk";
import {
  createLogBrewKafkaJsMessage,
  createLogBrewKafkaJsProducerBatch,
  createLogBrewKafkaJsProducerRecord,
  extractLogBrewKafkaJsTraceparent,
  instrumentLogBrewKafkaJsConsumer,
  instrumentLogBrewKafkaJsProducer,
  kafkaJsProducerSendBatchWithLogBrewSpan,
  kafkaJsProducerSendWithLogBrewSpan,
  withLogBrewKafkaJsEachBatch,
  withLogBrewKafkaJsEachMessage
} from "@logbrew/kafkajs";

const client = LogBrewClient.create({
  apiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "kafkajs-type-smoke",
  sdkVersion: "0.1.0"
});
declare const producer: Pick<Producer, "send" | "sendBatch">;
declare const messagePayload: EachMessagePayload;
declare const batchPayload: EachBatchPayload;

const record: ProducerRecord = { topic: "checkout.events", messages: [{ value: "example" }] };
const batch: ProducerBatch = { topicMessages: [{ topic: "checkout.events", messages: [{ value: "example" }] }] };
const sendResult = kafkaJsProducerSendWithLogBrewSpan(producer, record, { client });
const batchResult = kafkaJsProducerSendBatchWithLogBrewSpan(producer, batch, { client });
const wrappedMessage = withLogBrewKafkaJsEachMessage(async (payload: EachMessagePayload) => payload.message.offset, { client });
const wrappedBatch = withLogBrewKafkaJsEachBatch(async (payload: EachBatchPayload) => payload.batch.topic, { client });
const instrumentedProducer = instrumentLogBrewKafkaJsProducer(producer, { client });
const instrumentedConsumer = instrumentLogBrewKafkaJsConsumer({
  run: async (config) => {
    await config?.eachMessage?.(messagePayload);
  }
}, { client });
const nextRecord = createLogBrewKafkaJsProducerRecord(record, "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
const nextBatch = createLogBrewKafkaJsProducerBatch(batch, "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
const nextMessage = createLogBrewKafkaJsMessage({ value: "example" }, "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
const traceparent = extractLogBrewKafkaJsTraceparent(nextMessage);

void sendResult;
void batchResult;
void wrappedMessage(messagePayload);
void wrappedBatch(batchPayload);
void instrumentedProducer.uninstall();
void instrumentedConsumer.uninstall();
void nextRecord;
void nextBatch;
void traceparent;
EOF

npx tsc --noEmit

cat > cjs-smoke.cjs <<'EOF'
const logbrewKafkaJs = require("@logbrew/kafkajs");

if (typeof logbrewKafkaJs.kafkaJsProducerSendWithLogBrewSpan !== "function") {
  throw new Error("missing CommonJS send export");
}
if (typeof logbrewKafkaJs.default.withLogBrewKafkaJsEachBatch !== "function") {
  throw new Error("missing CommonJS default export");
}
if (typeof logbrewKafkaJs.instrumentLogBrewKafkaJsProducer !== "function") {
  throw new Error("missing CommonJS producer instrumentation export");
}
if (typeof logbrewKafkaJs.default.instrumentLogBrewKafkaJsConsumer !== "function") {
  throw new Error("missing CommonJS default consumer instrumentation export");
}
EOF

node cjs-smoke.cjs

cat > smoke.mjs <<'EOF'
import http from "node:http";
import { once } from "node:events";
import { Kafka } from "kafkajs";
import { LogBrewClient } from "@logbrew/sdk";
import { createNodeFetchTransport } from "@logbrew/node";
import {
  extractLogBrewKafkaJsTraceparent,
  instrumentLogBrewKafkaJsConsumer,
  instrumentLogBrewKafkaJsProducer,
  kafkaJsProducerSendBatchWithLogBrewSpan,
  kafkaJsProducerSendWithLogBrewSpan,
  withLogBrewKafkaJsEachBatch,
  withLogBrewKafkaJsEachMessage
} from "@logbrew/kafkajs";

if (typeof Kafka !== "function") {
  throw new Error("KafkaJS package did not install");
}

const serverApiKey = "LOGBREW_SERVER_API_KEY";
const client = LogBrewClient.create({
  apiKey: serverApiKey,
  maxRetries: 1,
  sdkName: "kafkajs-smoke-app",
  sdkVersion: "0.1.0"
});
const sentRecords = [];
const sentBatches = [];
const producer = {
  async send(record) {
    sentRecords.push(record);
    return [{ topicName: record.topic, partition: 0, baseOffset: "11" }];
  },
  async sendBatch(batch) {
    sentBatches.push(batch);
    return batch.topicMessages.map((topicMessage, index) => ({
      topicName: topicMessage.topic,
      partition: index,
      baseOffset: String(20 + index)
    }));
  }
};

const originalRecord = {
  topic: "checkout.events",
  messages: [{
    key: "MESSAGE_KEY_SENTINEL",
    value: "MESSAGE_VALUE_SENTINEL",
    headers: { existing: "keep-me" }
  }]
};
const sendResult = await kafkaJsProducerSendWithLogBrewSpan(producer, originalRecord, {
  client,
  id: "evt_kafkajs_send_001",
  now: () => "2026-06-25T12:00:00Z",
  nowMs: () => 10,
  spanIdFactory: () => "1111111111111111",
  traceIdFactory: () => "22222222222222222222222222222222"
});
assertEqual(sendResult[0].topicName, "checkout.events", "send result topic");
assertEqual(originalRecord.messages[0].headers.traceparent, undefined, "producer record clone boundary");
const sentRecord = sentRecords[0];
const producerTraceparent = sentRecord.messages[0].headers.traceparent;
assertEqual(producerTraceparent, "00-22222222222222222222222222222222-1111111111111111-01", "producer traceparent");
assertEqual(sentRecord.messages[0].headers.existing, "keep-me", "existing headers preserved");
assertEqual(extractLogBrewKafkaJsTraceparent(sentRecord.messages[0]), producerTraceparent, "producer trace extraction");

const consumed = await withLogBrewKafkaJsEachMessage(async (payload) => {
  assertEqual(payload.topic, "checkout.events", "eachMessage topic");
  return "processed";
}, {
  client,
  id: "evt_kafkajs_each_message_001",
  now: () => "2026-06-25T12:00:01Z",
  nowMs: () => 30,
  spanIdFactory: () => "3333333333333333"
})({
  topic: "checkout.events",
  partition: 1,
  message: {
    headers: { traceparent: Buffer.from(producerTraceparent) },
    key: "MESSAGE_KEY_SENTINEL",
    offset: "42",
    value: "MESSAGE_VALUE_SENTINEL"
  }
});
assertEqual(consumed, "processed", "eachMessage result");

const malformed = await withLogBrewKafkaJsEachMessage(async () => "fallback", {
  client,
  id: "evt_kafkajs_malformed_001",
  now: () => "2026-06-25T12:00:02Z",
  spanIdFactory: () => "4444444444444444",
  traceIdFactory: () => "55555555555555555555555555555555"
})({
  topic: "checkout.events",
  partition: 0,
  message: { headers: { traceparent: "bad-traceparent" }, value: "MESSAGE_VALUE_SENTINEL" }
});
assertEqual(malformed, "fallback", "malformed trace fallback");

try {
  await withLogBrewKafkaJsEachMessage(async () => {
    throw new TypeError("processor failure sample detail");
  }, {
    client,
    id: "evt_kafkajs_each_message_error_001",
    now: () => "2026-06-25T12:00:03Z",
    spanIdFactory: () => "6666666666666666"
  })({
    topic: "checkout.events",
    partition: 0,
    message: { headers: { traceparent: producerTraceparent }, value: "MESSAGE_VALUE_SENTINEL" }
  });
  throw new Error("expected processor failure");
} catch (error) {
  if (!(error instanceof TypeError)) {
    throw error;
  }
}

const batchResult = await kafkaJsProducerSendBatchWithLogBrewSpan(producer, {
  topicMessages: [
    { topic: "checkout.events", messages: [{ value: "MESSAGE_VALUE_SENTINEL" }] },
    { topic: "billing.events", messages: [{ value: "MESSAGE_VALUE_SENTINEL" }, { headers: { custom: "preserve" }, value: "MESSAGE_VALUE_SENTINEL" }] }
  ]
}, {
  client,
  id: "evt_kafkajs_send_batch_001",
  now: () => "2026-06-25T12:00:04Z",
  nowMs: () => 80,
  spanIdFactory: () => "7777777777777777",
  traceIdFactory: () => "88888888888888888888888888888888"
});
assertEqual(batchResult.length, 2, "batch result count");
assertEqual(sentBatches[0].topicMessages[0].messages[0].headers.traceparent, "00-88888888888888888888888888888888-7777777777777777-01", "batch traceparent");
assertEqual(sentBatches[0].topicMessages[1].messages[1].headers.custom, "preserve", "batch existing header preserved");

const batchProcessed = await withLogBrewKafkaJsEachBatch(async (payload) => {
  assertEqual(payload.batch.messages.length, 3, "eachBatch message count");
  return "batch-processed";
}, {
  client,
  id: "evt_kafkajs_each_batch_001",
  now: () => "2026-06-25T12:00:05Z",
  spanIdFactory: () => "9999999999999999",
  traceIdFactory: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
})({
  batch: {
    topic: "checkout.events",
    partition: 0,
    messages: [
      sentRecords[0].messages[0],
      sentBatches[0].topicMessages[0].messages[0],
      { headers: { traceparent: "bad-traceparent" }, value: "MESSAGE_VALUE_SENTINEL" }
    ]
  }
});
assertEqual(batchProcessed, "batch-processed", "eachBatch result");

const instrumentedRecords = [];
const producerWithThis = {
  marker: "producer-this",
  async send(record, sendOptions) {
    assertEqual(this.marker, "producer-this", "instrumented producer this");
    instrumentedRecords.push({ record, sendOptions });
    return [{ topicName: record.topic, partition: 0, baseOffset: "31" }];
  },
  async sendBatch(batch, sendOptions) {
    assertEqual(this.marker, "producer-this", "instrumented producer batch this");
    instrumentedRecords.push({ batch, sendOptions });
    return batch.topicMessages.map((topicMessage, index) => ({
      topicName: topicMessage.topic,
      partition: index,
      baseOffset: String(40 + index)
    }));
  }
};
const producerInstrumentation = instrumentLogBrewKafkaJsProducer(producerWithThis, {
  client,
  id: "evt_kafkajs_instrumented_send_001",
  now: () => "2026-06-25T12:00:06Z",
  nowMs: () => 120,
  spanIdFactory: () => "bbbbbbbbbbbbbbbb",
  traceIdFactory: () => "cccccccccccccccccccccccccccccccc"
});
let duplicateProducerRejected = false;
try {
  instrumentLogBrewKafkaJsProducer(producerWithThis, { client });
} catch (error) {
  duplicateProducerRejected = String(error?.message ?? "").includes("already instrumented");
}
assertEqual(duplicateProducerRejected, true, "duplicate producer instrumentation rejected");
const instrumentedInput = {
  topic: "instrumented.events",
  messages: [{ value: "INSTRUMENTED_VALUE_SENTINEL", headers: { private: "PRIVATE_HEADER_SENTINEL" } }]
};
await producerWithThis.send(instrumentedInput, { acks: 1 });
assertEqual(instrumentedInput.messages[0].headers.traceparent, undefined, "instrumented producer clone boundary");
assertEqual(instrumentedRecords[0].sendOptions.acks, 1, "instrumented producer options preserved");
const instrumentedTraceparent = instrumentedRecords[0].record.messages[0].headers.traceparent;
assertEqual(instrumentedTraceparent, "00-cccccccccccccccccccccccccccccccc-bbbbbbbbbbbbbbbb-01", "instrumented producer traceparent");
producerInstrumentation.uninstall();
const pendingAfterProducerUninstall = client.pendingEvents();
await producerWithThis.send({
  topic: "instrumented.events",
  messages: [{ value: "AFTER_UNINSTALL_VALUE_SENTINEL" }]
});
assertEqual(client.pendingEvents(), pendingAfterProducerUninstall, "producer uninstall stops tracing original send");

const consumerRunCalls = [];
const consumerWithThis = {
  marker: "consumer-this",
  async run(config, extraArg) {
    assertEqual(this.marker, "consumer-this", "instrumented consumer this");
    consumerRunCalls.push({ config, extraArg });
    return config.eachMessage({
      topic: "instrumented.events",
      partition: 2,
      message: {
        headers: { traceparent: Buffer.from(instrumentedTraceparent) },
        value: "INSTRUMENTED_CONSUMER_VALUE_SENTINEL"
      }
    });
  }
};
const runConfig = {
  autoCommit: false,
  eachMessage: async () => "instrumented-message"
};
const consumerInstrumentation = instrumentLogBrewKafkaJsConsumer(consumerWithThis, {
  client,
  id: "evt_kafkajs_instrumented_each_message_001",
  now: () => "2026-06-25T12:00:07Z",
  nowMs: () => 140,
  spanIdFactory: () => "dddddddddddddddd"
});
let duplicateConsumerRejected = false;
try {
  instrumentLogBrewKafkaJsConsumer(consumerWithThis, { client });
} catch (error) {
  duplicateConsumerRejected = String(error?.message ?? "").includes("already instrumented");
}
assertEqual(duplicateConsumerRejected, true, "duplicate consumer instrumentation rejected");
const messageResult = await consumerWithThis.run(runConfig, "EXTRA_ARG_SENTINEL");
assertEqual(messageResult, "instrumented-message", "instrumented consumer result");
assertEqual(consumerRunCalls[0].extraArg, "EXTRA_ARG_SENTINEL", "consumer extra args preserved");
assertEqual(consumerRunCalls[0].config === runConfig, false, "consumer run config cloned");
assertEqual(runConfig.eachMessage === consumerRunCalls[0].config.eachMessage, false, "consumer callback wrapped on clone");
consumerInstrumentation.uninstall();
const pendingAfterConsumerUninstall = client.pendingEvents();
await consumerWithThis.run(runConfig, "AFTER_UNINSTALL_EXTRA_SENTINEL");
assertEqual(client.pendingEvents(), pendingAfterConsumerUninstall, "consumer uninstall stops tracing original run");

const batchConsumerWithThis = {
  marker: "batch-consumer-this",
  async run(config) {
    assertEqual(this.marker, "batch-consumer-this", "instrumented batch consumer this");
    return config.eachBatch({
      batch: {
        topic: "instrumented.events",
        partition: 3,
        messages: [
          instrumentedRecords[0].record.messages[0],
          { headers: { traceparent: "bad-traceparent" }, value: "INSTRUMENTED_BATCH_VALUE_SENTINEL" }
        ]
      }
    });
  }
};
const batchRunConfig = {
  eachBatch: async () => "instrumented-batch"
};
const batchConsumerInstrumentation = instrumentLogBrewKafkaJsConsumer(batchConsumerWithThis, {
  client,
  id: "evt_kafkajs_instrumented_each_batch_001",
  now: () => "2026-06-25T12:00:08Z",
  nowMs: () => 160,
  spanIdFactory: () => "eeeeeeeeeeeeeeee",
  traceIdFactory: () => "ffffffffffffffffffffffffffffffff"
});
const batchConsumerResult = await batchConsumerWithThis.run(batchRunConfig);
assertEqual(batchConsumerResult, "instrumented-batch", "instrumented batch consumer result");
batchConsumerInstrumentation.uninstall();

const preview = JSON.parse(client.previewJson());
const events = preview.events;
const sendSpan = findEvent(events, "evt_kafkajs_send_001");
const eachMessageSpan = findEvent(events, "evt_kafkajs_each_message_001");
const malformedSpan = findEvent(events, "evt_kafkajs_malformed_001");
const errorSpan = findEvent(events, "evt_kafkajs_each_message_error_001");
const sendBatchSpan = findEvent(events, "evt_kafkajs_send_batch_001");
const eachBatchSpan = findEvent(events, "evt_kafkajs_each_batch_001");
const instrumentedSendSpan = findEvent(events, "evt_kafkajs_instrumented_send_001");
const instrumentedEachMessageSpan = findEvent(events, "evt_kafkajs_instrumented_each_message_001");
const instrumentedEachBatchSpan = findEvent(events, "evt_kafkajs_instrumented_each_batch_001");

assertEqual(sendSpan.attributes.metadata["messaging.system"], "kafka", "send messaging system");
assertEqual(sendSpan.attributes.metadata["messaging.destination.name"], "checkout.events", "send destination");
assertEqual(sendSpan.attributes.metadata["messaging.operation.type"], "publish", "send operation type");
assertEqual(eachMessageSpan.attributes.traceId, "22222222222222222222222222222222", "consumer trace id");
assertEqual(eachMessageSpan.attributes.parentSpanId, "1111111111111111", "consumer parent span");
assertEqual(malformedSpan.attributes.traceId, "55555555555555555555555555555555", "malformed fallback trace");
assertEqual(errorSpan.attributes.status, "error", "error span status");
assertEqual(errorSpan.attributes.metadata.errorType, "TypeError", "error type");
assertEqual(sendBatchSpan.attributes.metadata["messaging.batch.message_count"], 3, "sendBatch count");
assertEqual(eachBatchSpan.attributes.metadata["messaging.batch.message_count"], 3, "eachBatch count");
assertEqual(eachBatchSpan.attributes.links.length, 2, "batch span links skip malformed");
assertEqual(instrumentedSendSpan.attributes.metadata["messaging.destination.name"], "instrumented.events", "instrumented send destination");
assertEqual(instrumentedEachMessageSpan.attributes.traceId, "cccccccccccccccccccccccccccccccc", "instrumented consumer trace id");
assertEqual(instrumentedEachMessageSpan.attributes.parentSpanId, "bbbbbbbbbbbbbbbb", "instrumented consumer parent span");
assertEqual(instrumentedEachBatchSpan.attributes.metadata["messaging.batch.message_count"], 2, "instrumented batch count");
assertEqual(instrumentedEachBatchSpan.attributes.links.length, 1, "instrumented batch links skip malformed");

const serialized = JSON.stringify(preview);
for (const forbidden of [
  "MESSAGE_KEY_SENTINEL",
  "MESSAGE_VALUE_SENTINEL",
  "processor failure sample detail",
  "existing",
  "keep-me",
  "custom",
  producerTraceparent,
  instrumentedTraceparent,
  "INSTRUMENTED_VALUE_SENTINEL",
  "PRIVATE_HEADER_SENTINEL",
  "AFTER_UNINSTALL_VALUE_SENTINEL",
  "INSTRUMENTED_CONSUMER_VALUE_SENTINEL",
  "INSTRUMENTED_BATCH_VALUE_SENTINEL",
  "EXTRA_ARG_SENTINEL",
  "AFTER_UNINSTALL_EXTRA_SENTINEL"
]) {
  if (serialized.includes(forbidden)) {
    throw new Error(`preview leaked forbidden KafkaJS detail: ${forbidden}`);
  }
}

let attempts = 0;
const requestBodies = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", chunk => {
    body += chunk;
  });
  req.on("end", () => {
    attempts += 1;
    requestBodies.push(body);
    res.writeHead(attempts === 1 ? 503 : 202, { "content-type": "application/json" });
    res.end("{}");
  });
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
const endpoint = `http://127.0.0.1:${address.port}/v1/events`;
const response = await client.flush(createNodeFetchTransport({ endpoint, timeoutMs: 2000 }));
server.close();
await once(server, "close");
assertEqual(response.statusCode, 202, "flush status");
assertEqual(response.attempts, 2, "retry attempts");
assertEqual(attempts, 2, "fake intake attempts");
assertEqual(client.pendingEvents(), 0, "queue drained");
if (!requestBodies[1].includes("evt_kafkajs_each_batch_001")) {
  throw new Error("flush body missing KafkaJS spans");
}

function findEvent(events, id) {
  const event = events.find((candidate) => candidate.id === id);
  if (!event) {
    throw new Error(`missing event ${id}`);
  }
  return event;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
EOF

node smoke.mjs

echo "KafkaJS real-user smoke passed"
