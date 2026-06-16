#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sdk_package_version="$(node -p "require('${repo_root}/js/logbrew-js/package.json').version")"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

core_pack_json="$tmp_dir/core-pack.json"
next_pack_json="$tmp_dir/next-pack.json"
(cd "$repo_root/js/logbrew-js" && npm pack --json --pack-destination "$tmp_dir") > "$core_pack_json"
(cd "$repo_root/js/logbrew-next" && npm pack --json --pack-destination "$tmp_dir") > "$next_pack_json"

core_tgz="$(python3 - "$core_pack_json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
print(payload[0]["filename"])
PY
)"
next_tgz="$(python3 - "$next_pack_json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
print(payload[0]["filename"])
PY
)"
core_tgz="$tmp_dir/$core_tgz"
next_tgz="$tmp_dir/$next_tgz"
test -f "$core_tgz"
test -f "$next_tgz"

tar -tzf "$next_tgz" > "$tmp_dir/next-tarball.txt"
grep -q '^package/README.md$' "$tmp_dir/next-tarball.txt"
grep -q '^package/index.js$' "$tmp_dir/next-tarball.txt"
grep -q '^package/index.cjs$' "$tmp_dir/next-tarball.txt"
grep -q '^package/index.d.ts$' "$tmp_dir/next-tarball.txt"
grep -q '^package/index.d.cts$' "$tmp_dir/next-tarball.txt"
grep -q '^package/examples/index.mjs$' "$tmp_dir/next-tarball.txt"
grep -q '^package/examples/package.json$' "$tmp_dir/next-tarball.txt"
grep -q '^package/examples/readme-example.mjs$' "$tmp_dir/next-tarball.txt"
grep -q '^package/examples/real-user-smoke.mjs$' "$tmp_dir/next-tarball.txt"
tar -xOf "$next_tgz" package/README.md > "$tmp_dir/next-readme.md"
grep -q 'npm install @logbrew/sdk @logbrew/next next react react-dom' "$tmp_dir/next-readme.md"
grep -q 'pnpm add @logbrew/sdk @logbrew/next next react react-dom' "$tmp_dir/next-readme.md"
grep -q 'LOGBREW_API_KEY' "$tmp_dir/next-readme.md"
grep -q 'LOGBREW_SERVER_API_KEY' "$tmp_dir/next-readme.md"
grep -q 'serverApiKey' "$tmp_dir/next-readme.md"
grep -q 'includeSearchParams' "$tmp_dir/next-readme.md"
grep -q 'withLogBrewRouteHandler' "$tmp_dir/next-readme.md"
grep -q 'proxy.js' "$tmp_dir/next-readme.md"
grep -q 'traceparent' "$tmp_dir/next-readme.md"
grep -q 'getActiveLogBrewTrace' "$tmp_dir/next-readme.md"
grep -q 'captureRequests: false' "$tmp_dir/next-readme.md"
grep -q 'spanIdFactory' "$tmp_dir/next-readme.md"
grep -q 'onCaptureError' "$tmp_dir/next-readme.md"
grep -q 'captureRequestMetrics' "$tmp_dir/next-readme.md"
grep -q 'http.server.duration' "$tmp_dir/next-readme.md"
grep -q 'routeTemplate' "$tmp_dir/next-readme.md"

app_dir="$tmp_dir/next-smoke-app"
mkdir -p "$app_dir/app/api/logbrew"
cd "$app_dir"
npm init -y >/dev/null
npm pkg set type=module >/dev/null
npm pkg set scripts.build="next build" >/dev/null
next_version="$(npm view next version)"
react_version="$(npm view react version)"
react_dom_version="$(npm view react-dom version)"
npm install \
  --save-exact \
  "$core_tgz" \
  "$next_tgz" \
  "next@$next_version" \
  "react@$react_version" \
  "react-dom@$react_dom_version" \
  typescript \
  @types/node \
  >/dev/null

