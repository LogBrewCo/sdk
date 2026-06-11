#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

core_pack_json="$tmp_dir/core-pack.json"
angular_pack_json="$tmp_dir/angular-pack.json"
(cd "$repo_root/js/logbrew-js" && npm pack --json --pack-destination "$tmp_dir") > "$core_pack_json"
(cd "$repo_root/js/logbrew-angular" && npm pack --json --pack-destination "$tmp_dir") > "$angular_pack_json"

core_tgz="$(python3 - "$core_pack_json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
print(payload[0]["filename"])
PY
)"
angular_tgz="$(python3 - "$angular_pack_json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
print(payload[0]["filename"])
PY
)"
core_tgz="$tmp_dir/$core_tgz"
angular_tgz="$tmp_dir/$angular_tgz"
test -f "$core_tgz"
test -f "$angular_tgz"

tar -tzf "$angular_tgz" > "$tmp_dir/angular-tarball.txt"
grep -q '^package/README.md$' "$tmp_dir/angular-tarball.txt"
grep -q '^package/index.js$' "$tmp_dir/angular-tarball.txt"
grep -q '^package/index.cjs$' "$tmp_dir/angular-tarball.txt"
grep -q '^package/index.d.ts$' "$tmp_dir/angular-tarball.txt"
grep -q '^package/index.d.cts$' "$tmp_dir/angular-tarball.txt"
grep -q '^package/examples/index.mjs$' "$tmp_dir/angular-tarball.txt"
grep -q '^package/examples/package.json$' "$tmp_dir/angular-tarball.txt"
grep -q '^package/examples/readme-example.mjs$' "$tmp_dir/angular-tarball.txt"
grep -q '^package/examples/real-user-smoke.mjs$' "$tmp_dir/angular-tarball.txt"
tar -xOf "$angular_tgz" package/README.md > "$tmp_dir/angular-readme.md"
grep -q 'npm install @logbrew/sdk @logbrew/angular @angular/core' "$tmp_dir/angular-readme.md"
grep -q 'pnpm add @logbrew/sdk @logbrew/angular @angular/core' "$tmp_dir/angular-readme.md"
grep -q 'LOGBREW_API_KEY' "$tmp_dir/angular-readme.md"
grep -q 'LOGBREW_CLIENT_KEY' "$tmp_dir/angular-readme.md"
grep -q 'createTraceparentFetch' "$tmp_dir/angular-readme.md"
grep -q 'createAngularTraceparent' "$tmp_dir/angular-readme.md"
grep -q 'tracePropagationTargets' "$tmp_dir/angular-readme.md"
grep -q 'provideLogBrew' "$tmp_dir/angular-readme.md"
grep -q 'injectLogBrew' "$tmp_dir/angular-readme.md"
grep -q 'delegateErrorHandler' "$tmp_dir/angular-readme.md"

app_dir="$tmp_dir/angular-smoke-app"
mkdir -p "$app_dir"
cd "$app_dir"
npm init -y >/dev/null
npm pkg set type=module >/dev/null
angular_version="$(npm view @angular/core version)"
angular_engine="$(npm view "@angular/core@$angular_version" engines.node)"
rxjs_version="$(npm view rxjs version)"
zone_version="$(npm view zone.js version)"
node_version="$(node -p 'process.version')"
npm_config_loglevel=error npm_config_engine_strict=false npm install \
  --save-exact \
  "$core_tgz" \
  "$angular_tgz" \
  "@angular/core@$angular_version" \
  "@angular/compiler@$angular_version" \
  "rxjs@$rxjs_version" \
  "zone.js@$zone_version" \
  "typescript" \
  "@types/node" \
  >/dev/null

grep -q '"@logbrew/sdk": "file:' package.json
grep -q '"@logbrew/angular": "file:' package.json
grep -q '"@angular/core":' package.json
grep -q '"@angular/compiler":' package.json
grep -q '"@logbrew/angular"' package-lock.json
grep -q '"@logbrew/sdk"' package-lock.json
npm ls @logbrew/sdk @logbrew/angular @angular/core @angular/compiler rxjs zone.js >/dev/null
npm explain @logbrew/angular > "$tmp_dir/npm-explain-angular.txt"
grep -q '@logbrew/angular@0.1.0' "$tmp_dir/npm-explain-angular.txt"
npm list --depth=0 > "$tmp_dir/npm-list-depth0.txt"
grep -q '@logbrew/angular@0.1.0' "$tmp_dir/npm-list-depth0.txt"
grep -q '@logbrew/sdk@0.1.0' "$tmp_dir/npm-list-depth0.txt"
npm list --json --depth=0 > "$tmp_dir/npm-list-depth0.json"
python3 - "$tmp_dir/npm-list-depth0.json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
deps = payload.get("dependencies", {})
for name in ("@logbrew/angular", "@logbrew/sdk", "@angular/core", "@angular/compiler", "rxjs", "zone.js"):
    if name not in deps:
        raise SystemExit(f"missing npm dependency entry: {name}")
