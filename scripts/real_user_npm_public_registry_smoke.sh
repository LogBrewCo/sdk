#!/usr/bin/env bash
set -Eeuo pipefail

registry="https://registry.npmjs.org"
tmp_dir="$(mktemp -d)"

sdk_version="${LOGBREW_NPM_SDK_VERSION:-0.1.3}"
node_version="${LOGBREW_NPM_NODE_VERSION:-0.1.1}"
bullmq_version="${LOGBREW_NPM_BULLMQ_VERSION:-0.1.1}"
kafkajs_version="${LOGBREW_NPM_KAFKAJS_VERSION:-0.1.1}"
amqplib_version="${LOGBREW_NPM_AMQPLIB_VERSION:-0.1.2}"
aws_sqs_version="${LOGBREW_NPM_AWS_SQS_VERSION:-0.1.1}"

cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

require_command() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "$name is required for the npm public registry smoke" >&2
    exit 2
  fi
}

verify_registry_version() {
  local package_name="$1"
  local version="$2"
  local found
  found="$(npm view "${package_name}@${version}" version --registry "$registry")"
  if [[ "$found" != "$version" ]]; then
    echo "expected ${package_name}@${version} on npm, found ${found:-<missing>}" >&2
    exit 1
  fi
}

require_command node
require_command npm

verify_registry_version "@logbrew/sdk" "$sdk_version"
verify_registry_version "@logbrew/node" "$node_version"
verify_registry_version "@logbrew/bullmq" "$bullmq_version"
verify_registry_version "@logbrew/kafkajs" "$kafkajs_version"
verify_registry_version "@logbrew/amqplib" "$amqplib_version"
verify_registry_version "@logbrew/aws-sqs" "$aws_sqs_version"

app_dir="$tmp_dir/npm-public-registry-app"
mkdir -p "$app_dir"
cd "$app_dir"

npm init -y >/dev/null
npm pkg set type=module >/dev/null
npm install \
  --save-exact \
  --ignore-scripts \
  --registry "$registry" \
  "@logbrew/sdk@${sdk_version}" \
  "@logbrew/node@${node_version}" \
  "@logbrew/bullmq@${bullmq_version}" \
  "@logbrew/kafkajs@${kafkajs_version}" \
  "@logbrew/amqplib@${amqplib_version}" \
  "@logbrew/aws-sqs@${aws_sqs_version}" \
  bullmq \
  kafkajs \
  amqplib \
  @aws-sdk/client-sqs \
  @aws-sdk/client-sns \
  @aws-sdk/client-eventbridge \
  >/dev/null

npm ls \
  "@logbrew/sdk@${sdk_version}" \
  "@logbrew/node@${node_version}" \
  "@logbrew/bullmq@${bullmq_version}" \
  "@logbrew/kafkajs@${kafkajs_version}" \
  "@logbrew/amqplib@${amqplib_version}" \
  "@logbrew/aws-sqs@${aws_sqs_version}" \
  >/dev/null

test -f package-lock.json

node - "$sdk_version" "$node_version" "$bullmq_version" "$kafkajs_version" "$amqplib_version" "$aws_sqs_version" <<'JS'
const fs = require("node:fs");
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const expected = {
  "@logbrew/sdk": process.argv[2],
  "@logbrew/node": process.argv[3],
  "@logbrew/bullmq": process.argv[4],
  "@logbrew/kafkajs": process.argv[5],
  "@logbrew/amqplib": process.argv[6],
  "@logbrew/aws-sqs": process.argv[7]
};

for (const [name, version] of Object.entries(expected)) {
  const entry = lock.packages?.[`node_modules/${name}`];
  if (!entry || entry.version !== version) {
    throw new Error(`expected ${name}@${version} in package-lock.json`);
  }
  const installedPackage = JSON.parse(fs.readFileSync(`node_modules/${name}/package.json`, "utf8"));
  if (installedPackage.version !== version) {
    throw new Error(`expected installed ${name}@${version}, found ${installedPackage.version}`);
  }
}
JS

cat > esm-smoke.mjs <<'JS'
import { RecordingTransport } from "@logbrew/sdk";
import {
  createLogBrewNodeClient,
  createLogBrewQueueTraceHeaders
} from "@logbrew/node";
import {
  createLogBrewBullMqJobOptions,
  extractLogBrewBullMqTraceparent,
  instrumentLogBrewBullMqQueue
} from "@logbrew/bullmq";
import {
  createLogBrewKafkaJsProducerRecord,
  extractLogBrewKafkaJsTraceparent,
  instrumentLogBrewKafkaJsProducer
} from "@logbrew/kafkajs";
import {
  amqplibPublishWithLogBrewSpan,
  createLogBrewAmqplibPublishOptions,
  extractLogBrewAmqplibTraceparent
} from "@logbrew/amqplib";
import {
  createLogBrewEventBridgePutEventsInput,
  createLogBrewSnsPublishInput,
  createLogBrewSqsSendMessageInput,
  instrumentLogBrewSqsClient
} from "@logbrew/aws-sqs";