grep -q '"@logbrew/sdk": "file:' package.json
grep -q '"@logbrew/next": "file:' package.json
grep -q '"next":' package.json
grep -q '"react":' package.json
grep -q '"react-dom":' package.json
grep -q '"@logbrew/next"' package-lock.json
grep -q '"@logbrew/sdk"' package-lock.json
npm ls @logbrew/sdk @logbrew/next next react react-dom >/dev/null
npm explain @logbrew/next > "$tmp_dir/npm-explain-next.txt"
grep -q '@logbrew/next@0.1.0' "$tmp_dir/npm-explain-next.txt"
npm list --depth=0 > "$tmp_dir/npm-list-depth0.txt"
grep -q '@logbrew/next@0.1.0' "$tmp_dir/npm-list-depth0.txt"
grep -q "@logbrew/sdk@${sdk_package_version}" "$tmp_dir/npm-list-depth0.txt"
npm list --json --depth=0 > "$tmp_dir/npm-list-depth0.json"
python3 - "$tmp_dir/npm-list-depth0.json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
deps = payload.get("dependencies", {})
for name in ("@logbrew/next", "@logbrew/sdk", "next", "react", "react-dom"):
    if name not in deps:
        raise SystemExit(f"missing npm dependency entry: {name}")
PY

cat > app/layout.jsx <<'EOF'
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
EOF

cat > app/page.jsx <<'EOF'
export default function Page() {
  return "LogBrew Next smoke";
}
EOF

cat > app/api/logbrew/transport.js <<'EOF'
import { RecordingTransport } from "@logbrew/sdk";

export const transport = new RecordingTransport([{ statusCode: 503 }, { statusCode: 202 }]);
EOF

cat > app/api/logbrew/route.js <<'EOF'
import { withLogBrewRouteHandler } from "@logbrew/next";
import { transport } from "./transport.js";

export const runtime = "nodejs";

export const POST = withLogBrewRouteHandler(
  async (_request, _context, { client }) => {
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
    return Response.json(JSON.parse(client.previewJson()));
  },
  {
    serverApiKey: "LOGBREW_SERVER_API_KEY",
    captureRequests: false,
    sdkName: "next-smoke-app",
    sdkVersion: "0.1.0",
    maxRetries: 1,
    transport
  }
);
EOF

cat > invoke-route.mjs <<'EOF'
import { POST } from "./app/api/logbrew/route.js";
import { transport } from "./app/api/logbrew/transport.js";

const response = await POST(new Request("https://example.com/api/logbrew", { method: "POST" }), {});
console.log(await response.text());
console.error(JSON.stringify({
  ok: true,
  status: response.status,
  attempts: transport.sentBodies.length,
  events: 6
}));
EOF

NEXT_TELEMETRY_DISABLED=1 npm run build >/dev/null
node invoke-route.mjs > "$tmp_dir/next-route.stdout.json" 2> "$tmp_dir/next-route.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/next-route.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/next-route.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/next-route.stderr.json"
grep -q '"attempts":2' "$tmp_dir/next-route.stderr.json"
grep -q '"events":6' "$tmp_dir/next-route.stderr.json"

cat > capture-check.mjs <<'EOF'
import { RecordingTransport } from "@logbrew/sdk";
import {
  createLogBrewNextClient,
  createRequestMetricEvent,
  createRouteRequestEvent,
  getActiveLogBrewTrace,
  withLogBrewRouteHandler
} from "@logbrew/next";

const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const transport = RecordingTransport.alwaysAccept();
const client = createLogBrewNextClient({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "next-capture-smoke",
  sdkVersion: "0.1.0"
});
let activeTraceFromAsync;
const POST = withLogBrewRouteHandler(
  async (_request, _context, { client, trace }) => {
    await Promise.resolve();
    activeTraceFromAsync = getActiveLogBrewTrace();
    if (!trace || !activeTraceFromAsync || trace.spanId !== activeTraceFromAsync.spanId) {
      throw new Error("active trace was not preserved through async route work");
    }
    client.log("evt_next_app_log_001", "2026-06-02T10:00:06Z", {
      message: "checkout route handled",
      level: "info",
      logger: "next-route",
      metadata: {
        traceId: trace.traceId,
        spanId: trace.spanId,
        parentSpanId: trace.parentSpanId,
        sampled: trace.sampled
      }
    });
    return new Response(null, { status: 204 });
  },
  {
    client,
    now: () => "2026-06-02T10:00:07Z",
    nowMs: (() => {
      const values = [100, 117];
      return () => values.shift() ?? 117;
    })(),
    requestIdFactory: () => "evt_next_request_auto",
    spanIdFactory: () => "b7ad6b7169203331",
    transport
  }
);
const response = await POST(new Request("https://example.com/api/logbrew?debug=true", {
  method: "POST",
  headers: { traceparent }
}), {});
if (response.status !== 204) {
  throw new Error(`unexpected capture response status: ${response.status}`);
}

