#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

core_pack_json="$tmp_dir/core-pack.json"
node_pack_json="$tmp_dir/node-pack.json"
(cd "$repo_root/js/logbrew-js" && npm pack --json --pack-destination "$tmp_dir") > "$core_pack_json"
(cd "$repo_root/js/logbrew-node" && npm pack --json --pack-destination "$tmp_dir") > "$node_pack_json"

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
core_tgz="$tmp_dir/$(printf '%s\n' "$core_tgz" | tail -n 1)"
node_tgz="$tmp_dir/$node_tgz"
test -f "$core_tgz"
test -f "$node_tgz"

app_dir="$tmp_dir/node-queue-trace-app"
mkdir -p "$app_dir"
cd "$app_dir"
npm init -y >/dev/null
npm pkg set type=module >/dev/null
npm install --save-exact "$core_tgz" "$node_tgz" typescript @types/node >/dev/null

cat > smoke.mjs <<'EOF'
import {
  createLogBrewNodeClient,
  createLogBrewQueueTraceHeaders,
  createLogBrewQueueTraceLinks,
  getActiveLogBrewTrace,
  queueBatchOperationWithLogBrewSpan,
  queueOperationWithLogBrewSpan
} from "@logbrew/node";

const client = createLogBrewNodeClient({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "node-queue-trace-smoke",
  sdkVersion: "0.1.0"
});
const parentTrace = {
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "b7ad6b7169203331",
  sampled: true
};
let publishedHeaders;
const publishResult = await queueOperationWithLogBrewSpan("email.publish", {
  client,
  id: "evt_node_queue_publish_trace",
  now: () => "2026-06-25T10:00:00Z",
  nowMs: () => 10,
  operation: async () => {
    publishedHeaders = createLogBrewQueueTraceHeaders();
    return "queued";
  },
  operationKind: "publish",
  queueName: "email",
  spanIdFactory: () => "f7ad6b7169203331",
  system: "amqp",
  trace: parentTrace
});
if (publishResult !== "queued") {
  throw new Error(`queue publish changed the app result: ${publishResult}`);
}
if (publishedHeaders?.traceparent !== "00-4bf92f3577b34da6a3ce929d0e0e4736-f7ad6b7169203331-01") {
  throw new Error(`producer did not expose one normalized traceparent: ${JSON.stringify(publishedHeaders)}`);
}

