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
amqplib_pack_json="$tmp_dir/amqplib-pack.json"
(cd "$repo_root/js/logbrew-js" && npm pack --json --pack-destination "$tmp_dir") > "$core_pack_json"
(cd "$repo_root/js/logbrew-node" && npm pack --json --pack-destination "$tmp_dir") > "$node_pack_json"
(cd "$repo_root/js/logbrew-amqplib" && npm pack --json --pack-destination "$tmp_dir") > "$amqplib_pack_json"

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
amqplib_tgz="$tmp_dir/$(package_tgz "$amqplib_pack_json")"
test -f "$core_tgz"
test -f "$node_tgz"
test -f "$amqplib_tgz"

tar -tzf "$amqplib_tgz" > "$tmp_dir/amqplib-tarball.txt"
grep -q '^package/README.md$' "$tmp_dir/amqplib-tarball.txt"
grep -q '^package/index.js$' "$tmp_dir/amqplib-tarball.txt"
grep -q '^package/index.cjs$' "$tmp_dir/amqplib-tarball.txt"
grep -q '^package/index.d.ts$' "$tmp_dir/amqplib-tarball.txt"
grep -q '^package/index.d.cts$' "$tmp_dir/amqplib-tarball.txt"
grep -q '^package/examples/index.mjs$' "$tmp_dir/amqplib-tarball.txt"
grep -q '^package/examples/readme-example.mjs$' "$tmp_dir/amqplib-tarball.txt"
grep -q '^package/examples/real-user-smoke.mjs$' "$tmp_dir/amqplib-tarball.txt"
tar -xOf "$amqplib_tgz" package/README.md > "$tmp_dir/amqplib-readme.md"
grep -q 'npm install @logbrew/sdk @logbrew/node @logbrew/amqplib amqplib' "$tmp_dir/amqplib-readme.md"
grep -q 'pnpm add @logbrew/sdk @logbrew/node @logbrew/amqplib amqplib' "$tmp_dir/amqplib-readme.md"
grep -q 'LOGBREW_SERVER_API_KEY' "$tmp_dir/amqplib-readme.md"
grep -q 'project-scoped server ingest key' "$tmp_dir/amqplib-readme.md"
grep -q 'amqplibPublishWithLogBrewSpan' "$tmp_dir/amqplib-readme.md"
grep -q 'amqplibSendToQueueWithLogBrewSpan' "$tmp_dir/amqplib-readme.md"
grep -q 'withLogBrewAmqplibConsumer' "$tmp_dir/amqplib-readme.md"

app_dir="$tmp_dir/amqplib-smoke-app"
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
  "$amqplib_tgz" \
  amqplib@2.0.1 \
  typescript@6.0.3 \
  @types/node@26.0.1 \
  >/dev/null

grep -q '"@logbrew/sdk": "file:' package.json
grep -q '"@logbrew/node": "file:' package.json
grep -q '"@logbrew/amqplib": "file:' package.json
grep -q '"amqplib": "2.0.1"' package.json
grep -q '"@logbrew/amqplib"' package-lock.json
grep -q '"@logbrew/node"' package-lock.json
grep -q '"@logbrew/sdk"' package-lock.json
npm ls @logbrew/sdk @logbrew/node @logbrew/amqplib amqplib >/dev/null
npm list --depth=0 > "$tmp_dir/npm-list-depth0.txt"
grep -q "@logbrew/sdk@${sdk_package_version}" "$tmp_dir/npm-list-depth0.txt"
grep -q '@logbrew/node@0.1.0' "$tmp_dir/npm-list-depth0.txt"
grep -q '@logbrew/amqplib@0.1.0' "$tmp_dir/npm-list-depth0.txt"
grep -q 'amqplib@2.0.1' "$tmp_dir/npm-list-depth0.txt"
test -f node_modules/@logbrew/amqplib/index.js
test -f node_modules/@logbrew/amqplib/index.cjs
test -f node_modules/@logbrew/amqplib/index.d.ts

cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "noEmit": true,
    "strict": true,
    "target": "ES2022",
    "types": ["node"]
  },
  "include": ["types.ts"]
}
EOF

cat > types.ts <<'EOF'
import type { Channel, ConsumeMessage, Options } from "amqplib";
import { LogBrewClient } from "@logbrew/sdk";
import {
  amqplibPublishWithLogBrewSpan,
  amqplibSendToQueueWithLogBrewSpan,
  createLogBrewAmqplibPublishOptions,
  extractLogBrewAmqplibTraceparent,
  withLogBrewAmqplibConsumer
} from "@logbrew/amqplib";