const payload = JSON.parse(transport.lastBody());
if (payload.events.length !== 2) {
  throw new Error(`expected app log and request capture event: ${transport.lastBody()}`);
}
const appLog = payload.events.find((candidate) => candidate.id === "evt_next_app_log_001");
const event = payload.events.find((candidate) => candidate.id === "evt_next_request_auto");
if (!appLog || appLog.type !== "log") {
  throw new Error(`missing correlated app log: ${transport.lastBody()}`);
}
if (!event || event.type !== "span") {
  throw new Error(`unexpected request event identity: ${transport.lastBody()}`);
}
if (event.attributes.traceId !== "4bf92f3577b34da6a3ce929d0e0e4736") {
  throw new Error(`unexpected trace id: ${transport.lastBody()}`);
}
if (event.attributes.parentSpanId !== "00f067aa0ba902b7") {
  throw new Error(`unexpected parent span id: ${transport.lastBody()}`);
}
if (event.attributes.spanId !== "b7ad6b7169203331") {
  throw new Error(`unexpected child span id: ${transport.lastBody()}`);
}
if (activeTraceFromAsync.spanId !== "b7ad6b7169203331") {
  throw new Error(`unexpected active trace span id: ${JSON.stringify(activeTraceFromAsync)}`);
}
if (appLog.attributes.metadata.traceId !== event.attributes.traceId) {
  throw new Error(`app log trace id should match request span: ${transport.lastBody()}`);
}
if (appLog.attributes.metadata.spanId !== event.attributes.spanId) {
  throw new Error(`app log span id should match request span: ${transport.lastBody()}`);
}
if (event.attributes.name !== "POST /api/logbrew") {
  throw new Error(`unexpected span name: ${transport.lastBody()}`);
}
if (event.attributes.durationMs !== 17) {
  throw new Error(`unexpected duration: ${transport.lastBody()}`);
}
if (event.attributes.metadata.framework !== "nextjs") {
  throw new Error(`unexpected framework metadata: ${transport.lastBody()}`);
}
if ("search" in event.attributes.metadata) {
  throw new Error(`request capture should omit query text: ${transport.lastBody()}`);
}
if (transport.lastBody().includes("traceparent") || transport.lastBody().includes("debug=true")) {
  throw new Error(`capture payload leaked raw propagation or query text: ${transport.lastBody()}`);
}

const metricTransport = RecordingTransport.alwaysAccept();
const metricClient = createLogBrewNextClient({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "next-metric-smoke",
  sdkVersion: "0.1.0"
});
const METRIC = withLogBrewRouteHandler(
  async () => new Response("ok", { status: 201 }),
  {
    client: metricClient,
    captureRequests: false,
    captureRequestMetrics: true,
    metricIdFactory: () => "evt_next_metric_001",
    now: () => "2026-06-02T10:00:08Z",
    nowMs: (() => {
      const values = [200, 223];
      return () => values.shift() ?? 223;
    })(),
    routeTemplate: () => "https://example.com/api/orders/[id]?debug=true#hash",
    transport: metricTransport
  }
);
const metricResponse = await METRIC(new Request("https://example.com/api/orders/123?token=secret", {
  method: "POST"
}), {});
if (metricResponse.status !== 201) {
  throw new Error(`unexpected metric response status: ${metricResponse.status}`);
}
const metricPayload = JSON.parse(metricTransport.lastBody());
if (metricPayload.events.length !== 1) {
  throw new Error(`expected one metric capture event: ${metricTransport.lastBody()}`);
}
const metricEvent = metricPayload.events[0];
if (metricEvent.type !== "metric" || metricEvent.id !== "evt_next_metric_001") {
  throw new Error(`unexpected metric event identity: ${metricTransport.lastBody()}`);
}
if (metricEvent.attributes.name !== "http.server.duration" || metricEvent.attributes.kind !== "histogram") {
  throw new Error(`unexpected metric shape: ${metricTransport.lastBody()}`);
}
if (metricEvent.attributes.value !== 23 || metricEvent.attributes.unit !== "ms") {
  throw new Error(`unexpected metric value: ${metricTransport.lastBody()}`);
}
if (metricEvent.attributes.metadata.routeTemplate !== "/api/orders/[id]") {
  throw new Error(`route template should omit query/hash: ${metricTransport.lastBody()}`);
}
if (metricEvent.attributes.metadata.statusCode !== 201 || metricEvent.attributes.metadata.statusCodeClass !== "2xx") {
  throw new Error(`unexpected metric status metadata: ${metricTransport.lastBody()}`);
}
if ("search" in metricEvent.attributes.metadata) {
  throw new Error(`metric metadata should omit query text: ${metricTransport.lastBody()}`);
}

