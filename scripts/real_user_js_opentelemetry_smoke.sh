#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sdk_package_version="$(node -p "require('${repo_root}/js/logbrew-js/package.json').version")"
tmp_dir="$(mktemp -d)"
export npm_config_cache="$tmp_dir/npm-cache"

on_error() {
  local status=$?
  echo "real_user_js_opentelemetry_smoke failed at line ${BASH_LINENO[0]} while running: ${BASH_COMMAND}" >&2
  for diagnostic in \
    "$tmp_dir/pack.json" \
    "$tmp_dir/npm-list-before-otel.txt" \
    "$tmp_dir/no-otel.stdout.json" \
    "$tmp_dir/npm-list-after-otel.txt" \
    "$tmp_dir/otel.stdout.json" \
    "$tmp_dir/typecheck.log"; do
    if [[ -f "$diagnostic" ]]; then
      echo "--- ${diagnostic#"$tmp_dir"/} ---" >&2
      sed -n '1,160p' "$diagnostic" >&2
    fi
  done
  exit "$status"
}

trap 'rm -rf "$tmp_dir"' EXIT
trap on_error ERR

(cd "$repo_root/js/logbrew-js" && npm pack --json --pack-destination "$tmp_dir") > "$tmp_dir/pack.json"
core_tgz="$(python3 - "$tmp_dir/pack.json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
print(payload[0]["filename"])
PY
)"
core_tgz="$tmp_dir/$core_tgz"
test -f "$core_tgz"

app_dir="$tmp_dir/js-opentelemetry-app"
mkdir -p "$app_dir"
cd "$app_dir"
npm init -y >/dev/null
npm pkg set type=module >/dev/null
npm install --save-exact --no-audit --fund=false "$core_tgz" >/dev/null
npm uninstall @logbrew/sdk >/dev/null
npm install --save-exact --no-audit --fund=false "$core_tgz" >/dev/null

grep -q '"@logbrew/sdk": "file:' package.json
grep -q '"@logbrew/sdk"' package-lock.json
npm ls @logbrew/sdk > "$tmp_dir/npm-list-before-otel.txt"
grep -q "@logbrew/sdk@${sdk_package_version}" "$tmp_dir/npm-list-before-otel.txt"
test -f node_modules/@logbrew/sdk/index.js
test -f node_modules/@logbrew/sdk/index.cjs
test -f node_modules/@logbrew/sdk/index.d.ts

cat > no-otel.mjs <<'EOF'
import { logbrewTraceContextFromCurrentOpenTelemetrySpan } from "@logbrew/sdk";

process.stdout.write(JSON.stringify({
  ok: logbrewTraceContextFromCurrentOpenTelemetrySpan() === null
}) + "\n");
EOF
node no-otel.mjs > "$tmp_dir/no-otel.stdout.json"
grep -q '"ok":true' "$tmp_dir/no-otel.stdout.json"

npm install \
  --save-exact \
  --no-audit \
  --fund=false \
  "@opentelemetry/api@latest" \
  "@opentelemetry/context-async-hooks@latest" \
  "typescript@latest" \
  >/dev/null
npm ls @logbrew/sdk @opentelemetry/api @opentelemetry/context-async-hooks > "$tmp_dir/npm-list-after-otel.txt"
grep -q "@logbrew/sdk@${sdk_package_version}" "$tmp_dir/npm-list-after-otel.txt"
grep -q '@opentelemetry/api@' "$tmp_dir/npm-list-after-otel.txt"
grep -q '@opentelemetry/context-async-hooks@' "$tmp_dir/npm-list-after-otel.txt"

cat > typecheck.mts <<'EOF'
import {
  logbrewTraceContextFromCurrentOpenTelemetrySpan,
  logbrewTraceContextFromOpenTelemetrySpan,
  logbrewTraceContextFromOpenTelemetrySpanContext,
  type OpenTelemetrySpanContextLike
} from "@logbrew/sdk";

const spanContext: OpenTelemetrySpanContextLike = {
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "00f067aa0ba902b7",
  traceFlags: 1
};
const fromContext = logbrewTraceContextFromOpenTelemetrySpanContext(spanContext, {
  spanId: "b7ad6b7169203331"
});
const fromSpan = logbrewTraceContextFromOpenTelemetrySpan({ spanContext: () => spanContext });
const fromCurrent = logbrewTraceContextFromCurrentOpenTelemetrySpan();