const client = LogBrewClient.create({
  apiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "amqplib-type-smoke",
  sdkVersion: "0.1.0"
});
declare const channel: Pick<Channel, "publish" | "sendToQueue">;
declare const message: ConsumeMessage;
const publishOptions: Options.Publish = { headers: { app: "checkout" } };
const content = Buffer.from("example");
const publishResult = amqplibPublishWithLogBrewSpan(channel, "checkout", "created", content, publishOptions, { client });
const sendResult = amqplibSendToQueueWithLogBrewSpan(channel, "checkout.created", content, publishOptions, { client });
const wrapped = withLogBrewAmqplibConsumer(async (msg: ConsumeMessage | null) => msg?.fields.routingKey, { client, queueName: "checkout.created" });
const nextOptions = createLogBrewAmqplibPublishOptions(publishOptions, "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
const traceparent = extractLogBrewAmqplibTraceparent(message);

void publishResult;
void sendResult;
void wrapped(message);
void nextOptions;
void traceparent;
EOF

npx tsc --noEmit

cat > cjs-smoke.cjs <<'EOF'
const logbrewAmqplib = require("@logbrew/amqplib");

if (typeof logbrewAmqplib.amqplibPublishWithLogBrewSpan !== "function") {
  throw new Error("missing CommonJS publish export");
}
if (typeof logbrewAmqplib.default.withLogBrewAmqplibConsumer !== "function") {
  throw new Error("missing CommonJS default export");
}
EOF

node cjs-smoke.cjs

cat > smoke.mjs <<'EOF'
import http from "node:http";
import { once } from "node:events";
import * as amqp from "amqplib";
import { LogBrewClient } from "@logbrew/sdk";
import { createNodeFetchTransport } from "@logbrew/node";
import {
  amqplibPublishWithLogBrewSpan,
  amqplibSendToQueueWithLogBrewSpan,
  extractLogBrewAmqplibTraceparent,
  withLogBrewAmqplibConsumer
} from "@logbrew/amqplib";

if (typeof amqp.connect !== "function") {
  throw new Error("amqplib package did not install");
}

const client = LogBrewClient.create({
  apiKey: "LOGBREW_SERVER_API_KEY",
  maxRetries: 1,
  sdkName: "amqplib-smoke-app",
  sdkVersion: "0.1.0"
});
const publishes = [];
const sentQueues = [];
const channel = {
  publish(exchange, routingKey, content, options) {
    publishes.push({ exchange, routingKey, content, options });
    return true;
  },
  sendToQueue(queue, content, options) {
    sentQueues.push({ queue, content, options });
    return true;
  }
};

const content = Buffer.from("MESSAGE_BODY_SENTINEL");
const publishOptions = {
  contentType: "application/json",
  headers: { existing: "keep-me" },
  correlationId: "CORRELATION_SENTINEL",
  messageId: "MESSAGE_ID_SENTINEL"
};
const publishResult = await amqplibPublishWithLogBrewSpan(channel, "checkout.exchange", "created", content, publishOptions, {
  client,
  id: "evt_amqplib_publish_001",
  now: () => "2026-06-26T12:00:00Z",
  nowMs: () => 10,
  spanIdFactory: () => "1111111111111111",
  traceIdFactory: () => "22222222222222222222222222222222"
});
assertEqual(publishResult, true, "publish result");
assertEqual(publishOptions.headers.traceparent, undefined, "publish options clone boundary");
const producerTraceparent = publishes[0].options.headers.traceparent;
assertEqual(producerTraceparent, "00-22222222222222222222222222222222-1111111111111111-01", "publish traceparent");
assertEqual(publishes[0].options.headers.existing, "keep-me", "existing header preserved");
assertEqual(extractLogBrewAmqplibTraceparent({ properties: { headers: publishes[0].options.headers } }), producerTraceparent, "message trace extraction");

await amqplibSendToQueueWithLogBrewSpan(channel, "checkout.created", content, { headers: { app: "checkout" } }, {
  client,
  id: "evt_amqplib_send_to_queue_001",
  now: () => "2026-06-26T12:00:01Z",
  nowMs: () => 20,
  spanIdFactory: () => "3333333333333333",
  traceIdFactory: () => "44444444444444444444444444444444"
});
assertEqual(sentQueues[0].options.headers.traceparent, "00-44444444444444444444444444444444-3333333333333333-01", "sendToQueue traceparent");

const consumed = await withLogBrewAmqplibConsumer(async (message) => {
  assertEqual(message.fields.routingKey, "created", "consumer routing key");
  return "processed";
}, {
  client,
  id: "evt_amqplib_consume_001",
  now: () => "2026-06-26T12:00:02Z",
  nowMs: () => 40,
  queueName: "checkout.created",
  spanIdFactory: () => "5555555555555555"
})({
  fields: { exchange: "checkout.exchange", routingKey: "created" },
  properties: { headers: { traceparent: Buffer.from(producerTraceparent) } },
  content
});
assertEqual(consumed, "processed", "consumer result");

const nullMessage = await withLogBrewAmqplibConsumer(async (message) => {
  assertEqual(message, null, "consumer cancel null message");
  return "cancelled";
}, { client, id: "evt_amqplib_null_should_not_capture", queueName: "checkout.created" })(null);
assertEqual(nullMessage, "cancelled", "null message result");

const malformed = await withLogBrewAmqplibConsumer(async () => "fallback", {
  client,
  id: "evt_amqplib_malformed_001",
  now: () => "2026-06-26T12:00:03Z",
  spanIdFactory: () => "6666666666666666",
  traceIdFactory: () => "77777777777777777777777777777777",
  queueName: "checkout.created"
})({
  fields: { exchange: "checkout.exchange", routingKey: "created" },
  properties: { headers: { traceparent: "bad-traceparent" } },
  content
});
assertEqual(malformed, "fallback", "malformed trace fallback");

try {
  await withLogBrewAmqplibConsumer(async () => {
    throw new TypeError("processor failure sample detail");
  }, {
    client,
    id: "evt_amqplib_consume_error_001",
    now: () => "2026-06-26T12:00:04Z",
    spanIdFactory: () => "8888888888888888",
    queueName: "checkout.created"
  })({
    fields: { exchange: "checkout.exchange", routingKey: "created" },
    properties: { headers: { traceparent: producerTraceparent } },
    content
  });
  throw new Error("expected processor failure");
} catch (error) {
  if (!(error instanceof TypeError)) {
    throw error;
  }
}

const preview = JSON.parse(client.previewJson());
const events = preview.events;
const publishSpan = findEvent(events, "evt_amqplib_publish_001");
const sendToQueueSpan = findEvent(events, "evt_amqplib_send_to_queue_001");
const consumeSpan = findEvent(events, "evt_amqplib_consume_001");
const malformedSpan = findEvent(events, "evt_amqplib_malformed_001");
const errorSpan = findEvent(events, "evt_amqplib_consume_error_001");
assertMissingEvent(events, "evt_amqplib_null_should_not_capture");

assertEqual(publishSpan.attributes.metadata["messaging.system"], "rabbitmq", "publish messaging system");
assertEqual(publishSpan.attributes.metadata["messaging.destination.name"], "checkout.exchange", "publish destination");
assertEqual(publishSpan.attributes.metadata["messaging.operation.type"], "publish", "publish operation type");
assertEqual(publishSpan.attributes.metadata.amqpExchange, "checkout.exchange", "publish exchange metadata");
assertEqual(publishSpan.attributes.metadata.amqpRoutingKey, "created", "publish routing key metadata");
assertEqual(sendToQueueSpan.attributes.metadata["messaging.destination.name"], "checkout.created", "sendToQueue destination");
assertEqual(consumeSpan.attributes.traceId, "22222222222222222222222222222222", "consumer trace id");
assertEqual(consumeSpan.attributes.parentSpanId, "1111111111111111", "consumer parent span");
assertEqual(consumeSpan.attributes.metadata.amqpExchange, "checkout.exchange", "consumer exchange metadata");
assertEqual(consumeSpan.attributes.metadata.amqpRoutingKey, "created", "consumer routing key metadata");
assertEqual(malformedSpan.attributes.traceId, "77777777777777777777777777777777", "malformed fallback trace");
assertEqual(errorSpan.attributes.status, "error", "error span status");
assertEqual(errorSpan.attributes.metadata.errorType, "TypeError", "error type");

const serialized = JSON.stringify(preview);
for (const forbidden of [
  "MESSAGE_BODY_SENTINEL",
  "CORRELATION_SENTINEL",
  "MESSAGE_ID_SENTINEL",
  "processor failure sample detail",
  "existing",
  "keep-me",
  "traceparent",
  producerTraceparent
]) {
  if (serialized.includes(forbidden)) {
    throw new Error(`preview leaked forbidden amqplib detail: ${forbidden}`);
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
if (!requestBodies[1].includes("evt_amqplib_consume_001")) {
  throw new Error("flush body missing AMQP spans");
}

function findEvent(events, id) {
  const event = events.find((candidate) => candidate.id === id);
  if (!event) {
    throw new Error(`missing event ${id}`);
  }
  return event;
}

function assertMissingEvent(events, id) {
  const event = events.find((candidate) => candidate.id === id);
  if (event) {
    throw new Error(`unexpected event ${id}`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
EOF

node smoke.mjs

echo "AMQP/RabbitMQ real-user smoke passed"