const client = createLogBrewNodeClient({
  serverApiKey: "public-npm-smoke-key",
  sdkName: "npm-public-registry-smoke",
  sdkVersion: "0.1.0"
});
client.log("evt_public_npm_registry_smoke", "2026-07-01T00:00:00Z", {
  message: "public npm registry smoke",
  level: "info",
  logger: "npm-public-registry-smoke"
});
const flushResult = await client.flush(RecordingTransport.alwaysAccept());
if (flushResult.statusCode !== 202 || client.pendingEvents() !== 0) {
  throw new Error(`unexpected flush result: ${JSON.stringify(flushResult)}`);
}

const { traceparent } = createLogBrewQueueTraceHeaders({
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "00f067aa0ba902b7",
  sampled: true
});
if (!traceparent) {
  throw new Error("expected queue traceparent");
}

const bullMqOptions = createLogBrewBullMqJobOptions({}, traceparent);
if (extractLogBrewBullMqTraceparent({ opts: bullMqOptions }) !== traceparent) {
  throw new Error("BullMQ traceparent did not round trip");
}
const fakeBullMqQueue = {
  name: "public-npm-smoke",
  add(name, data, options) {
    return { name, data, options };
  }
};
const bullMqInstrumentation = instrumentLogBrewBullMqQueue(fakeBullMqQueue, { client });
if (!bullMqInstrumentation.isInstalled()) {
  throw new Error("BullMQ queue instrumentation did not install");
}
bullMqInstrumentation.uninstall();
if (bullMqInstrumentation.isInstalled()) {
  throw new Error("BullMQ queue instrumentation did not uninstall");
}

const kafkaRecord = createLogBrewKafkaJsProducerRecord({
  topic: "public-npm-smoke",
  messages: [{ value: "redacted" }]
}, traceparent);
if (extractLogBrewKafkaJsTraceparent(kafkaRecord.messages[0]) !== traceparent) {
  throw new Error("KafkaJS traceparent did not round trip");
}
const kafkaInstrumentation = instrumentLogBrewKafkaJsProducer({
  send(record) {
    return record;
  }
}, { client });
kafkaInstrumentation.uninstall();

const amqpOptions = createLogBrewAmqplibPublishOptions({}, traceparent);
if (extractLogBrewAmqplibTraceparent(amqpOptions.headers) !== traceparent) {
  throw new Error("AMQP traceparent did not round trip");
}
if (typeof amqplibPublishWithLogBrewSpan !== "function") {
  throw new Error("missing AMQP publish helper");
}

const sqsInput = createLogBrewSqsSendMessageInput({ MessageBody: "redacted" }, traceparent);
if (sqsInput.MessageAttributes.traceparent.StringValue !== traceparent) {
  throw new Error("SQS traceparent did not round trip");
}
const snsInput = createLogBrewSnsPublishInput({ Message: "redacted" }, traceparent);
if (snsInput.MessageAttributes.traceparent.StringValue !== traceparent) {
  throw new Error("SNS traceparent did not round trip");
}
const eventBridgeInput = createLogBrewEventBridgePutEventsInput({ Entries: [{ Detail: "{}" }] }, traceparent);
if (JSON.parse(eventBridgeInput.Entries[0].Detail).traceparent !== traceparent) {
  throw new Error("EventBridge traceparent did not round trip");
}
if (typeof instrumentLogBrewSqsClient !== "function") {
  throw new Error("missing SQS instrumentation helper");
}

console.log("esm public npm smoke ok");
JS

cat > cjs-smoke.cjs <<'JS'
const sdk = require("@logbrew/sdk");
const node = require("@logbrew/node");
const bullmq = require("@logbrew/bullmq");
const kafkajs = require("@logbrew/kafkajs");
const amqplib = require("@logbrew/amqplib");
const awsSqs = require("@logbrew/aws-sqs");

const expectedFunctions = [
  [sdk, "RecordingTransport"],
  [node, "createLogBrewNodeClient"],
  [bullmq, "instrumentLogBrewBullMqQueue"],
  [kafkajs, "instrumentLogBrewKafkaJsProducer"],
  [amqplib, "amqplibPublishWithLogBrewSpan"],
  [awsSqs, "instrumentLogBrewSqsClient"]
];

for (const [moduleExports, exportName] of expectedFunctions) {
  if (typeof moduleExports[exportName] !== "function") {
    throw new Error(`missing CommonJS export ${exportName}`);
  }
}

const client = node.createLogBrewNodeClient({
  serverApiKey: "public-npm-smoke-key",
  sdkName: "npm-public-registry-cjs-smoke",
  sdkVersion: "0.1.0"
});
client.log("evt_public_npm_registry_cjs_smoke", "2026-07-01T00:00:01Z", {
  message: "public npm registry CommonJS smoke",
  level: "info",
  logger: "npm-public-registry-smoke"
});
if (client.pendingEvents() !== 1) {
  throw new Error("CommonJS client did not queue event");
}

console.log("cjs public npm smoke ok");
JS

node esm-smoke.mjs > "$tmp_dir/esm.out"
node cjs-smoke.cjs > "$tmp_dir/cjs.out"

grep -qx "esm public npm smoke ok" "$tmp_dir/esm.out"
grep -qx "cjs public npm smoke ok" "$tmp_dir/cjs.out"

echo "npm public registry install smoke passed"
