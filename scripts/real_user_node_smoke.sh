#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sdk_package_version="$(node -p "require('${repo_root}/js/logbrew-js/package.json').version")"
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
core_tgz="$tmp_dir/$core_tgz"
node_tgz="$tmp_dir/$node_tgz"
test -f "$core_tgz"
test -f "$node_tgz"

tar -tzf "$node_tgz" > "$tmp_dir/node-tarball.txt"
grep -q '^package/README.md$' "$tmp_dir/node-tarball.txt"
grep -q '^package/index.js$' "$tmp_dir/node-tarball.txt"
grep -q '^package/index.cjs$' "$tmp_dir/node-tarball.txt"
grep -q '^package/index.d.ts$' "$tmp_dir/node-tarball.txt"
grep -q '^package/index.d.cts$' "$tmp_dir/node-tarball.txt"
grep -q '^package/examples/index.mjs$' "$tmp_dir/node-tarball.txt"
grep -q '^package/examples/package.json$' "$tmp_dir/node-tarball.txt"
grep -q '^package/examples/readme-example.mjs$' "$tmp_dir/node-tarball.txt"
grep -q '^package/examples/real-user-smoke.mjs$' "$tmp_dir/node-tarball.txt"
tar -xOf "$node_tgz" package/README.md > "$tmp_dir/node-readme.md"
grep -q 'npm install @logbrew/sdk @logbrew/node' "$tmp_dir/node-readme.md"
grep -q 'pnpm add @logbrew/sdk @logbrew/node' "$tmp_dir/node-readme.md"
grep -q 'LOGBREW_API_KEY' "$tmp_dir/node-readme.md"
grep -q 'LOGBREW_SERVER_API_KEY' "$tmp_dir/node-readme.md"
grep -q 'serverApiKey' "$tmp_dir/node-readme.md"
grep -q 'createNodeFetchTransport' "$tmp_dir/node-readme.md"
grep -q 'withLogBrewHttpHandler' "$tmp_dir/node-readme.md"
grep -q 'node:http' "$tmp_dir/node-readme.md"
grep -q 'traceparent' "$tmp_dir/node-readme.md"
grep -q 'spanIdFactory' "$tmp_dir/node-readme.md"

app_dir="$tmp_dir/node-smoke-app"
mkdir -p "$app_dir"
cd "$app_dir"
npm init -y >/dev/null
npm pkg set type=module >/dev/null
npm install \
  --save-exact \
  "$core_tgz" \
  "$node_tgz" \
  "typescript" \
  "@types/node" \
  >/dev/null

grep -q '"@logbrew/sdk": "file:' package.json
grep -q '"@logbrew/node": "file:' package.json
grep -q '"@logbrew/node"' package-lock.json
grep -q '"@logbrew/sdk"' package-lock.json
npm ls @logbrew/sdk @logbrew/node >/dev/null
npm explain @logbrew/node > "$tmp_dir/npm-explain-node.txt"
grep -q '@logbrew/node@0.1.0' "$tmp_dir/npm-explain-node.txt"
npm list --depth=0 > "$tmp_dir/npm-list-depth0.txt"
grep -q '@logbrew/node@0.1.0' "$tmp_dir/npm-list-depth0.txt"
grep -q "@logbrew/sdk@${sdk_package_version}" "$tmp_dir/npm-list-depth0.txt"
npm list --json --depth=0 > "$tmp_dir/npm-list-depth0.json"
python3 - "$tmp_dir/npm-list-depth0.json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
deps = payload.get("dependencies", {})
for name in ("@logbrew/node", "@logbrew/sdk"):
    if name not in deps:
        raise SystemExit(f"missing npm dependency entry: {name}")
PY

cat > smoke.mjs <<'EOF'
import { createServer } from "node:http";
import { once } from "node:events";
import { RecordingTransport } from "@logbrew/sdk";
import {
  captureHttpError,
  createNodeFetchTransport,
  createHttpErrorEvent,
  createHttpRequestEvent,
  createLogBrewNodeClient,
  createLogBrewNodeContext,
  withLogBrewHttpHandler
} from "@logbrew/node";

