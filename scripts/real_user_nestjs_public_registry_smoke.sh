#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/logbrew-nestjs-public.XXXXXX")"
registry="https://registry.npmjs.org"
receipt_mode="${LOGBREW_RELEASE_RECEIPT_MODE:-0}"

nestjs_version="${LOGBREW_NPM_NESTJS_VERSION:-0.1.2}"
node_version="${LOGBREW_NPM_NODE_VERSION:-0.1.2}"
sdk_version="${LOGBREW_NPM_SDK_VERSION:-0.1.5}"
nest_common_version="11.1.28"
reflect_metadata_version="0.2.2"
rxjs_version="7.8.2"
typescript_version="7.0.2"
types_express_version="5.0.6"
types_node_version="26.1.2"

if [[ $# -ne 0 ]] \
  || { [[ "$receipt_mode" != "0" ]] && [[ "$receipt_mode" != "1" ]]; }; then
  echo "usage: $0" >&2
  exit 2
fi

cleanup() {
  rm -rf "$tmp_dir"
}

on_error() {
  local status=$?
  if [[ "$receipt_mode" == "1" ]]; then
    echo "NestJS release receipt failed" >&2
  else
    echo "NestJS public registry smoke failed" >&2
  fi
  exit "$status"
}

trap cleanup EXIT
trap on_error ERR

for command_name in node npm python3; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "$command_name is required for the NestJS public registry smoke" >&2
    exit 2
  fi
done

install_and_execute() {
  local nestjs_source="$1"
  local app_dir="$tmp_dir/app"
  mkdir -p "$app_dir"
  cd "$app_dir"

  export NPM_CONFIG_CACHE="$tmp_dir/npm-cache"
  export NPM_CONFIG_UPDATE_NOTIFIER=false
  export NPM_CONFIG_USERCONFIG="$tmp_dir/npmrc"
  unset NODE_OPTIONS
  : >"$NPM_CONFIG_USERCONFIG"

  npm init -y >"$tmp_dir/npm-init.out" 2>"$tmp_dir/npm-init.err"
  npm pkg set type=module >"$tmp_dir/npm-pkg.out" 2>"$tmp_dir/npm-pkg.err"
  npm install \
    --save-exact \
    --ignore-scripts \
    --no-audit \
    --no-fund \
    --registry "$registry" \
    "$nestjs_source" \
    "@logbrew/node@${node_version}" \
    "@logbrew/sdk@${sdk_version}" \
    "@nestjs/common@${nest_common_version}" \
    "reflect-metadata@${reflect_metadata_version}" \
    "rxjs@${rxjs_version}" \
    "typescript@${typescript_version}" \
    "@types/express@${types_express_version}" \
    "@types/node@${types_node_version}" \
    >"$tmp_dir/npm-install.out" 2>"$tmp_dir/npm-install.err"

  EXPECTED_NESTJS_VERSION="$nestjs_version" \
  EXPECTED_NODE_VERSION="$node_version" \
  EXPECTED_SDK_VERSION="$sdk_version" \
  EXPECTED_NEST_COMMON_VERSION="$nest_common_version" \
  EXPECTED_RXJS_VERSION="$rxjs_version" \
    node >"$tmp_dir/identity.out" 2>"$tmp_dir/identity.err" <<'JS'
const fs = require("node:fs");

const expected = new Map([
  ["@logbrew/nestjs", process.env.EXPECTED_NESTJS_VERSION],
  ["@logbrew/node", process.env.EXPECTED_NODE_VERSION],
  ["@logbrew/sdk", process.env.EXPECTED_SDK_VERSION],
  ["@nestjs/common", process.env.EXPECTED_NEST_COMMON_VERSION],
  ["rxjs", process.env.EXPECTED_RXJS_VERSION]
]);
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));

for (const [name, version] of expected) {
  const manifest = JSON.parse(
    fs.readFileSync(`node_modules/${name}/package.json`, "utf8")
  );
  const locked = lock.packages?.[`node_modules/${name}`];
  if (
    manifest.name !== name
    || manifest.version !== version
    || locked?.version !== version
  ) {
    process.exit(1);
  }
}

const nestManifest = JSON.parse(
  fs.readFileSync("node_modules/@logbrew/nestjs/package.json", "utf8")
);
if (
  nestManifest.peerDependencies?.["@logbrew/node"] !== "^0.1.2"
  || nestManifest.peerDependencies?.["@logbrew/sdk"] !== "^0.1.3"
  || nestManifest.peerDependencies?.["@nestjs/common"] !== ">=10"
  || nestManifest.peerDependencies?.rxjs !== ">=7"
) {
  process.exit(1);
}
JS

  cat >consumer.ts <<'TS'
import "reflect-metadata";
import type { Request } from "express";
import { createNodeFetchTransport } from "@logbrew/node";
import { RecordingTransport, type LogAttributes } from "@logbrew/sdk";
import {
  createLogBrewNestClient,
  createLogBrewNestLogger,
  LogBrewInterceptor,
  type LogBrewNestLogger,
  type LogBrewTraceContext
} from "@logbrew/nestjs";

const client = createLogBrewNestClient({
  serverApiKey: "receipt-key",
  sdkName: "nestjs-release-receipt",
  sdkVersion: "0.1.2"
});
const logger: LogBrewNestLogger = createLogBrewNestLogger({
  client,
  transport: RecordingTransport.alwaysAccept()
});
const transport = createNodeFetchTransport({
  endpoint: "https://intake.invalid/v1/events"
});
const interceptor = new LogBrewInterceptor({
  client,
  transport
});

function consumeRequest(request: Request): LogAttributes {
  const trace: LogBrewTraceContext | undefined = request.logbrew?.trace;
  return {
    message: "typed receipt",
    level: "info",
    ...(trace
      ? {
          metadata: {
            traceId: trace.traceId,
            spanId: trace.spanId,
            ...(trace.parentSpanId
              ? { parentSpanId: trace.parentSpanId }
              : {})
          }
        }
      : {})
  };
}

void interceptor;
void logger;
void consumeRequest;
TS

  cat >tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": false,
    "noEmit": true
  },
  "include": ["consumer.ts"]
}
JSON
  npx --no-install tsc --project tsconfig.json \
    >"$tmp_dir/typescript.out" 2>"$tmp_dir/typescript.err"

  cat >runtime.mjs <<'JS'