PY

cat > smoke.mjs <<'EOF'
import { ErrorHandler, createEnvironmentInjector, runInInjectionContext } from "@angular/core";
import { RecordingTransport } from "@logbrew/sdk";
import {
  captureAngularError,
  createAngularErrorEvent,
  createAngularTraceparent,
  createAngularViewEvent,
  createLogBrewAngularClient,
  createLogBrewAngularContext,
  createTraceparentFetch,
  injectLogBrew,
  provideLogBrew,
  shouldPropagateTraceparent
} from "@logbrew/angular";

const requestTransport = new RecordingTransport([{ statusCode: 503 }, { statusCode: 202 }]);
const errorTransport = RecordingTransport.alwaysAccept();
const manualErrorTransport = RecordingTransport.alwaysAccept();
const client = createLogBrewAngularClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  maxRetries: 1,
  sdkName: "angular-smoke-app",
  sdkVersion: "0.1.0"
});

const injector = createEnvironmentInjector(provideLogBrew({
  captureErrors: false,
  client,
  transport: requestTransport
}), null);

runInInjectionContext(injector, () => {
  const logbrew = injectLogBrew();
  addFullBatch(logbrew.client);
  const event = createAngularViewEvent("AngularSmokeComponent", {
    idFactory: () => "evt_angular_view_001",
    now: () => "2026-06-02T10:00:06Z",
    path: "/smoke"
  });
  if (event.attributes.metadata.path !== "/smoke") {
    throw new Error(`unexpected view event: ${JSON.stringify(event)}`);
  }
});

const payload = client.previewJson();
await client.shutdown(requestTransport);

let delegated = false;
const errorClient = createLogBrewAngularClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "angular-error-smoke",
  sdkVersion: "0.1.0"
});
const errorInjector = createEnvironmentInjector(provideLogBrew({
  client: errorClient,
  delegateErrorHandler(error) {
    delegated = error instanceof Error && error.message === "component exploded";
  },
  errorEvent(error) {
    return createAngularErrorEvent(error, {
      component: "AngularSmokeComponent",
      info: "change detection",
      route: "/smoke"
    }, {
      idFactory: () => "evt_angular_error_001",
      now: () => "2026-06-02T10:00:07Z"
    });
  },
  transport: errorTransport
}), null);
errorInjector.get(ErrorHandler).handleError(new Error("component exploded"));
await waitFor(() => errorTransport.sentBodies.length === 1);
if (!delegated) {
  throw new Error("expected delegate error handler to be called");
}

const manualClient = createLogBrewAngularClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "angular-manual-error-smoke",
  sdkVersion: "0.1.0"
});
const manualContext = createLogBrewAngularContext(manualClient, manualErrorTransport);
await captureAngularError(new Error("manual angular failure"), manualContext, {
  component: "ManualAngularComponent",
  idFactory: () => "evt_angular_error_manual",
  now: () => "2026-06-02T10:00:08Z"
});

const errorPayload = JSON.parse(errorTransport.lastBody());
if (errorPayload.events[0].type !== "issue" || errorPayload.events[0].id !== "evt_angular_error_001") {
  throw new Error(`unexpected error payload: ${errorTransport.lastBody()}`);
}
const manualErrorPayload = JSON.parse(manualErrorTransport.lastBody());
if (manualErrorPayload.events[0].id !== "evt_angular_error_manual") {
  throw new Error(`unexpected manual error payload: ${manualErrorTransport.lastBody()}`);
}