const requestTransport = new RecordingTransport([{ statusCode: 503 }, { statusCode: 202 }]);
const client = createLogBrewNodeClient({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  maxRetries: 1,
  sdkName: "node-smoke-app",
  sdkVersion: "0.1.0"
});
const legacyClient = createLogBrewNodeClient({
  apiKey: "LOGBREW_API_KEY",
  sdkName: "node-legacy-api-key-smoke",
  sdkVersion: "0.1.0"
});
if (legacyClient.pendingEvents() !== 0) {
  throw new Error("expected empty legacy client");
}
const previousServerApiKey = process.env.LOGBREW_SERVER_API_KEY;
process.env.LOGBREW_SERVER_API_KEY = "LOGBREW_SERVER_API_KEY";
const envClient = createLogBrewNodeClient({
  sdkName: "node-env-smoke",
  sdkVersion: "0.1.0"
});
if (previousServerApiKey === undefined) {
  delete process.env.LOGBREW_SERVER_API_KEY;
} else {
  process.env.LOGBREW_SERVER_API_KEY = previousServerApiKey;
}
if (envClient.pendingEvents() !== 0) {
  throw new Error("expected empty env fallback client");
}

const server = createServer(withLogBrewHttpHandler((req, res, logbrew) => {
  addFullBatch(logbrew.client);
  const event = createHttpRequestEvent(req, res, {
    idFactory: () => "evt_node_request_001",
    now: () => "2026-06-02T10:00:06Z"
  });
  if (event.attributes.metadata.path !== "/smoke") {
    throw new Error(`unexpected request event: ${JSON.stringify(event)}`);
  }
  res.end("ok");
}, {
  captureRequests: false,
  client,
  transport: requestTransport
}));

server.listen(0);
await once(server, "listening");
const port = server.address().port;
const response = await fetch(`http://127.0.0.1:${port}/smoke`);
if (response.status !== 200) {
  throw new Error(`unexpected status: ${response.status}`);
}
const payload = client.previewJson();
await client.shutdown(requestTransport);
await closeServer(server);

const captureTransport = RecordingTransport.alwaysAccept();
const captureClient = createLogBrewNodeClient({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "node-request-capture-smoke",
  sdkVersion: "0.1.0"
});
const captureServer = createServer(withLogBrewHttpHandler((req, res) => {
  res.statusCode = req.url?.startsWith("/captured") ? 204 : 404;
  res.end();
}, {
  client: captureClient,
  idFactory: () => "evt_node_request_auto",
  now: () => "2026-06-02T10:00:07Z",
  spanIdFactory: () => "b7ad6b7169203331",
  transport: captureTransport
}));
captureServer.listen(0);
await once(captureServer, "listening");
const capturePort = captureServer.address().port;
const captureResponse = await fetch(`http://127.0.0.1:${capturePort}/captured?token=secret`, {
  headers: {
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
  }
});
if (captureResponse.status !== 204) {
  throw new Error(`unexpected capture status: ${captureResponse.status}`);
}
await waitFor(() => captureTransport.sentBodies.length === 1);
await closeServer(captureServer);

const errorTransport = RecordingTransport.alwaysAccept();
const errorClient = createLogBrewNodeClient({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "node-error-smoke",
  sdkVersion: "0.1.0"
});
const errorServer = createServer(withLogBrewHttpHandler(() => {
  throw new Error("node handler exploded");
}, {
  client: errorClient,
  errorEvent(error, { req }) {
    return createHttpErrorEvent(error, req, {
      idFactory: () => "evt_node_error_001",
      now: () => "2026-06-02T10:00:08Z"
    });
  },
  transport: errorTransport
}));
errorServer.listen(0);
await once(errorServer, "listening");
const errorPort = errorServer.address().port;
const errorResponse = await fetch(`http://127.0.0.1:${errorPort}/explode?token=secret`);
if (errorResponse.status !== 500) {
  throw new Error(`unexpected error status: ${errorResponse.status}`);
}
await waitFor(() => errorTransport.sentBodies.length === 1);
await closeServer(errorServer);