import { createServer } from "node:http";
import { of } from "rxjs";
import {
  createLogBrewNestClient,
  createLogBrewNestLogger,
  LogBrewInterceptor
} from "@logbrew/nestjs";

const received = [];
const intake = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  received.push({
    authorization: request.headers.authorization,
    body: Buffer.concat(chunks).toString("utf8")
  });
  response.statusCode = 202;
  response.end();
});
await listen(intake);
const endpoint = `http://127.0.0.1:${intake.address().port}/v1/events`;

try {
  const flushStatuses = [];
  const captureErrors = [];
  const interceptor = new LogBrewInterceptor({
    serverApiKey: "receipt-key",
    endpoint,
    idFactory: () => "evt_nestjs_receipt_interceptor",
    maxRetries: 0,
    onFlush(response) {
      flushStatuses.push(response.statusCode);
    },
    onCaptureError(error) {
      captureErrors.push(error instanceof Error ? error.message : String(error));
    }
  });
  const request = {
    headers: {},
    method: "GET",
    originalUrl: "/receipt"
  };
  const response = { statusCode: 200 };
  const executionContext = {
    switchToHttp() {
      return {
        getRequest: () => request,
        getResponse: () => response
      };
    }
  };
  await new Promise((resolve, reject) => {
    interceptor
      .intercept(executionContext, { handle: () => of({ ok: true }) })
      .subscribe({ complete: resolve, error: reject });
  });
  await waitFor(() => received.length === 1, "interceptor delivery");

  if (captureErrors.length !== 0 || flushStatuses[0] !== 202) {
    throw new Error("interceptor delivery failed");
  }
  if (received[0]?.authorization !== "Bearer receipt-key") {
    throw new Error("interceptor authorization changed");
  }
  const interceptorPayload = JSON.parse(received[0]?.body ?? "");
  if (
    interceptorPayload.events?.[0]?.id
    !== "evt_nestjs_receipt_interceptor"
  ) {
    throw new Error("interceptor payload changed");
  }

  const loggerErrors = [];
  const loggerClient = createLogBrewNestClient({
    serverApiKey: "logger-key",
    sdkName: "nestjs-release-receipt",
    sdkVersion: "0.1.2",
    maxRetries: 0
  });
  const logger = createLogBrewNestLogger({
    client: loggerClient,
    endpoint,
    flushOnCapture: true,
    idFactory: () => "evt_nestjs_receipt_logger",
    onCaptureError(error) {
      loggerErrors.push(error instanceof Error ? error.message : String(error));
    }
  });
  logger.log("installed logger delivery", "ReceiptController");
  await waitFor(() => received.length === 2, "logger delivery");
  await logger.shutdown();

  if (loggerErrors.length !== 0) {
    throw new Error("logger delivery failed");
  }
  if (received[1]?.authorization !== "Bearer logger-key") {
    throw new Error("logger authorization changed");
  }
  const loggerPayload = JSON.parse(received[1]?.body ?? "");
  if (loggerPayload.events?.[0]?.id !== "evt_nestjs_receipt_logger") {
    throw new Error("logger payload changed");
  }

  const failureErrors = [];
  const failureLogger = createLogBrewNestLogger({
    serverApiKey: "failure-key",
    endpoint,
    fetchImpl: async () => {
      throw new Error("network sentinel");
    },
    flushOnCapture: true,
    idFactory: () => "evt_nestjs_receipt_failure",
    maxRetries: 0,
    onCaptureError(error) {
      failureErrors.push(error instanceof Error ? error.message : String(error));
    }
  });
  failureLogger.log("installed failure delivery", "ReceiptController");
  await waitFor(() => failureErrors.length === 1, "failure callback");
  if (!failureErrors[0]?.includes("fetch failed: network sentinel")) {
    throw new Error("network failure was not surfaced");
  }
  if (received.length !== 2) {
    throw new Error("network failure reported a successful delivery");
  }
} finally {
  await close(intake);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}
