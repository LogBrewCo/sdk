#!/usr/bin/env bash
set -Eeuo pipefail

registry="https://registry.npmjs.org"
tmp_dir="$(mktemp -d)"

sdk_version="${LOGBREW_NPM_SDK_VERSION:-0.1.4}"
browser_version="${LOGBREW_NPM_BROWSER_VERSION:-0.1.1}"
node_version="${LOGBREW_NPM_NODE_VERSION:-0.1.2}"
next_version="${LOGBREW_NPM_NEXT_VERSION:-0.1.1}"
react_native_version="${LOGBREW_NPM_REACT_NATIVE_VERSION:-0.1.1}"
bullmq_version="${LOGBREW_NPM_BULLMQ_VERSION:-0.1.1}"
kafkajs_version="${LOGBREW_NPM_KAFKAJS_VERSION:-0.1.1}"
amqplib_version="${LOGBREW_NPM_AMQPLIB_VERSION:-0.1.2}"
aws_sqs_version="${LOGBREW_NPM_AWS_SQS_VERSION:-0.1.1}"
receipt_mode="${LOGBREW_RELEASE_RECEIPT_MODE:-0}"

if [[ $# -ne 0 ]] || { [[ "$receipt_mode" != "0" ]] && [[ "$receipt_mode" != "1" ]]; }; then
  echo "usage: $0" >&2
  exit 2
fi

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

fail_receipt_stage() {
  echo "npm registry receipt failed at $1" >&2
  exit 1
}

run_receipt_smoke() {
  if [[ -z "${LOGBREW_NPM_SDK_VERSION:-}" ]] \
    || [[ -z "${LOGBREW_NPM_BROWSER_VERSION:-}" ]] \
    || [[ -z "${LOGBREW_NPM_NODE_VERSION:-}" ]] \
    || [[ -z "${LOGBREW_NPM_NEXT_VERSION:-}" ]] \
    || [[ -z "${LOGBREW_NPM_REACT_NATIVE_VERSION:-}" ]]; then
    fail_receipt_stage "version binding"
  fi
  mkdir -p \
    "$tmp_dir/artifacts" \
    "$tmp_dir/npm-public-registry-receipt-app" \
    >"$tmp_dir/receipt-setup.out" 2>"$tmp_dir/receipt-setup.err" \
    || fail_receipt_stage "application setup"
  if ! RECEIPT_ARTIFACT_DIR="$tmp_dir/artifacts" \
    RECEIPT_METADATA_PATH="$tmp_dir/receipt-artifacts.json" \
    node >"$tmp_dir/receipt-artifact-check.out" 2>"$tmp_dir/receipt-artifact-check.err" <<'JS'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const ids = [
  "npm:@logbrew/sdk",
  "npm:@logbrew/browser",
  "npm:@logbrew/node",
  "npm:@logbrew/next",
  "npm:@logbrew/react-native"
];
let supplied;
try {
  supplied = JSON.parse(process.env.LOGBREW_RELEASE_ARTIFACT_FILES_JSON ?? "");
} catch {
  process.exit(1);
}
if (
  !supplied
  || Array.isArray(supplied)
  || typeof supplied !== "object"
  || Object.keys(supplied).length !== ids.length
  || ids.some((id) => typeof supplied[id] !== "string" || !path.isAbsolute(supplied[id]))
) {
  process.exit(1);
}

const artifacts = [];
for (const [index, id] of ids.entries()) {
  let descriptor;
  try {
    const pathStat = fs.lstatSync(supplied[id]);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
      process.exit(1);
    }
    if (typeof fs.constants.O_NOFOLLOW !== "number") {
      process.exit(1);
    }
    descriptor = fs.openSync(supplied[id], fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 64 * 1024 * 1024) {
      process.exit(1);
    }
    const bytes = fs.readFileSync(descriptor);
    const destination = path.join(process.env.RECEIPT_ARTIFACT_DIR, `${index}.tgz`);
    fs.writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
    artifacts.push({
      id,
      digest: `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`
    });
  } catch {
    process.exit(1);
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}
fs.writeFileSync(
  process.env.RECEIPT_METADATA_PATH,
  JSON.stringify({ artifacts }),
  { flag: "wx", mode: 0o600 }
);
JS
  then
    fail_receipt_stage "artifact binding"
  fi

  cd "$tmp_dir/npm-public-registry-receipt-app" 2>"$tmp_dir/receipt-cd.err" \
    || fail_receipt_stage "application setup"
  unset NODE_OPTIONS
  export NPM_CONFIG_CACHE="$tmp_dir/npm-cache"
  export NPM_CONFIG_UPDATE_NOTIFIER=false
  if ! : >"$tmp_dir/npmrc" 2>"$tmp_dir/npmrc.err"; then
    fail_receipt_stage "application setup"
  fi
  export NPM_CONFIG_USERCONFIG="$tmp_dir/npmrc"
  npm init -y >"$tmp_dir/npm-init.out" 2>"$tmp_dir/npm-init.err" || fail_receipt_stage "application setup"
  npm pkg set type=module >"$tmp_dir/npm-pkg.out" 2>"$tmp_dir/npm-pkg.err" || fail_receipt_stage "application setup"
  npm install \
    --save-exact \
    --ignore-scripts \
    --legacy-peer-deps \
    --no-audit \
    --no-fund \
    --offline \
    "$tmp_dir/artifacts/0.tgz" \
    "$tmp_dir/artifacts/1.tgz" \
    "$tmp_dir/artifacts/2.tgz" \
    "$tmp_dir/artifacts/3.tgz" \
    "$tmp_dir/artifacts/4.tgz" \
    >"$tmp_dir/npm-install.out" 2>"$tmp_dir/npm-install.err" \
    || fail_receipt_stage "artifact install"

  if ! node - \
    "$sdk_version" \
    "$browser_version" \
    "$node_version" \
    "$next_version" \
    "$react_native_version" \
    >"$tmp_dir/receipt-package-check.out" 2>"$tmp_dir/receipt-package-check.err" <<'JS'
const fs = require("node:fs");
const expected = [
  ["@logbrew/sdk", process.argv[2]],
  ["@logbrew/browser", process.argv[3]],
  ["@logbrew/node", process.argv[4]],
  ["@logbrew/next", process.argv[5]],
  ["@logbrew/react-native", process.argv[6]]
];
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
for (const [name, version] of expected) {
  const installed = JSON.parse(fs.readFileSync(`node_modules/${name}/package.json`, "utf8"));
  const locked = lock.packages?.[`node_modules/${name}`];
  if (installed.name !== name || installed.version !== version || locked?.version !== version) {
    process.exit(1);
  }
}
JS
  then
    fail_receipt_stage "installed identity"
  fi

  if ! cat >"$tmp_dir/npm-public-registry-receipt-app/receipt-runtime-check.mjs" \
    2>"$tmp_dir/receipt-runtime-write.err" <<'JS'
import { RecordingTransport } from "@logbrew/sdk";
import { createLogBrewBrowserClient } from "@logbrew/browser";
import { createLogBrewNodeClient } from "@logbrew/node";
import { withLogBrewNextReleaseArtifacts } from "@logbrew/next/release-artifacts";
import { prepareLogBrewReactNativeReleaseArtifacts } from "@logbrew/react-native/release-artifacts";

for (const exportedValue of [
  RecordingTransport,
  createLogBrewBrowserClient,
  createLogBrewNodeClient,
  withLogBrewNextReleaseArtifacts,
  prepareLogBrewReactNativeReleaseArtifacts
]) {
  if (typeof exportedValue !== "function") {
    process.exit(1);
  }
}
JS
  then
    fail_receipt_stage "installed execution"
  fi
  if ! RECEIPT_RUNTIME_PATH="$tmp_dir/npm-public-registry-receipt-app/receipt-runtime-check.mjs" node \
    >"$tmp_dir/receipt-runtime-check.out" 2>"$tmp_dir/receipt-runtime-check.err" <<'JS'
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, [process.env.RECEIPT_RUNTIME_PATH], {
  detached: process.platform !== "win32",
  stdio: "ignore"
});
let forceTimer;
let timedOut = false;
const terminate = (signal) => {
  try {
    if (process.platform === "win32") {
      child.kill(signal);
    } else if (child.pid !== undefined) {
      process.kill(-child.pid, signal);
    }
  } catch {
    // The process group already exited.
  }
};
const timeout = setTimeout(() => {
  timedOut = true;
  terminate("SIGTERM");
  forceTimer = setTimeout(() => terminate("SIGKILL"), 2_000);
}, 10_000);
child.once("error", () => {
  clearTimeout(timeout);
  if (forceTimer !== undefined) {
    clearTimeout(forceTimer);
  }
  process.exit(1);
});
child.once("close", (code) => {
  clearTimeout(timeout);
  if (forceTimer !== undefined) {
    clearTimeout(forceTimer);
  }
  terminate("SIGTERM");
  process.exit(!timedOut && code === 0 ? 0 : 1);
});
JS
  then
    fail_receipt_stage "installed execution"
  fi

  if ! node - "$tmp_dir/receipt-artifacts.json" \
    >"$tmp_dir/receipt-attestation.json" 2>"$tmp_dir/receipt-attestation.err" <<'JS'
const fs = require("node:fs");
const ids = [
  "npm:@logbrew/sdk",
  "npm:@logbrew/browser",
  "npm:@logbrew/node",
  "npm:@logbrew/next",
  "npm:@logbrew/react-native"
];
const metadata = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (
  !Array.isArray(metadata.artifacts)
  || metadata.artifacts.length !== ids.length
  || metadata.artifacts.some((artifact, index) => (
    artifact.id !== ids[index]
    || !/^sha256:[0-9a-f]{64}$/.test(artifact.digest)
  ))
) {
  process.exit(1);
}
process.stdout.write(JSON.stringify({
  "schema_version":1,
  "status":"passed",
  artifacts: metadata.artifacts
}) + "\n");
JS
  then
    fail_receipt_stage "attestation"
  fi
  local attestation
  if ! IFS= read -r attestation <"$tmp_dir/receipt-attestation.json"; then
    fail_receipt_stage "attestation"
  fi
  printf '%s\n' "$attestation"
}

require_command node
require_command npm

if [[ "$receipt_mode" == "1" ]]; then
  run_receipt_smoke
  exit 0
fi

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