let activeConsumerTrace;
const consumeResult = await queueOperationWithLogBrewSpan("email.process", {
  client,
  id: "evt_node_queue_consume_trace",
  now: () => "2026-06-25T10:00:01Z",
  nowMs: () => 20,
  operation: async () => {
    activeConsumerTrace = getActiveLogBrewTrace();
    return "processed";
  },
  operationKind: "process",
  queueName: "email",
  spanIdFactory: () => "a7ad6b7169203331",
  system: "amqp",
  traceparent: publishedHeaders.traceparent
});
if (consumeResult !== "processed") {
  throw new Error(`queue consumer changed the app result: ${consumeResult}`);
}
if (
  activeConsumerTrace?.traceId !== "4bf92f3577b34da6a3ce929d0e0e4736" ||
  activeConsumerTrace?.parentSpanId !== "f7ad6b7169203331" ||
  activeConsumerTrace?.spanId !== "a7ad6b7169203331"
) {
  throw new Error(`consumer did not continue producer trace: ${JSON.stringify(activeConsumerTrace)}`);
}
const batchLinks = createLogBrewQueueTraceLinks([
  publishedHeaders,
  { traceparent: "not-a-traceparent" },
  { traceparent: ["00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-00"] },
  { traceparent: Buffer.from("00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01") }
], {
  body: "hello user@example.com",
  relation: "batch_item"
});
if (JSON.stringify(batchLinks) !== JSON.stringify([
  {
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "f7ad6b7169203331",
    sampled: true,
    metadata: { relation: "batch_item" }
  },
  {
    traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    spanId: "bbbbbbbbbbbbbbbb",
    sampled: false,
    metadata: { relation: "batch_item" }
  },
  {
    traceId: "cccccccccccccccccccccccccccccccc",
    spanId: "dddddddddddddddd",
    sampled: true,
    metadata: { relation: "batch_item" }
  }
])) {
  throw new Error(`batch queue trace links were not safe and useful: ${JSON.stringify(batchLinks)}`);
}
await queueBatchOperationWithLogBrewSpan("email.batch_process", {
  client,
  id: "evt_node_queue_batch_trace",
  linkMetadata: {
    body: "hello user@example.com",
    relation: "batch_item"
  },
  messages: [
    { headers: publishedHeaders, body: "hello user@example.com" },
    { headers: { traceparent: "not-a-traceparent" }, body: "malformed" },
    { headers: { traceparent: ["00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-00"] } },
    { headers: { traceparent: Buffer.from("00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01") } }
  ],
  now: () => "2026-06-25T10:00:02Z",
  nowMs: () => 25,
  operation: async () => "batch-processed",
  operationKind: "process",
  queueName: "email",
  spanIdFactory: () => "a7ad6b7169203333",
  system: "amqp",
  traceIdFactory: () => "66666666666666666666666666666666"
});
const heavyMessages = Array.from({ length: 512 }, (_, index) => ({
  headers: {
    traceparent: `00-${(index + 1).toString(16).padStart(32, "0")}-${(index + 1).toString(16).padStart(16, "0")}-01`
  },
  payload: `private-payload-${index}`
}));
await queueBatchOperationWithLogBrewSpan("email.heavy_batch_process", {
  client,
  id: "evt_node_queue_heavy_batch_trace",
  linkMetadata: {
    payload: "private-payload-0",
    relation: "batch_item"
  },
  messages: heavyMessages,
  now: () => "2026-06-25T10:00:03Z",
  nowMs: () => 35,
  operation: async () => "heavy-batch-processed",
  operationKind: "process",
  queueName: "email",
  spanIdFactory: () => "a7ad6b7169203334",
  system: "amqp",
  traceIdFactory: () => "77777777777777777777777777777777"
});

await queueOperationWithLogBrewSpan("email.dead_letter", {
  client,
  id: "evt_node_queue_bad_context",
  now: () => "2026-06-25T10:00:02Z",
  nowMs: () => 30,
  operation: async () => "parked",
  operationKind: "process",
  queueName: "email",
  spanIdFactory: () => "a7ad6b7169203332",
  system: "amqp",
  traceIdFactory: () => "55555555555555555555555555555555",
  traceparent: "not-a-traceparent"
});
if (Object.keys(createLogBrewQueueTraceHeaders(undefined)).length !== 0) {
  throw new Error("queue header helper should be a no-op without active trace");
}