const metricPreview = createRequestMetricEvent(
  new Request("https://example.com/api/direct/123?debug=true", { method: "PATCH" }),
  new Response(null, { status: 503 }),
  {
    durationMs: 42.4,
    idFactory: () => "evt_next_metric_preview",
    routeTemplate: "https://example.com/api/direct/[id]?debug=true#hash"
  }
);
if (metricPreview.attributes.metadata.routeTemplate !== "/api/direct/[id]") {
  throw new Error(`preview metric should sanitize route template: ${JSON.stringify(metricPreview)}`);
}
if (metricPreview.attributes.metadata.statusCodeClass !== "5xx") {
  throw new Error(`preview metric should classify status: ${JSON.stringify(metricPreview)}`);
}

let spanIdCalls = 0;
const malformed = createRouteRequestEvent(
  new Request("https://example.com/api/bad", {
    method: "GET",
    headers: { traceparent: "not-a-valid-traceparent" }
  }),
  new Response(null, { status: 200 }),
  {
    idFactory: () => "evt_next_request_bad",
    spanIdFactory: () => {
      spanIdCalls += 1;
      return "b7ad6b7169203331";
    }
  }
);
if (malformed.type === "span" || malformed.attributes.logger !== "next") {
  throw new Error(`malformed traceparent should fall back to log: ${JSON.stringify(malformed)}`);
}
if (spanIdCalls !== 0) {
  throw new Error("spanIdFactory should not run for malformed traceparent");
}

let captureFailureMessage = "";
const failingTransport = {
  async send() {
    throw new Error("delivery unavailable");
  }
};
const SAFE = withLogBrewRouteHandler(
  async () => new Response("still ok", { status: 200 }),
  {
    serverApiKey: "LOGBREW_SERVER_API_KEY",
    onCaptureError(error) {
      captureFailureMessage = error instanceof Error ? error.message : String(error);
    },
    transport: failingTransport
  }
);
const safeResponse = await SAFE(new Request("https://example.com/api/safe", { method: "GET" }), {});
if (safeResponse.status !== 200) {
  throw new Error(`capture failure changed route status: ${safeResponse.status}`);
}
if (captureFailureMessage !== "delivery unavailable") {
  throw new Error(`missing capture failure callback: ${captureFailureMessage}`);
}

console.error(JSON.stringify({
  ok: true,
  requestCaptured: event.attributes.name,
  requestTraceId: event.attributes.traceId,
  metricCaptured: metricEvent.attributes.name,
  metricRouteTemplate: metricEvent.attributes.metadata.routeTemplate,
  fallback: malformed.attributes.message
}));
EOF
node capture-check.mjs 2> "$tmp_dir/capture-check.stderr.json"
grep -q '"ok":true' "$tmp_dir/capture-check.stderr.json"
grep -q 'POST /api/logbrew' "$tmp_dir/capture-check.stderr.json"
grep -q '4bf92f3577b34da6a3ce929d0e0e4736' "$tmp_dir/capture-check.stderr.json"
grep -q 'http.server.duration' "$tmp_dir/capture-check.stderr.json"
grep -q '/api/orders/\[id\]' "$tmp_dir/capture-check.stderr.json"
grep -q 'GET /api/bad 200' "$tmp_dir/capture-check.stderr.json"

