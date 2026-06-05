#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

core_pack_json="$tmp_dir/core-pack.json"
express_pack_json="$tmp_dir/express-pack.json"
(cd "$repo_root/js/logbrew-js" && npm pack --json --pack-destination "$tmp_dir") > "$core_pack_json"
(cd "$repo_root/js/logbrew-express" && npm pack --json --pack-destination "$tmp_dir") > "$express_pack_json"

core_tgz="$(python3 - "$core_pack_json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
print(payload[0]["filename"])
PY
)"
express_tgz="$(python3 - "$express_pack_json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
print(payload[0]["filename"])
PY
)"
core_tgz="$tmp_dir/$core_tgz"
express_tgz="$tmp_dir/$express_tgz"
test -f "$core_tgz"
test -f "$express_tgz"

tar -tzf "$express_tgz" > "$tmp_dir/express-tarball.txt"
grep -q '^package/README.md$' "$tmp_dir/express-tarball.txt"
grep -q '^package/index.js$' "$tmp_dir/express-tarball.txt"
grep -q '^package/index.cjs$' "$tmp_dir/express-tarball.txt"
grep -q '^package/index.d.ts$' "$tmp_dir/express-tarball.txt"
grep -q '^package/index.d.cts$' "$tmp_dir/express-tarball.txt"
grep -q '^package/examples/index.mjs$' "$tmp_dir/express-tarball.txt"
grep -q '^package/examples/package.json$' "$tmp_dir/express-tarball.txt"
grep -q '^package/examples/readme-example.mjs$' "$tmp_dir/express-tarball.txt"
grep -q '^package/examples/real-user-smoke.mjs$' "$tmp_dir/express-tarball.txt"
tar -xOf "$express_tgz" package/README.md > "$tmp_dir/express-readme.md"
grep -q 'npm install @logbrew/sdk @logbrew/express express' "$tmp_dir/express-readme.md"
grep -q 'pnpm add @logbrew/sdk @logbrew/express express' "$tmp_dir/express-readme.md"
grep -q 'LOGBREW_API_KEY' "$tmp_dir/express-readme.md"
grep -q 'LOGBREW_SERVER_API_KEY' "$tmp_dir/express-readme.md"
grep -q 'serverApiKey' "$tmp_dir/express-readme.md"
grep -q 'logbrewMiddleware' "$tmp_dir/express-readme.md"
grep -q 'logbrewErrorHandler' "$tmp_dir/express-readme.md"
grep -q 'traceparent' "$tmp_dir/express-readme.md"
grep -q 'spanIdFactory' "$tmp_dir/express-readme.md"

app_dir="$tmp_dir/express-smoke-app"
mkdir -p "$app_dir"
cd "$app_dir"
npm init -y >/dev/null
npm pkg set type=module >/dev/null
express_version="$(npm view express version)"
types_express_version="$(npm view @types/express version)"
npm install \
  --save-exact \
  "$core_tgz" \
  "$express_tgz" \
  "express@$express_version" \
  "typescript" \
  "@types/node" \
  "@types/express@$types_express_version" \
  >/dev/null

grep -q '"@logbrew/sdk": "file:' package.json
grep -q '"@logbrew/express": "file:' package.json
grep -q '"express":' package.json
grep -q '"@logbrew/express"' package-lock.json
grep -q '"@logbrew/sdk"' package-lock.json
npm ls @logbrew/sdk @logbrew/express express >/dev/null
npm explain @logbrew/express > "$tmp_dir/npm-explain-express.txt"
grep -q '@logbrew/express@0.1.0' "$tmp_dir/npm-explain-express.txt"
npm list --depth=0 > "$tmp_dir/npm-list-depth0.txt"
grep -q '@logbrew/express@0.1.0' "$tmp_dir/npm-list-depth0.txt"
grep -q '@logbrew/sdk@0.1.0' "$tmp_dir/npm-list-depth0.txt"
npm list --json --depth=0 > "$tmp_dir/npm-list-depth0.json"
python3 - "$tmp_dir/npm-list-depth0.json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
deps = payload.get("dependencies", {})
for name in ("@logbrew/express", "@logbrew/sdk", "express"):
    if name not in deps:
        raise SystemExit(f"missing npm dependency entry: {name}")
PY

cat > smoke.mjs <<'EOF'
import express from "express";
import { RecordingTransport } from "@logbrew/sdk";
import {
  createErrorEvent,
  createLogBrewExpressClient,
  createRequestEvent,
  logbrewErrorHandler,
  logbrewMiddleware
} from "@logbrew/express";

const requestTransport = new RecordingTransport([{ statusCode: 503 }, { statusCode: 202 }]);
const autoTransport = RecordingTransport.alwaysAccept();
const errorTransport = RecordingTransport.alwaysAccept();
const app = express();

const explicitClient = createLogBrewExpressClient({
  apiKey: "LOGBREW_API_KEY",
  sdkName: "express-smoke-explicit",
  sdkVersion: "0.1.0"
});
if (explicitClient.pendingEvents() !== 0) {
  throw new Error("expected empty explicit client");
}