const manualErrorTransport = RecordingTransport.alwaysAccept();
const manualErrorClient = createLogBrewNodeClient({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "node-manual-error-smoke",
  sdkVersion: "0.1.0"
});
const manualServer = createServer(async (req, res) => {
  const context = createLogBrewNodeContext(manualErrorClient, manualErrorTransport);
  await captureHttpError(new Error("manual node failure"), req, res, context, {
    idFactory: () => "evt_node_error_manual",
    now: () => "2026-06-02T10:00:09Z"
  });
  res.end("captured");
});
manualServer.listen(0);
await once(manualServer, "listening");
const manualPort = manualServer.address().port;
const manualResponse = await fetch(`http://127.0.0.1:${manualPort}/manual?token=secret`);
if (manualResponse.status !== 200) {
  throw new Error(`unexpected manual status: ${manualResponse.status}`);
}
await waitFor(() => manualErrorTransport.sentBodies.length === 1);
await closeServer(manualServer);

const intakeRequests = [];
const intakeServer = createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    intakeRequests.push({
      authorization: req.headers.authorization,
      body,
      contentType: req.headers["content-type"],
      method: req.method,
      source: req.headers["x-logbrew-source"],
      url: req.url
    });
    res.statusCode = intakeRequests.length === 1 ? 503 : 202;
    res.end("accepted");
  });
});
intakeServer.listen(0);
await once(intakeServer, "listening");
const intakePort = intakeServer.address().port;
const httpClient = createLogBrewNodeClient({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  maxRetries: 1,
  sdkName: "node-fetch-transport-smoke",
  sdkVersion: "0.1.0"
});
const httpTransport = createNodeFetchTransport({
  endpoint: `http://127.0.0.1:${intakePort}/v1/events`,
  headers: {
    "x-logbrew-source": "node-smoke"
  }
});
httpClient.log("evt_node_fetch_transport", "2026-06-02T10:00:10Z", {
  message: "node fetch transport sent",
  level: "info",
  logger: "node"
});
const httpResponse = await httpClient.flush(httpTransport);
await closeServer(intakeServer);
if (httpResponse.statusCode !== 202 || httpResponse.attempts !== 2) {
  throw new Error(`unexpected fetch transport response: ${JSON.stringify(httpResponse)}`);
}
if (httpClient.pendingEvents() !== 0 || intakeRequests.length !== 2) {
  throw new Error(`unexpected fetch transport state: ${JSON.stringify({ pending: httpClient.pendingEvents(), requests: intakeRequests.length })}`);
}
if (intakeRequests[0].authorization !== "Bearer LOGBREW_SERVER_API_KEY") {
  throw new Error(`unexpected authorization header: ${intakeRequests[0].authorization}`);
}
if (intakeRequests[0].source !== "node-smoke" || intakeRequests[0].method !== "POST" || intakeRequests[0].url !== "/v1/events") {
  throw new Error(`unexpected intake request metadata: ${JSON.stringify(intakeRequests[0])}`);
}
const intakePayload = JSON.parse(intakeRequests[1].body);
if (intakePayload.events[0].id !== "evt_node_fetch_transport") {
  throw new Error(`unexpected fetch transport payload: ${intakeRequests[1].body}`);
}