const payload = JSON.parse(client.previewJson());
const producerSpan = payload.events.find((event) => event.id === "evt_node_queue_publish_trace");
const consumerSpan = payload.events.find((event) => event.id === "evt_node_queue_consume_trace");
const batchSpan = payload.events.find((event) => event.id === "evt_node_queue_batch_trace");
const heavyBatchSpan = payload.events.find((event) => event.id === "evt_node_queue_heavy_batch_trace");
const fallbackSpan = payload.events.find((event) => event.id === "evt_node_queue_bad_context");
if (
  producerSpan?.attributes.traceId !== "4bf92f3577b34da6a3ce929d0e0e4736" ||
  producerSpan?.attributes.parentSpanId !== "b7ad6b7169203331" ||
  producerSpan?.attributes.spanId !== "f7ad6b7169203331"
) {
  throw new Error(`producer span did not correlate with parent trace: ${client.previewJson()}`);
}
if (
  consumerSpan?.attributes.traceId !== "4bf92f3577b34da6a3ce929d0e0e4736" ||
  consumerSpan?.attributes.parentSpanId !== "f7ad6b7169203331" ||
  consumerSpan?.attributes.spanId !== "a7ad6b7169203331"
) {
  throw new Error(`consumer span did not continue producer trace: ${client.previewJson()}`);
}
if (
  batchSpan?.attributes.links?.length !== 3 ||
  batchSpan.attributes.links[0].traceId !== "4bf92f3577b34da6a3ce929d0e0e4736" ||
  batchSpan.attributes.links[0].spanId !== "f7ad6b7169203331" ||
  batchSpan.attributes.links[0].metadata.relation !== "batch_item" ||
  batchSpan.attributes.links[1].sampled !== false ||
  batchSpan.attributes.links[2].sampled !== true
) {
  throw new Error(`batch span did not link producer traces: ${client.previewJson()}`);
}
if (
  heavyBatchSpan?.attributes.links?.length !== 8 ||
  heavyBatchSpan?.attributes.metadata.messageCount !== 512 ||
  heavyBatchSpan?.attributes.metadata["messaging.batch.message_count"] !== 512 ||
  heavyBatchSpan?.attributes.links[0].metadata.relation !== "batch_item" ||
  Object.prototype.hasOwnProperty.call(heavyBatchSpan.attributes.links[0].metadata, "payload")
) {
  throw new Error(`heavy batch span did not cap links or report safe batch size: ${client.previewJson()}`);
}
if (
  fallbackSpan?.attributes.traceId !== "55555555555555555555555555555555" ||
  fallbackSpan?.attributes.parentSpanId !== undefined ||
  fallbackSpan?.attributes.spanId !== "a7ad6b7169203332"
) {
  throw new Error(`malformed traceparent fallback was not safe: ${client.previewJson()}`);
}
const payloadJson = JSON.stringify(payload);
if (payloadJson.includes(publishedHeaders.traceparent) || payloadJson.includes("not-a-traceparent") || payloadJson.includes("hello user@example.com") || payloadJson.includes("private-payload") || payloadJson.includes("body")) {
  throw new Error(`queue trace payload leaked raw propagation details: ${client.previewJson()}`);
}

console.error(JSON.stringify({
  ok: true,
  continuedParentSpanId: consumerSpan.attributes.parentSpanId,
  fallbackTraceId: fallbackSpan.attributes.traceId,
  traceparent: publishedHeaders.traceparent
}));
EOF

if ! node smoke.mjs > "$tmp_dir/node-queue-trace.stdout.json" 2> "$tmp_dir/node-queue-trace.stderr.json"; then
  cat "$tmp_dir/node-queue-trace.stderr.json" >&2
  exit 1
fi
grep -q '"ok":true' "$tmp_dir/node-queue-trace.stderr.json"
grep -q '"continuedParentSpanId":"f7ad6b7169203331"' "$tmp_dir/node-queue-trace.stderr.json"
grep -q '"fallbackTraceId":"55555555555555555555555555555555"' "$tmp_dir/node-queue-trace.stderr.json"

cat > consumer.ts <<'EOF'
import {
  createLogBrewNodeClient,
  createLogBrewQueueTraceHeaders,
  createLogBrewQueueTraceLinks,
  queueBatchOperationWithLogBrewSpan,
  queueOperationWithLogBrewSpan
} from "@logbrew/node";

const client = createLogBrewNodeClient({ serverApiKey: "LOGBREW_SERVER_API_KEY" });
const headers: { traceparent?: string } = createLogBrewQueueTraceHeaders();
const links = createLogBrewQueueTraceLinks([headers], { relation: "batch_item" });
await queueOperationWithLogBrewSpan("email.process", {
  client,
  links,
  operation: async () => "processed",
  operationKind: "process",
  queueName: "email",
  traceparent: headers.traceparent
});
await queueBatchOperationWithLogBrewSpan("email.batch", {
  client,
  messages: [{ headers }],
  operation: async () => "processed",
  queueName: "email"
});
EOF

cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "types": ["node"],
    "esModuleInterop": true,
    "skipLibCheck": false,
    "noEmit": true
  },
  "include": ["consumer.ts"]
}
EOF
npx tsc --project tsconfig.json

echo "node queue trace smoke passed with $(node --version)"