app.use("/logbrew", logbrewMiddleware({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "express-smoke-app",
  sdkVersion: "0.1.0",
  maxRetries: 1,
  captureRequests: false,
  transport: requestTransport
}));

app.get("/logbrew", (req, res) => {
  addFullBatch(req.logbrew.client);
  res.type("json").send(req.logbrew.previewJson());
  void req.logbrew.shutdown();
});

app.use("/auto", logbrewMiddleware({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "express-auto-smoke",
  sdkVersion: "0.1.0",
  transport: autoTransport,
  now: () => "2026-06-02T10:00:06Z",
  nowMs: () => 100,
  requestEvent(req, res, { durationMs }) {
    return createRequestEvent(req, res, {
      now: () => "2026-06-02T10:00:06Z",
      durationMs,
      idFactory: () => "evt_express_request_001",
      spanIdFactory: () => "b7ad6b7169203331"
    });
  }
}));

app.get("/auto", (_req, res) => {
  res.json({ ok: true });
});

app.get("/fail", async () => {
  throw new Error("route exploded");
});

app.use(logbrewErrorHandler({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  transport: errorTransport,
  now: () => "2026-06-02T10:00:07Z",
  idFactory: () => "evt_express_error_001"
}));

app.use((error, _req, res, _next) => {
  void _next;
  res.status(500).json({ error: error.message });
});

const server = app.listen(0);
const port = server.address().port;

const okResponse = await fetch(`http://127.0.0.1:${port}/logbrew`);
const okText = await okResponse.text();
const autoResponse = await fetch(`http://127.0.0.1:${port}/auto?token=secret`, {
  headers: {
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
  }
});
await autoResponse.json();
await waitFor(() => autoTransport.sentBodies.length === 1);
const failResponse = await fetch(`http://127.0.0.1:${port}/fail?token=secret`);
await failResponse.json();
await waitFor(() => errorTransport.sentBodies.length === 1);
await new Promise((resolve) => {
  server.close(resolve);
});

const autoPayload = JSON.parse(autoTransport.lastBody());
if (autoPayload.events[0].type !== "span" || autoPayload.events[0].id !== "evt_express_request_001") {
  throw new Error(`unexpected auto request payload: ${autoTransport.lastBody()}`);
}
if (autoPayload.events[0].attributes.traceId !== "4bf92f3577b34da6a3ce929d0e0e4736") {
  throw new Error(`unexpected express trace id: ${autoTransport.lastBody()}`);
}
if (autoPayload.events[0].attributes.parentSpanId !== "00f067aa0ba902b7") {
  throw new Error(`unexpected express parent span id: ${autoTransport.lastBody()}`);
}
if (autoPayload.events[0].attributes.spanId !== "b7ad6b7169203331") {
  throw new Error(`unexpected express request span id: ${autoTransport.lastBody()}`);
}
if (autoPayload.events[0].attributes.metadata.framework !== "express") {
  throw new Error(`missing express span metadata: ${autoTransport.lastBody()}`);
}
if (autoPayload.events[0].attributes.metadata.path !== "/auto") {
  throw new Error(`request capture should omit query text: ${autoTransport.lastBody()}`);
}
const errorPayload = JSON.parse(errorTransport.lastBody());
if (errorPayload.events[0].type !== "issue" || errorPayload.events[0].id !== "evt_express_error_001") {
  throw new Error(`unexpected error payload: ${errorTransport.lastBody()}`);
}
if (errorPayload.events[0].attributes.metadata.path !== "/fail") {
  throw new Error(`error capture should omit query text: ${errorTransport.lastBody()}`);
}
const errorPreview = createErrorEvent(new Error("manual failure"), { method: "POST", originalUrl: "/manual" }, {
  now: () => "2026-06-02T10:00:08Z",
  idFactory: () => "evt_express_error_preview"
});
if (errorPreview.attributes.title !== "POST /manual failed") {
  throw new Error(`unexpected error preview: ${JSON.stringify(errorPreview)}`);
}

console.log(okText);
console.error(JSON.stringify({
  ok: true,
  status: okResponse.status,
  attempts: requestTransport.sentBodies.length,
  autoCaptured: autoPayload.events[0].attributes.name,
  autoTraceId: autoPayload.events[0].attributes.traceId,
  errorStatus: failResponse.status,
  errorCaptured: errorPayload.events[0].attributes.title,
  events: 6
}));