const capturePayload = JSON.parse(captureTransport.lastBody());
const errorPayload = JSON.parse(errorTransport.lastBody());
const manualErrorPayload = JSON.parse(manualErrorTransport.lastBody());
if (capturePayload.events[0].id !== "evt_node_request_auto") {
  throw new Error(`unexpected request capture payload: ${captureTransport.lastBody()}`);
}
if (capturePayload.events[0].attributes.metadata.path !== "/captured") {
  throw new Error(`request capture should omit query text: ${captureTransport.lastBody()}`);
}
if (capturePayload.events[0].type !== "span") {
  throw new Error(`expected node request span payload: ${captureTransport.lastBody()}`);
}
if (capturePayload.events[0].attributes.traceId !== "4bf92f3577b34da6a3ce929d0e0e4736") {
  throw new Error(`unexpected node trace id: ${captureTransport.lastBody()}`);
}
if (capturePayload.events[0].attributes.parentSpanId !== "00f067aa0ba902b7") {
  throw new Error(`unexpected node parent span id: ${captureTransport.lastBody()}`);
}
if (capturePayload.events[0].attributes.spanId !== "b7ad6b7169203331") {
  throw new Error(`unexpected node request span id: ${captureTransport.lastBody()}`);
}
if (capturePayload.events[0].attributes.metadata.framework !== "node:http") {
  throw new Error(`missing node span metadata: ${captureTransport.lastBody()}`);
}
if (errorPayload.events[0].id !== "evt_node_error_001") {
  throw new Error(`unexpected error payload: ${errorTransport.lastBody()}`);
}
if (errorPayload.events[0].attributes.metadata.path !== "/explode") {
  throw new Error(`error capture should omit query text: ${errorTransport.lastBody()}`);
}
if (manualErrorPayload.events[0].id !== "evt_node_error_manual") {
  throw new Error(`unexpected manual error payload: ${manualErrorTransport.lastBody()}`);
}
if (manualErrorPayload.events[0].attributes.metadata.path !== "/manual") {
  throw new Error(`manual error capture should omit query text: ${manualErrorTransport.lastBody()}`);
}

console.log(payload);
console.error(JSON.stringify({
  ok: true,
  attempts: requestTransport.sentBodies.length,
  errorCaptured: errorPayload.events[0].attributes.title,
  events: JSON.parse(payload).events.length,
  httpAttempts: httpResponse.attempts,
  httpEvents: intakePayload.events.length,
  manualErrorCaptured: manualErrorPayload.events[0].attributes.title,
  requestCaptured: capturePayload.events[0].attributes.name,
  requestTraceId: capturePayload.events[0].attributes.traceId,
  requestHelper: "evt_node_request_001"
}));

function addFullBatch(logbrew) {
  logbrew.release("evt_release_001", "2026-06-02T10:00:00Z", {
    version: "1.2.3",
    commit: "abc123def456",
    notes: "Public release marker"
  });
  logbrew.environment("evt_environment_001", "2026-06-02T10:00:01Z", {
    name: "production",
    region: "global"
  });
  logbrew.issue("evt_issue_001", "2026-06-02T10:00:02Z", {
    title: "Checkout timeout",
    level: "error",
    message: "Request timed out after retry budget"
  });
  logbrew.log("evt_log_001", "2026-06-02T10:00:03Z", {
    message: "worker started",
    level: "info",
    logger: "job-runner"
  });
  logbrew.span("evt_span_001", "2026-06-02T10:00:04Z", {
    name: "GET /health",
    traceId: "trace_001",
    spanId: "span_001",
    status: "ok",
    durationMs: 12.5
  });
  logbrew.action("evt_action_001", "2026-06-02T10:00:05Z", {
    name: "deploy",
    status: "success"
  });
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error("timed out waiting for Node.js capture");
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
EOF

node smoke.mjs > "$tmp_dir/node-smoke.stdout.json" 2> "$tmp_dir/node-smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/node-smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/node-smoke.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/node-smoke.stderr.json"
grep -q '"attempts":2' "$tmp_dir/node-smoke.stderr.json"
grep -q '"events":6' "$tmp_dir/node-smoke.stderr.json"
grep -q '"httpAttempts":2' "$tmp_dir/node-smoke.stderr.json"
grep -q '"httpEvents":1' "$tmp_dir/node-smoke.stderr.json"
grep -q 'GET /explode failed' "$tmp_dir/node-smoke.stderr.json"
grep -q 'GET /manual failed' "$tmp_dir/node-smoke.stderr.json"
grep -q 'GET /captured' "$tmp_dir/node-smoke.stderr.json"
grep -q '4bf92f3577b34da6a3ce929d0e0e4736' "$tmp_dir/node-smoke.stderr.json"
grep -q '"requestHelper":"evt_node_request_001"' "$tmp_dir/node-smoke.stderr.json"

cat > consumer.ts <<'EOF'
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  createNodeFetchTransport,
  createHttpRequestEvent,
  createLogBrewNodeClient,
  type LogBrewNodeContext,
  withLogBrewHttpHandler
} from "@logbrew/node";