cat > consumer.ts <<'EOF'
import { RecordingTransport, type TransportResponse } from "@logbrew/sdk";
import {
  createRequestMetricEvent,
  createRouteRequestEvent,
  createLogBrewNextClient,
  getActiveLogBrewTrace,
  withLogBrewRouteHandler,
  type LogBrewRouteHelpers,
  type LogBrewRouteMetricEvent,
  type LogBrewRouteRequestEvent,
  type LogBrewTraceContext
} from "@logbrew/next";

const transport = RecordingTransport.alwaysAccept();
let lastFlush: TransportResponse | null = null;
let lastCaptureError: unknown = null;

const typedClient = createLogBrewNextClient({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "typed-next-smoke",
  sdkVersion: "0.1.0"
});

export const POST = withLogBrewRouteHandler(
  async (request: Request, _context: { params?: Promise<Record<string, string>> }, helpers: LogBrewRouteHelpers) => {
    const body = await request.json() as { ok: boolean };
    const activeTrace: LogBrewTraceContext | undefined = helpers.trace ?? getActiveLogBrewTrace();
    const requestEvent: LogBrewRouteRequestEvent = createRouteRequestEvent(
      request,
      new Response(null, { status: 202 }),
      {
        spanIdFactory: () => "b7ad6b7169203331"
      }
    );
    if (requestEvent.type === "span") {
      requestEvent.attributes.parentSpanId?.toUpperCase();
      helpers.client.span(requestEvent.id, requestEvent.timestamp, requestEvent.attributes);
    } else {
      helpers.client.log(requestEvent.id, requestEvent.timestamp, requestEvent.attributes);
    }
    helpers.client.log("evt_log_001", "2026-06-02T10:00:03Z", {
      message: body.ok ? "worker started" : "worker skipped",
      level: "info",
      ...(activeTrace
        ? { metadata: { traceId: activeTrace.traceId, spanId: activeTrace.spanId } }
        : {})
    });
    return Response.json({ pending: helpers.logbrew.pendingEvents() });
  },
  {
    client: typedClient,
    includeSearchParams: false,
    transport,
    captureRequestMetrics: true,
    routeTemplate: (_request, context) => context.params ? "/api/typed/[id]" : "/api/typed",
    metricIdFactory: () => "evt_typed_next_metric_001",
    requestMetricEvent(request, response, { durationMs }) {
      const event: LogBrewRouteMetricEvent = createRequestMetricEvent(request, response, {
        durationMs,
        idFactory: () => "evt_typed_next_metric_custom",
        routeTemplate: "/api/typed/[id]"
      });
      return event;
    },
    onFlush(response) {
      lastFlush = response;
    },
    onCaptureError(error) {
      lastCaptureError = error;
    }
  }
);

void lastFlush;
void lastCaptureError;
EOF

cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "skipLibCheck": false,
    "noEmit": true
  },
  "include": ["consumer.ts"]
}
EOF
npx tsc --project tsconfig.json

cat > error-check.mjs <<'EOF'
import { RecordingTransport } from "@logbrew/sdk";
import { createRouteErrorEvent, withLogBrewRouteHandler } from "@logbrew/next";

const transport = RecordingTransport.alwaysAccept();
const GET = withLogBrewRouteHandler(
  async () => {
    await Promise.resolve();
    throw new Error("route exploded");
  },
  {
    serverApiKey: "LOGBREW_SERVER_API_KEY",
    transport,
    now: () => "2026-06-02T10:00:06Z",
    idFactory: () => "evt_next_error_001",
    spanIdFactory: () => "c0ffeec0ffeec0ff"
  }
);

try {
  await GET(new Request("https://example.com/api/failure?token=secret", {
    method: "GET",
    headers: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-1111111111111111-01" }
  }), {});
  throw new Error("expected route failure");
} catch (error) {
  if (error.message !== "route exploded") {
    throw error;
  }
}