const propagatedRequests = [];
const tracedFetch = createTraceparentFetch({
  fetchImpl: async (input, init = {}) => {
    propagatedRequests.push({ input, init });
    return { status: 204 };
  },
  traceparentFactory: () => createAngularTraceparent({
    randomValues: deterministicBytes
  }),
  tracePropagationTargets: ["https://api.example.test/", /^\/api\//u]
});
if (!shouldPropagateTraceparent("https://api.example.test/checkout", ["https://api.example.test/"])) {
  throw new Error("expected API request to match trace propagation target");
}
if (shouldPropagateTraceparent("https://cdn.example.test/app.js", ["https://api.example.test/"])) {
  throw new Error("expected CDN request not to match trace propagation target");
}
if (shouldPropagateTraceparent("https://api.example.test.evil.test/checkout", ["https://api.example.test"])) {
  throw new Error("lookalike origin must not receive traceparent");
}
if (!shouldPropagateTraceparent("https://api.example.test/v1/orders", ["https://api.example.test/v1"])) {
  throw new Error("expected same-origin path prefix to match trace propagation target");
}
if (shouldPropagateTraceparent("https://api.example.test/v10/orders", ["https://api.example.test/v1"])) {
  throw new Error("path prefix must respect segment boundaries");
}
await tracedFetch("https://api.example.test/checkout", {
  headers: { accept: "application/json", traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01" }
});
await tracedFetch("https://cdn.example.test/app.js", {
  headers: { accept: "text/javascript" }
});
await tracedFetch("/api/cart");
const propagatedTraceparent = propagatedRequests[0].init.headers.traceparent;
if (propagatedTraceparent !== "00-0102030405060708090a0b0c0d0e0f10-0102030405060708-01") {
  throw new Error(`unexpected propagated traceparent: ${propagatedTraceparent}`);
}
if (propagatedRequests[0].init.headers.accept !== "application/json") {
  throw new Error("expected traced fetch to preserve existing headers");
}
if (propagatedRequests[1].init.headers?.traceparent !== undefined) {
  throw new Error("unmatched requests should not receive traceparent");
}
if (propagatedRequests[2].init.headers.traceparent !== propagatedTraceparent) {
  throw new Error("relative matched requests should receive traceparent");
}

console.log(payload);
console.error(JSON.stringify({
  ok: true,
  attempts: requestTransport.sentBodies.length,
  delegated,
  errorCaptured: errorPayload.events[0].attributes.title,
  events: JSON.parse(payload).events.length,
  manualErrorCaptured: manualErrorPayload.events[0].attributes.title,
  propagatedTraceparent,
  viewHelper: "evt_angular_view_001"
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
  throw new Error("timed out waiting for Angular capture");
}

function deterministicBytes(length) {
  return Uint8Array.from({ length }, (_value, index) => index + 1);
}
EOF

node smoke.mjs > "$tmp_dir/angular-smoke.stdout.json" 2> "$tmp_dir/angular-smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/angular-smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/angular-smoke.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/angular-smoke.stderr.json"
grep -q '"attempts":2' "$tmp_dir/angular-smoke.stderr.json"
grep -q '"events":6' "$tmp_dir/angular-smoke.stderr.json"
grep -q '"delegated":true' "$tmp_dir/angular-smoke.stderr.json"
grep -q 'AngularSmokeComponent failed' "$tmp_dir/angular-smoke.stderr.json"
grep -q 'ManualAngularComponent failed' "$tmp_dir/angular-smoke.stderr.json"
grep -q '"propagatedTraceparent":"00-0102030405060708090a0b0c0d0e0f10-0102030405060708-01"' "$tmp_dir/angular-smoke.stderr.json"
grep -q '"viewHelper":"evt_angular_view_001"' "$tmp_dir/angular-smoke.stderr.json"

cat > consumer.ts <<'EOF'
import {
  ErrorHandler,
  type EnvironmentInjector,
  createEnvironmentInjector,
  inject,
  runInInjectionContext
} from "@angular/core";
import { RecordingTransport } from "@logbrew/sdk";
import {
  LOG_BREW_ANGULAR_CONTEXT,
  createAngularTraceparent,
  createAngularViewEvent,
  createLogBrewAngularClient,
  createTraceparentFetch,
  injectLogBrew,
  provideLogBrew,
  shouldPropagateTraceparent,
  type TracePropagationTarget
} from "@logbrew/angular";

const client = createLogBrewAngularClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "typed-angular-smoke",
  sdkVersion: "0.1.0"
});

const traceTargets: TracePropagationTarget[] = ["https://api.example.test/", /^\/api\//u];
const tracedFetch = createTraceparentFetch({
  fetchImpl: async (_input: unknown, _init?: unknown): Promise<{ status: number }> => ({ status: 204 }),
  traceparentFactory: () => createAngularTraceparent({
    randomValues: (length: number) => new Uint8Array(length).fill(7)
  }),
  tracePropagationTargets: traceTargets
});
if (!shouldPropagateTraceparent("https://api.example.test/ping", traceTargets)) {
  throw new Error("expected typed trace target to match");
}
void tracedFetch("/api/typed");

const parentInjector = null as unknown as EnvironmentInjector;
const injector = createEnvironmentInjector(provideLogBrew({
  client,
  transport: RecordingTransport.alwaysAccept()
}), parentInjector);

function preview(): string {
  return runInInjectionContext(injector, () => {
    const logbrew = injectLogBrew();
    const direct = inject(LOG_BREW_ANGULAR_CONTEXT);
    const event = createAngularViewEvent("TypedAngularSmoke", {
      path: "/typed",
      now: () => "2026-06-02T10:00:06Z"
    });
    logbrew.client.log(event.id, event.timestamp, event.attributes);
    return direct.previewJson();
  });
}

const handler: ErrorHandler = injector.get(ErrorHandler);
handler.handleError(new Error("typed angular failure"));

export { preview };
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

node -e 'const angular = require("@logbrew/angular"); if (typeof angular.provideLogBrew !== "function" || typeof angular.createTraceparentFetch !== "function" || typeof angular.createAngularTraceparent !== "function") process.exit(1)'

node node_modules/@logbrew/angular/examples/index.mjs --help > "$tmp_dir/launcher-help.txt"
grep -q 'node node_modules/@logbrew/angular/examples/index.mjs readme-example' "$tmp_dir/launcher-help.txt"
node node_modules/@logbrew/angular/examples/index.mjs --list > "$tmp_dir/launcher-list.txt"
grep -q 'real-user-smoke -> node node_modules/@logbrew/angular/examples/index.mjs real-user-smoke' "$tmp_dir/launcher-list.txt"
node node_modules/@logbrew/angular/examples/index.mjs readme-example > "$tmp_dir/example-readme.stdout.json" 2> "$tmp_dir/example-readme.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/example-readme.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/example-readme.stdout.json" >/dev/null
grep -q '"attempts":1' "$tmp_dir/example-readme.stderr.json"
grep -q '"viewHelper":"evt_angular_view_001"' "$tmp_dir/example-readme.stderr.json"
node node_modules/@logbrew/angular/examples/index.mjs > "$tmp_dir/example-default.stdout.json" 2> "$tmp_dir/example-default.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/example-default.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/example-default.stdout.json" >/dev/null
grep -q '"attempts":2' "$tmp_dir/example-default.stderr.json"
grep -q 'AngularSmokeComponent failed' "$tmp_dir/example-default.stderr.json"
grep -q '"propagatedTraceparent":"00-0102030405060708090a0b0c0d0e0f10-0102030405060708-01"' "$tmp_dir/example-default.stderr.json"
npm --prefix node_modules/@logbrew/angular/examples run list > "$tmp_dir/npm-helper-list.txt"
grep -q 'readme-example -> node node_modules/@logbrew/angular/examples/index.mjs readme-example' "$tmp_dir/npm-helper-list.txt"
npm --prefix node_modules/@logbrew/angular/examples run help > "$tmp_dir/npm-helper-help.txt"
grep -q 'npm --prefix node_modules/@logbrew/angular/examples run real-user-smoke' "$tmp_dir/npm-helper-help.txt"
npm --prefix node_modules/@logbrew/angular/examples run --silent real-user-smoke > "$tmp_dir/npm-helper-smoke.stdout.json" 2> "$tmp_dir/npm-helper-smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/npm-helper-smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/npm-helper-smoke.stdout.json" >/dev/null
grep -q '"attempts":2' "$tmp_dir/npm-helper-smoke.stderr.json"
grep -q '"propagatedTraceparent":"00-0102030405060708090a0b0c0d0e0f10-0102030405060708-01"' "$tmp_dir/npm-helper-smoke.stderr.json"

echo "angular real-user smoke passed with @angular/core@$angular_version @angular/compiler@$angular_version rxjs@$rxjs_version zone.js@$zone_version on $node_version (angular node engine: $angular_engine)"