function addFullBatch(client) {
  client.release("evt_release_001", "2026-06-02T10:00:00Z", {
    version: "1.2.3",
    commit: "abc123def456",
    notes: "Public release marker"
  });
  client.environment("evt_environment_001", "2026-06-02T10:00:01Z", {
    name: "production",
    region: "global"
  });
  client.issue("evt_issue_001", "2026-06-02T10:00:02Z", {
    title: "Checkout timeout",
    level: "error",
    message: "Request timed out after retry budget"
  });
  client.log("evt_log_001", "2026-06-02T10:00:03Z", {
    message: "worker started",
    level: "info",
    logger: "job-runner"
  });
  client.span("evt_span_001", "2026-06-02T10:00:04Z", {
    name: "GET /health",
    traceId: "trace_001",
    spanId: "span_001",
    status: "ok",
    durationMs: 12.5
  });
  client.action("evt_action_001", "2026-06-02T10:00:05Z", {
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
  throw new Error("timed out waiting for Express capture");
}
EOF

node smoke.mjs > "$tmp_dir/express-smoke.stdout.json" 2> "$tmp_dir/express-smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/express-smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/express-smoke.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/express-smoke.stderr.json"
grep -q '"attempts":2' "$tmp_dir/express-smoke.stderr.json"
grep -q '"errorStatus":500' "$tmp_dir/express-smoke.stderr.json"
grep -q 'GET /auto' "$tmp_dir/express-smoke.stderr.json"
grep -q '4bf92f3577b34da6a3ce929d0e0e4736' "$tmp_dir/express-smoke.stderr.json"
grep -q 'GET /fail failed' "$tmp_dir/express-smoke.stderr.json"

cat > consumer.ts <<'EOF'
import express, { type NextFunction, type Request, type Response } from "express";
import { RecordingTransport } from "@logbrew/sdk";
import {
  createLogBrewExpressClient,
  createRequestEvent,
  logbrewErrorHandler,
  logbrewMiddleware
} from "@logbrew/express";

const app = express();
const client = createLogBrewExpressClient({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "typed-express-smoke",
  sdkVersion: "0.1.0"
});

app.use(logbrewMiddleware({
  client,
  transport: RecordingTransport.alwaysAccept(),
  requestEvent(req, res, { durationMs }) {
    const event = createRequestEvent(req, res, {
      durationMs,
      now: () => "2026-06-02T10:00:06Z",
      spanIdFactory: () => "b7ad6b7169203331"
    });
    if (event.type === "span") {
      event.attributes.parentSpanId?.toUpperCase();
    }
    return event;
  }
}));

app.get("/typed", (req: Request, res: Response) => {
  req.logbrew?.client.log("evt_log_001", "2026-06-02T10:00:03Z", {
    message: "typed worker",
    level: "info"
  });
  res.json({ pending: req.logbrew?.client.pendingEvents() ?? 0 });
});

app.use(logbrewErrorHandler({
  client,
  transport: RecordingTransport.alwaysAccept()
}));

app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
  void _next;
  res.status(500).json({ error: error.message });
});

export { app };
EOF

cat > tsconfig.json <<'EOF'
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
EOF
npx tsc --project tsconfig.json

node -e 'const express = require("@logbrew/express"); if (typeof express.logbrewMiddleware !== "function") process.exit(1)'

node node_modules/@logbrew/express/examples/index.mjs --help > "$tmp_dir/launcher-help.txt"
grep -q 'node node_modules/@logbrew/express/examples/index.mjs readme-example' "$tmp_dir/launcher-help.txt"
node node_modules/@logbrew/express/examples/index.mjs --list > "$tmp_dir/launcher-list.txt"
grep -q 'real-user-smoke -> node node_modules/@logbrew/express/examples/index.mjs real-user-smoke' "$tmp_dir/launcher-list.txt"
node node_modules/@logbrew/express/examples/index.mjs readme-example > "$tmp_dir/example-readme.stdout.json" 2> "$tmp_dir/example-readme.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/example-readme.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/example-readme.stdout.json" >/dev/null
grep -q '"attempts":1' "$tmp_dir/example-readme.stderr.json"
node node_modules/@logbrew/express/examples/index.mjs > "$tmp_dir/example-default.stdout.json" 2> "$tmp_dir/example-default.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/example-default.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/example-default.stdout.json" >/dev/null
grep -q '"attempts":2' "$tmp_dir/example-default.stderr.json"
grep -q '"errorStatus":500' "$tmp_dir/example-default.stderr.json"
npm --prefix node_modules/@logbrew/express/examples run list > "$tmp_dir/npm-helper-list.txt"
grep -q 'readme-example -> node node_modules/@logbrew/express/examples/index.mjs readme-example' "$tmp_dir/npm-helper-list.txt"
npm --prefix node_modules/@logbrew/express/examples run help > "$tmp_dir/npm-helper-help.txt"
grep -q 'npm --prefix node_modules/@logbrew/express/examples run real-user-smoke' "$tmp_dir/npm-helper-help.txt"
npm --prefix node_modules/@logbrew/express/examples run --silent real-user-smoke > "$tmp_dir/npm-helper-smoke.stdout.json" 2> "$tmp_dir/npm-helper-smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/npm-helper-smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/npm-helper-smoke.stdout.json" >/dev/null
grep -q '"attempts":2' "$tmp_dir/npm-helper-smoke.stderr.json"

echo "express real-user smoke passed with express@$express_version @types/express@$types_express_version"