const payload = JSON.parse(transport.lastBody());
if (payload.events[0].type !== "issue" || payload.events[0].id !== "evt_next_error_001") {
  throw new Error(`unexpected error event: ${transport.lastBody()}`);
}
if ("search" in payload.events[0].attributes.metadata) {
  throw new Error(`query string should be omitted by default: ${transport.lastBody()}`);
}
if (payload.events[0].attributes.metadata.traceId !== "4bf92f3577b34da6a3ce929d0e0e4736") {
  throw new Error(`error event should include trace id: ${transport.lastBody()}`);
}
if (payload.events[0].attributes.metadata.spanId !== "c0ffeec0ffeec0ff") {
  throw new Error(`error event should include route span id: ${transport.lastBody()}`);
}
if (transport.lastBody().includes("traceparent") || transport.lastBody().includes("failure?")) {
  throw new Error(`error payload leaked raw propagation or query text: ${transport.lastBody()}`);
}
const optedIn = createRouteErrorEvent(
  new Error("route exploded"),
  new Request("https://example.com/api/failure?token=secret", { method: "GET" }),
  {
    includeSearchParams: true,
    idFactory: () => "evt_next_error_opt_in"
  }
);
if (optedIn.attributes.metadata.search !== "?token=secret") {
  throw new Error(`query string opt-in failed: ${JSON.stringify(optedIn)}`);
}
console.log(JSON.stringify({
  ok: true,
  captured: payload.events[0].attributes.title,
  defaultSearchCaptured: "search" in payload.events[0].attributes.metadata,
  optInSearch: optedIn.attributes.metadata.search
}));
EOF
node error-check.mjs > "$tmp_dir/error-check.json"
grep -q '"ok":true' "$tmp_dir/error-check.json"
grep -q 'GET /api/failure failed' "$tmp_dir/error-check.json"
grep -q '"defaultSearchCaptured":false' "$tmp_dir/error-check.json"
grep -q '"optInSearch":"?token=secret"' "$tmp_dir/error-check.json"

node -e 'const next = require("@logbrew/next"); if (typeof next.withLogBrewRouteHandler !== "function" || typeof next.createRouteRequestEvent !== "function" || typeof next.createRequestMetricEvent !== "function" || typeof next.getActiveLogBrewTrace !== "function") process.exit(1)'

node node_modules/@logbrew/next/examples/index.mjs --help > "$tmp_dir/launcher-help.txt"
grep -q 'node node_modules/@logbrew/next/examples/index.mjs readme-example' "$tmp_dir/launcher-help.txt"
node node_modules/@logbrew/next/examples/index.mjs --list > "$tmp_dir/launcher-list.txt"
grep -q 'real-user-smoke -> node node_modules/@logbrew/next/examples/index.mjs real-user-smoke' "$tmp_dir/launcher-list.txt"
node node_modules/@logbrew/next/examples/index.mjs readme-example > "$tmp_dir/example-readme.stdout.json" 2> "$tmp_dir/example-readme.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/example-readme.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/example-readme.stdout.json" >/dev/null
grep -q '"attempts":1' "$tmp_dir/example-readme.stderr.json"
node node_modules/@logbrew/next/examples/index.mjs > "$tmp_dir/example-default.stdout.json" 2> "$tmp_dir/example-default.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/example-default.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/example-default.stdout.json" >/dev/null
grep -q '"attempts":2' "$tmp_dir/example-default.stderr.json"
npm --prefix node_modules/@logbrew/next/examples run list > "$tmp_dir/npm-helper-list.txt"
grep -q 'readme-example -> node node_modules/@logbrew/next/examples/index.mjs readme-example' "$tmp_dir/npm-helper-list.txt"
npm --prefix node_modules/@logbrew/next/examples run help > "$tmp_dir/npm-helper-help.txt"
grep -q 'npm --prefix node_modules/@logbrew/next/examples run real-user-smoke' "$tmp_dir/npm-helper-help.txt"
npm --prefix node_modules/@logbrew/next/examples run --silent real-user-smoke > "$tmp_dir/npm-helper-smoke.stdout.json" 2> "$tmp_dir/npm-helper-smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/npm-helper-smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/npm-helper-smoke.stdout.json" >/dev/null
grep -q '"attempts":2' "$tmp_dir/npm-helper-smoke.stderr.json"

echo "next real-user smoke passed with next@$next_version react@$react_version react-dom@$react_dom_version"