if (!fromContext) {
  throw new Error("expected typed span context to produce a LogBrew trace");
}
fromContext.traceId satisfies string;
fromSpan?.sampled satisfies boolean | undefined;
fromCurrent?.spanId satisfies string | undefined;
EOF
./node_modules/.bin/tsc \
  --noEmit \
  --strict \
  --target ES2022 \
  --module NodeNext \
  --moduleResolution NodeNext \
  --skipLibCheck \
  typecheck.mts \
  > "$tmp_dir/typecheck.log" 2>&1

cat > otel.mjs <<'EOF'
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { context, TraceFlags, trace } from "@opentelemetry/api";
import {
  createTraceparentHeaders,
  LogBrewClient,
  logbrewTraceContextFromCurrentOpenTelemetrySpan
} from "@logbrew/sdk";

const manager = new AsyncLocalStorageContextManager().enable();
context.setGlobalContextManager(manager);

const parent = trace.wrapSpanContext({
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "00f067aa0ba902b7",
  traceFlags: TraceFlags.SAMPLED,
  isRemote: true
});
const parentContext = trace.setSpan(context.active(), parent);
const client = LogBrewClient.create({
  apiKey: "LOGBREW_API_KEY",
  sdkName: "js-opentelemetry-smoke",
  sdkVersion: "0.1.0"
});
const timestamp = "2026-06-15T12:00:00Z";

try {
  await context.with(parentContext, async () => {
    const child = logbrewTraceContextFromCurrentOpenTelemetrySpan({
      spanId: "b7ad6b7169203331"
    });
    if (!child) {
      throw new Error("expected active OpenTelemetry span to create a LogBrew child trace");
    }
    if (
      child.traceId !== "4bf92f3577b34da6a3ce929d0e0e4736" ||
      child.parentSpanId !== "00f067aa0ba902b7" ||
      child.spanId !== "b7ad6b7169203331" ||
      child.sampled !== true
    ) {
      throw new Error(`unexpected copied trace: ${JSON.stringify(child)}`);
    }

    client.log("evt_js_otel_log", timestamp, {
      message: "otel bridge copied",
      level: "info",
      logger: "checkout.otel",
      metadata: {
        environment: "production",
        release: "checkout@1.2.3",
        traceId: child.traceId,
        spanId: child.spanId,
        parentSpanId: child.parentSpanId,
        sampled: child.sampled
      }
    });
    client.span("evt_js_otel_span", timestamp, {
      name: "otel.child",
      traceId: child.traceId,
      spanId: child.spanId,
      parentSpanId: child.parentSpanId,
      status: "ok",
      durationMs: 4.2,
      metadata: {
        framework: "opentelemetry",
        service: "checkout"
      }
    });
    client.action("evt_js_otel_action", timestamp, {
      name: "checkout.otel.bridge",
      status: "success",
      metadata: {
        traceId: child.traceId,
        spanId: child.spanId,
        release: "checkout@1.2.3"
      }
    });

    const payload = JSON.parse(client.previewJson());
    const serializedPayload = JSON.stringify(payload);
    if (serializedPayload.includes("traceparent") || serializedPayload.includes("traceState")) {
      throw new Error("payload copied raw propagation fields");
    }
    const headers = createTraceparentHeaders({
      traceId: child.traceId,
      spanId: child.spanId,
      traceFlags: "01"
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      events: payload.events.length,
      logTraceId: payload.events[0].attributes.metadata.traceId,
      spanParentSpanId: payload.events[1].attributes.parentSpanId,
      actionSpanId: payload.events[2].attributes.metadata.spanId,
      traceparent: headers.traceparent
    }, Object.keys({
      actionSpanId: true,
      events: true,
      logTraceId: true,
      ok: true,
      spanParentSpanId: true,
      traceparent: true
    }).sort()) + "\n");
  });
} finally {
  context.disable();
  manager.disable();
}
EOF

node otel.mjs > "$tmp_dir/otel.stdout.json"
grep -q '"ok":true' "$tmp_dir/otel.stdout.json"
grep -q '"events":3' "$tmp_dir/otel.stdout.json"
grep -q '"logTraceId":"4bf92f3577b34da6a3ce929d0e0e4736"' "$tmp_dir/otel.stdout.json"
grep -q '"spanParentSpanId":"00f067aa0ba902b7"' "$tmp_dir/otel.stdout.json"
grep -q '"actionSpanId":"b7ad6b7169203331"' "$tmp_dir/otel.stdout.json"
grep -q '"traceparent":"00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01"' "$tmp_dir/otel.stdout.json"

echo "JavaScript OpenTelemetry installed-artifact smoke passed"