JS

  node runtime.mjs >"$tmp_dir/runtime.out" 2>"$tmp_dir/runtime.err"
  node -e \
    'const sdk = require("@logbrew/nestjs"); if (typeof sdk.LogBrewInterceptor !== "function" || typeof sdk.createLogBrewNestLogger !== "function") process.exit(1)' \
    >"$tmp_dir/commonjs.out" 2>"$tmp_dir/commonjs.err"
}

run_receipt_smoke() {
  [[ -n "${LOGBREW_NPM_NESTJS_VERSION:-}" \
    && -n "${LOGBREW_NPM_NODE_VERSION:-}" \
    && -n "${LOGBREW_NPM_SDK_VERSION:-}" ]] || exit 1
  local bound="$tmp_dir/receipt-artifacts"
  local metadata="$tmp_dir/receipt-metadata.json"
  python3 "$repo_root/scripts/release_artifact_receipt.py" bind \
    --family "npm-nestjs" \
    --output-dir "$bound" \
    --metadata "$metadata" \
    >"$tmp_dir/receipt-bind.out" 2>"$tmp_dir/receipt-bind.err"
  install_and_execute "$bound/0.tgz"
  python3 "$repo_root/scripts/release_artifact_receipt.py" attest \
    --family "npm-nestjs" \
    --metadata "$metadata"
}

if [[ "$receipt_mode" == "1" ]]; then
  run_receipt_smoke
  exit 0
fi

published_version="$(
  npm view "@logbrew/nestjs@${nestjs_version}" version \
    --registry "$registry" \
    --cache "$tmp_dir/npm-cache"
)"
if [[ "$published_version" != "$nestjs_version" ]]; then
  echo "expected @logbrew/nestjs@${nestjs_version} on npm" >&2
  exit 1
fi

install_and_execute "@logbrew/nestjs@${nestjs_version}"
echo "NestJS public registry install smoke passed"