const client = createLogBrewNodeClient({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "typed-node-smoke",
  sdkVersion: "0.1.0"
});
const transport = createNodeFetchTransport({
  endpoint: "http://127.0.0.1:4318/v1/events",
  fetchImpl: async () => new Response("accepted", { status: 202 })
});

const handler = withLogBrewHttpHandler((
  req: IncomingMessage,
  res: ServerResponse,
  context: LogBrewNodeContext
): void => {
  if (!req.logbrew) {
    throw new Error("missing request context");
  }
  const event = createHttpRequestEvent(req, res, {
    now: () => "2026-06-02T10:00:06Z",
    spanIdFactory: () => "b7ad6b7169203331"
  });
  if (event.type === "span") {
    event.attributes.parentSpanId?.toUpperCase();
    context.client.span(event.id, event.timestamp, event.attributes);
  } else {
    context.client.log(event.id, event.timestamp, event.attributes);
  }
  res.end(`${req.logbrew.client.pendingEvents()}`);
}, {
  client,
  captureRequests: false,
  transport
});

const server = createServer(handler);

export { handler, server };
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

node -e 'const node = require("@logbrew/node"); if (typeof node.withLogBrewHttpHandler !== "function") process.exit(1)'
node -e 'const node = require("@logbrew/node"); if (typeof node.createNodeFetchTransport !== "function") process.exit(1)'

node node_modules/@logbrew/node/examples/index.mjs --help > "$tmp_dir/launcher-help.txt"
grep -q 'node node_modules/@logbrew/node/examples/index.mjs readme-example' "$tmp_dir/launcher-help.txt"
node node_modules/@logbrew/node/examples/index.mjs --list > "$tmp_dir/launcher-list.txt"
grep -q 'real-user-smoke -> node node_modules/@logbrew/node/examples/index.mjs real-user-smoke' "$tmp_dir/launcher-list.txt"
node node_modules/@logbrew/node/examples/index.mjs readme-example > "$tmp_dir/example-readme.stdout.json" 2> "$tmp_dir/example-readme.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/example-readme.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/example-readme.stdout.json" >/dev/null
grep -q '"attempts":1' "$tmp_dir/example-readme.stderr.json"
grep -q '"requestHelper":"evt_node_request_001"' "$tmp_dir/example-readme.stderr.json"
node node_modules/@logbrew/node/examples/index.mjs > "$tmp_dir/example-default.stdout.json" 2> "$tmp_dir/example-default.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/example-default.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/example-default.stdout.json" >/dev/null
grep -q '"attempts":2' "$tmp_dir/example-default.stderr.json"
grep -q 'GET /explode failed' "$tmp_dir/example-default.stderr.json"
npm --prefix node_modules/@logbrew/node/examples run list > "$tmp_dir/npm-helper-list.txt"
grep -q 'readme-example -> node node_modules/@logbrew/node/examples/index.mjs readme-example' "$tmp_dir/npm-helper-list.txt"
npm --prefix node_modules/@logbrew/node/examples run help > "$tmp_dir/npm-helper-help.txt"
grep -q 'npm --prefix node_modules/@logbrew/node/examples run real-user-smoke' "$tmp_dir/npm-helper-help.txt"
npm --prefix node_modules/@logbrew/node/examples run --silent real-user-smoke > "$tmp_dir/npm-helper-smoke.stdout.json" 2> "$tmp_dir/npm-helper-smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/npm-helper-smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/npm-helper-smoke.stdout.json" >/dev/null
grep -q '"attempts":2' "$tmp_dir/npm-helper-smoke.stderr.json"

echo "node real-user smoke passed with $(node --version)"
