#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sdk_package_version="$(node -p "require('${repo_root}/js/logbrew-js/package.json').version")"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

core_pack_json="$tmp_dir/core-pack.json"
nestjs_pack_json="$tmp_dir/nestjs-pack.json"
(cd "$repo_root/js/logbrew-js" && npm pack --json --pack-destination "$tmp_dir") > "$core_pack_json"
(cd "$repo_root/js/logbrew-nestjs" && npm pack --json --pack-destination "$tmp_dir") > "$nestjs_pack_json"

core_tgz="$(python3 - "$core_pack_json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
print(payload[0]["filename"])
PY
)"
nestjs_tgz="$(python3 - "$nestjs_pack_json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
print(payload[0]["filename"])
PY
)"
core_tgz="$tmp_dir/$core_tgz"
nestjs_tgz="$tmp_dir/$nestjs_tgz"
test -f "$core_tgz"
test -f "$nestjs_tgz"

tar -tzf "$nestjs_tgz" > "$tmp_dir/nestjs-tarball.txt"
grep -q '^package/README.md$' "$tmp_dir/nestjs-tarball.txt"
grep -q '^package/index.js$' "$tmp_dir/nestjs-tarball.txt"
grep -q '^package/index.cjs$' "$tmp_dir/nestjs-tarball.txt"
grep -q '^package/index.d.ts$' "$tmp_dir/nestjs-tarball.txt"
grep -q '^package/index.d.cts$' "$tmp_dir/nestjs-tarball.txt"
grep -q '^package/examples/index.mjs$' "$tmp_dir/nestjs-tarball.txt"
grep -q '^package/examples/package.json$' "$tmp_dir/nestjs-tarball.txt"
grep -q '^package/examples/readme-example.mjs$' "$tmp_dir/nestjs-tarball.txt"
grep -q '^package/examples/real-user-smoke.mjs$' "$tmp_dir/nestjs-tarball.txt"
tar -xOf "$nestjs_tgz" package/README.md > "$tmp_dir/nestjs-readme.md"
grep -q 'npm install @logbrew/sdk @logbrew/nestjs @nestjs/common @nestjs/core @nestjs/platform-express reflect-metadata rxjs' "$tmp_dir/nestjs-readme.md"
grep -q 'pnpm add @logbrew/sdk @logbrew/nestjs @nestjs/common @nestjs/core @nestjs/platform-express reflect-metadata rxjs' "$tmp_dir/nestjs-readme.md"
grep -q 'LOGBREW_API_KEY' "$tmp_dir/nestjs-readme.md"
grep -q 'LOGBREW_SERVER_API_KEY' "$tmp_dir/nestjs-readme.md"
grep -q 'serverApiKey' "$tmp_dir/nestjs-readme.md"
grep -q 'LogBrewInterceptor' "$tmp_dir/nestjs-readme.md"
grep -q 'request.logbrew' "$tmp_dir/nestjs-readme.md"
grep -q 'request.logbrew.trace' "$tmp_dir/nestjs-readme.md"
grep -q 'getActiveLogBrewTrace' "$tmp_dir/nestjs-readme.md"
grep -q 'catchError' "$tmp_dir/nestjs-readme.md"
grep -q 'traceparent' "$tmp_dir/nestjs-readme.md"
grep -q 'spanIdFactory' "$tmp_dir/nestjs-readme.md"
grep -q 'captureRequests: false' "$tmp_dir/nestjs-readme.md"
grep -q 'captureRequestMetrics' "$tmp_dir/nestjs-readme.md"
grep -q 'http.server.duration' "$tmp_dir/nestjs-readme.md"
grep -q 'low-cardinality' "$tmp_dir/nestjs-readme.md"
grep -q 'createLogBrewNestLogger' "$tmp_dir/nestjs-readme.md"
grep -q 'app.useLogger' "$tmp_dir/nestjs-readme.md"

app_dir="$tmp_dir/nestjs-smoke-app"
mkdir -p "$app_dir"
cd "$app_dir"
npm init -y >/dev/null
npm pkg set type=module >/dev/null
nest_common_version="$(npm view @nestjs/common version)"
nest_core_version="$(npm view @nestjs/core version)"
nest_platform_express_version="$(npm view @nestjs/platform-express version)"
reflect_metadata_version="$(npm view reflect-metadata version)"
rxjs_version="$(npm view rxjs version)"
types_express_version="$(npm view @types/express version)"
npm install \
  --save-exact \
  "$core_tgz" \
  "$nestjs_tgz" \
  "@nestjs/common@$nest_common_version" \
  "@nestjs/core@$nest_core_version" \
  "@nestjs/platform-express@$nest_platform_express_version" \
  "reflect-metadata@$reflect_metadata_version" \
  "rxjs@$rxjs_version" \
  "typescript" \
  "@types/node" \
  "@types/express@$types_express_version" \
  >/dev/null

grep -q '"@logbrew/sdk": "file:' package.json
grep -q '"@logbrew/nestjs": "file:' package.json
grep -q '"@nestjs/common":' package.json
grep -q '"@nestjs/core":' package.json
grep -q '"@nestjs/platform-express":' package.json
grep -q '"reflect-metadata":' package.json
grep -q '"rxjs":' package.json
grep -q '"@logbrew/nestjs"' package-lock.json
grep -q '"@logbrew/sdk"' package-lock.json
npm ls @logbrew/sdk @logbrew/nestjs @nestjs/common @nestjs/core @nestjs/platform-express reflect-metadata rxjs >/dev/null
npm explain @logbrew/nestjs > "$tmp_dir/npm-explain-nestjs.txt"
grep -q '@logbrew/nestjs@0.1.1' "$tmp_dir/npm-explain-nestjs.txt"
npm list --depth=0 > "$tmp_dir/npm-list-depth0.txt"
grep -q '@logbrew/nestjs@0.1.1' "$tmp_dir/npm-list-depth0.txt"
grep -q "@logbrew/sdk@${sdk_package_version}" "$tmp_dir/npm-list-depth0.txt"
npm list --json --depth=0 > "$tmp_dir/npm-list-depth0.json"
python3 - "$tmp_dir/npm-list-depth0.json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
deps = payload.get("dependencies", {})
for name in (
    "@logbrew/nestjs",
    "@logbrew/sdk",
    "@nestjs/common",
    "@nestjs/core",
    "@nestjs/platform-express",
    "reflect-metadata",
    "rxjs",
):
    if name not in deps:
        raise SystemExit(f"missing npm dependency entry: {name}")
PY

cat > smoke.ts <<'EOF'
import "reflect-metadata";
import { Controller, Get, Module, Req } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Request, Response } from "express";
import { RecordingTransport, type LogAttributes } from "@logbrew/sdk";
import {
  createErrorEvent,
  createLogBrewNestLogger,
  createLogBrewNestClient,
  createRequestMetricEvent,
  createRequestEvent,
  getActiveLogBrewTrace,
  LogBrewInterceptor,
  type LogBrewNestLogger,
  type LogBrewTraceContext
} from "@logbrew/nestjs";

const requestTransport = new RecordingTransport([{ statusCode: 503 }, { statusCode: 202 }]);
const autoTransport = RecordingTransport.alwaysAccept();
const errorTransport = RecordingTransport.alwaysAccept();
const traceTransport = RecordingTransport.alwaysAccept();
const metricTransport = RecordingTransport.alwaysAccept();
const autoTraceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const autoSpanId = "b7ad6b7169203331";
const errorSpanId = "b7ad6b7169203332";

const explicitClient = createLogBrewNestClient({
  apiKey: "LOGBREW_API_KEY",
  sdkName: "nestjs-smoke-explicit",
  sdkVersion: "0.1.1"
});
if (explicitClient.pendingEvents() !== 0) {
  throw new Error("expected empty explicit client");
}

@Controller()
class ManualController {
  @Get("/logbrew")
  logbrew(@Req() request: Request): unknown {
    if (!request.logbrew) {
      throw new Error("missing request.logbrew context");
    }
    addFullBatch(request.logbrew.client);
    const payload = request.logbrew.previewJson();
    void request.logbrew.shutdown();
    return JSON.parse(payload);
  }
}

@Module({ controllers: [ManualController] })
class ManualModule {}

const manualApp = await NestFactory.create(ManualModule, { logger: false });
manualApp.useGlobalInterceptors(new LogBrewInterceptor({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  captureRequests: false,
  maxRetries: 1,
  sdkName: "nestjs-smoke-app",
  sdkVersion: "0.1.1",
  transport: requestTransport
}));
await manualApp.listen(0, "127.0.0.1");
const okResponse = await fetch(`${await manualApp.getUrl()}/logbrew`);
const okText = await okResponse.text();
await manualApp.close();

let requestTraceFromAuto: LogBrewTraceContext | undefined;
let activeTraceFromAuto: LogBrewTraceContext | undefined;
const forwardedLoggerCalls: string[] = [];
const autoClient = createLogBrewNestClient({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "nestjs-auto-smoke",
  sdkVersion: "0.1.1"
});
const logbrewLogger: LogBrewNestLogger = createLogBrewNestLogger({
  client: autoClient,
  baseLogger: {
    log(message: unknown, context?: string) {
      forwardedLoggerCalls.push(`log:${String(message)}:${context ?? ""}`);
    },
    error(message: unknown, stack?: string, context?: string) {
      forwardedLoggerCalls.push(`error:${String(message)}:${stack ?? ""}:${context ?? ""}`);
    },
    warn(message: unknown, context?: string) {
      forwardedLoggerCalls.push(`warn:${String(message)}:${context ?? ""}`);
    }
  },
  idFactory: (level, message, context) => `evt_nestjs_logger_${level}_${String(context ?? "app").toLowerCase()}`,
  now: () => "2026-06-02T10:00:12Z"
});

@Controller()
class AutoController {
  @Get("/auto")
  async auto(@Req() request: Request): Promise<{ ok: true }> {
    requestTraceFromAuto = request.logbrew?.trace;
    await Promise.resolve();
    activeTraceFromAuto = getActiveLogBrewTrace();
    logbrewLogger.log("checkout route reached", "CheckoutController");
    logbrewLogger.warn("retry budget low", "CheckoutController");
    const trace = requestTraceFromAuto ?? activeTraceFromAuto;
    const attributes: LogAttributes = {
      message: "auto route reached",
      level: "info" as const,
      logger: "nestjs"
    };
    if (trace) {
      attributes.metadata = {
        traceId: trace.traceId,
        spanId: trace.spanId,
        parentSpanId: trace.parentSpanId,
        sampled: trace.sampled
      };
    }
    request.logbrew?.client.log("evt_nestjs_correlated_log", "2026-06-02T10:00:05Z", {
      ...attributes
    });
    return { ok: true };
  }

  @Get("/fail")
  fail(): never {
    logbrewLogger.error("route failed", "STACK_SENTINEL", "CheckoutController");
    throw new Error("route exploded");
  }
}

@Module({ controllers: [AutoController] })
class AutoModule {}

const autoApp = await NestFactory.create(AutoModule, { logger: false });
const autoCaptureErrors: string[] = [];
autoApp.useGlobalInterceptors(new LogBrewInterceptor({
  client: autoClient,
  errorEvent(error, { request, trace }) {
    return createErrorEvent(error, request, {
      idFactory: () => "evt_nestjs_error_001",
      now: () => "2026-06-02T10:00:07Z",
      trace
    });
  },
  now: () => "2026-06-02T10:00:06Z",
  nowMs: () => 100,
  onCaptureError(error) {
    autoCaptureErrors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  },
  requestEvent(request, response, { durationMs, trace }) {
    return createRequestEvent(request, response, {
      durationMs,
      idFactory: () => "evt_nestjs_request_001",
      now: () => "2026-06-02T10:00:06Z",
      trace
    });
  },
  spanIdFactory(request) {
    return request.url?.startsWith("/fail") ? errorSpanId : autoSpanId;
  },
  transport({ request }) {
    return request.url?.startsWith("/fail") ? errorTransport : autoTransport;
  }
}));

await autoApp.listen(0, "127.0.0.1");
const autoUrl = await autoApp.getUrl();
const autoResponse = await fetch(`${autoUrl}/auto?token=secret`, {
  headers: {
    traceparent: autoTraceparent
  }
});
await autoResponse.json();
await waitFor(
  () => autoTransport.sentBodies.length === 1,
  () => `auto request capture timed out; errors=${JSON.stringify(autoCaptureErrors)}`
);
const failResponse = await fetch(`${autoUrl}/fail?token=secret`, {
  headers: {
    traceparent: autoTraceparent
  }
});
await failResponse.json();
await waitFor(
  () => errorTransport.sentBodies.length === 1,
  () => `error request capture timed out; errors=${JSON.stringify(autoCaptureErrors)}`
);
await autoApp.close();

const autoPayload = JSON.parse(autoTransport.lastBody() ?? "");
const autoRequestEvent = autoPayload.events.find((event: { id?: string }) => event.id === "evt_nestjs_request_001");
const correlatedLogEvent = autoPayload.events.find((event: { id?: string }) => event.id === "evt_nestjs_correlated_log");
if (!autoRequestEvent || autoRequestEvent.type !== "span") {
  throw new Error(`unexpected auto request payload: ${autoTransport.lastBody()}`);
}
if (autoRequestEvent.attributes.metadata.path !== "/auto") {
  throw new Error(`request capture should omit query text: ${autoTransport.lastBody()}`);
}
if (autoRequestEvent.attributes.traceId !== "4bf92f3577b34da6a3ce929d0e0e4736" || autoRequestEvent.attributes.spanId !== autoSpanId) {
  throw new Error(`request span should reuse request-local trace: ${autoTransport.lastBody()}`);
}
if (requestTraceFromAuto?.spanId !== autoSpanId || activeTraceFromAuto?.spanId !== autoSpanId) {
  throw new Error(`controller should see active request trace: ${JSON.stringify({ requestTraceFromAuto, activeTraceFromAuto })}`);
}
if (!correlatedLogEvent || correlatedLogEvent.attributes.metadata.traceId !== "4bf92f3577b34da6a3ce929d0e0e4736") {
  throw new Error(`app log should carry request trace metadata: ${autoTransport.lastBody()}`);
}
const errorPayload = JSON.parse(errorTransport.lastBody() ?? "");
const loggerEvents = [...autoPayload.events, ...errorPayload.events];
const infoLog = loggerEvents.find((event) => event.id === "evt_nestjs_logger_info_checkoutcontroller");
const warnLog = loggerEvents.find((event) => event.id === "evt_nestjs_logger_warning_checkoutcontroller");
const errorIssue = loggerEvents.find((event) => event.id === "evt_nestjs_logger_error_checkoutcontroller");
if (!infoLog || infoLog.type !== "log" || infoLog.attributes.level !== "info") {
  throw new Error(`missing info logger event: ${JSON.stringify(loggerEvents)}`);
}
if (!warnLog || warnLog.type !== "log" || warnLog.attributes.level !== "warning") {
  throw new Error(`missing warning logger event: ${JSON.stringify(loggerEvents)}`);
}
if (!errorIssue || errorIssue.type !== "issue" || errorIssue.attributes.level !== "error") {
  throw new Error(`missing error logger issue: ${JSON.stringify(loggerEvents)}`);
}
if (infoLog.attributes.metadata.traceId !== "4bf92f3577b34da6a3ce929d0e0e4736" || infoLog.attributes.metadata.spanId !== autoSpanId) {
  throw new Error(`logger log should carry active trace metadata: ${JSON.stringify(infoLog)}`);
}
if (errorIssue.attributes.metadata.spanId !== errorSpanId) {
  throw new Error(`logger error should carry failing request trace: ${JSON.stringify(errorIssue)}`);
}
if (errorIssue.attributes.metadata.stack || JSON.stringify(loggerEvents).includes("STACK_SENTINEL")) {
  throw new Error(`logger payload should omit stack text: ${JSON.stringify(loggerEvents)}`);
}
const loggerPayloadText = JSON.stringify(loggerEvents);
const queryLeakNeedle = ["tok", "en=sec", "ret"].join("");
if (loggerPayloadText.includes(queryLeakNeedle) || loggerPayloadText.includes("traceparent")) {
  throw new Error(`logger payload leaked request/query/header detail: ${loggerPayloadText}`);
}
if (
  !forwardedLoggerCalls.includes("log:checkout route reached:CheckoutController") ||
  !forwardedLoggerCalls.includes("warn:retry budget low:CheckoutController") ||
  !forwardedLoggerCalls.includes("error:route failed:STACK_SENTINEL:CheckoutController")
) {
  throw new Error(`base logger forwarding changed: ${JSON.stringify(forwardedLoggerCalls)}`);
}
const requestErrorEvent = errorPayload.events.find((event: { id?: string }) => event.id === "evt_nestjs_error_001");
if (!requestErrorEvent || requestErrorEvent.type !== "issue") {
  throw new Error(`unexpected error payload: ${errorTransport.lastBody()}`);
}
if (requestErrorEvent.attributes.metadata.path !== "/fail") {
  throw new Error(`error capture should omit query text: ${errorTransport.lastBody()}`);
}
if (requestErrorEvent.attributes.metadata.spanId !== errorSpanId) {
  throw new Error(`error capture should carry request trace metadata: ${errorTransport.lastBody()}`);
}
const errorPreview = createErrorEvent(new Error("manual failure"), { method: "POST", originalUrl: "/manual" } as Request, {
  idFactory: () => "evt_nestjs_error_preview",
  now: () => "2026-06-02T10:00:08Z"
});
if (errorPreview.attributes.title !== "POST /manual failed") {
  throw new Error(`unexpected error preview: ${JSON.stringify(errorPreview)}`);
}

@Controller()
class TraceController {
  @Get("/trace")
  trace(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [TraceController] })
class TraceModule {}

const traceApp = await NestFactory.create(TraceModule, { logger: false });
traceApp.useGlobalInterceptors(new LogBrewInterceptor({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  idFactory: () => "evt_nestjs_request_trace",
  now: () => "2026-06-02T10:00:09Z",
  nowMs: (() => {
    const values = [100, 119];
    return () => values.shift() ?? 119;
  })(),
  sdkName: "nestjs-trace-smoke",
  sdkVersion: "0.1.1",
  spanIdFactory: () => "b7ad6b7169203331",
  transport: traceTransport
}));
await traceApp.listen(0, "127.0.0.1");
const traceResponse = await fetch(`${await traceApp.getUrl()}/trace?debug=true`, {
  headers: {
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
  }
});
await traceResponse.json();
await waitFor(() => traceTransport.sentBodies.length === 1);
await traceApp.close();

const tracePayload = JSON.parse(traceTransport.lastBody() ?? "");
const traceEvent = tracePayload.events[0];
if (traceEvent.id !== "evt_nestjs_request_trace" || traceEvent.type !== "span") {
  throw new Error(`unexpected trace request identity: ${traceTransport.lastBody()}`);
}
if (traceEvent.attributes.traceId !== "4bf92f3577b34da6a3ce929d0e0e4736") {
  throw new Error(`unexpected trace id: ${traceTransport.lastBody()}`);
}
if (traceEvent.attributes.parentSpanId !== "00f067aa0ba902b7") {
  throw new Error(`unexpected parent span id: ${traceTransport.lastBody()}`);
}
if (traceEvent.attributes.spanId !== "b7ad6b7169203331") {
  throw new Error(`unexpected child span id: ${traceTransport.lastBody()}`);
}
if (traceEvent.attributes.name !== "GET /trace") {
  throw new Error(`unexpected trace span name: ${traceTransport.lastBody()}`);
}
if (traceEvent.attributes.durationMs !== 19) {
  throw new Error(`unexpected trace duration: ${traceTransport.lastBody()}`);
}
if (traceEvent.attributes.metadata.framework !== "nestjs") {
  throw new Error(`unexpected framework metadata: ${traceTransport.lastBody()}`);
}
if (traceEvent.attributes.metadata.path !== "/trace") {
  throw new Error(`request capture should omit query text: ${traceTransport.lastBody()}`);
}

@Controller()
class MetricsController {
  @Get("/metrics/:id")
  metrics(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [MetricsController] })
class MetricsModule {}

const metricsApp = await NestFactory.create(MetricsModule, { logger: false });
metricsApp.useGlobalInterceptors(new LogBrewInterceptor({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  captureRequests: false,
  captureRequestMetrics: true,
  metricIdFactory: () => "evt_nestjs_metric_001",
  now: () => "2026-06-02T10:00:10Z",
  nowMs: (() => {
    const values = [100, 137];
    return () => values.shift() ?? 137;
  })(),
  sdkName: "nestjs-metric-smoke",
  sdkVersion: "0.1.1",
  transport: metricTransport
}));
await metricsApp.listen(0, "127.0.0.1");
const metricResponse = await fetch(`${await metricsApp.getUrl()}/metrics/123?token=secret#ignored`);
await metricResponse.json();
await waitFor(() => metricTransport.sentBodies.length === 1);
await metricsApp.close();

const metricPayload = JSON.parse(metricTransport.lastBody() ?? "");
if (metricPayload.events.length !== 1 || metricPayload.events[0].type !== "metric") {
  throw new Error(`metrics-only capture should emit one metric: ${metricTransport.lastBody()}`);
}
const metricEvent = metricPayload.events[0];
if (metricEvent.id !== "evt_nestjs_metric_001") {
  throw new Error(`unexpected metric id: ${metricTransport.lastBody()}`);
}
if (metricEvent.attributes.name !== "http.server.duration" || metricEvent.attributes.kind !== "histogram") {
  throw new Error(`unexpected metric shape: ${metricTransport.lastBody()}`);
}
if (metricEvent.attributes.value !== 37 || metricEvent.attributes.unit !== "ms") {
  throw new Error(`unexpected metric value: ${metricTransport.lastBody()}`);
}
if (metricEvent.attributes.metadata.framework !== "nestjs") {
  throw new Error(`unexpected metric framework metadata: ${metricTransport.lastBody()}`);
}
if (metricEvent.attributes.metadata.routeTemplate !== "/metrics/:id") {
  throw new Error(`metric should prefer route templates and omit query text: ${metricTransport.lastBody()}`);
}
if (metricEvent.attributes.metadata.statusCode !== 200 || metricEvent.attributes.metadata.statusCodeClass !== "2xx") {
  throw new Error(`unexpected metric status metadata: ${metricTransport.lastBody()}`);
}

const metricPreview = createRequestMetricEvent(
  ({
    method: "POST",
    originalUrl: "https://example.test/orders/42?token=secret#hash"
  } as unknown) as Request,
  { statusCode: 503 } as unknown as Response,
  {
    durationMs: 125.4,
    idFactory: () => "evt_nestjs_metric_preview",
    now: () => "2026-06-02T10:00:11Z"
  }
);
const metricPreviewMetadata = metricPreview.attributes.metadata ?? {};
if (metricPreviewMetadata.routeTemplate !== "/orders/42") {
  throw new Error(`metric preview should omit query and hash text: ${JSON.stringify(metricPreview)}`);
}
if (metricPreviewMetadata.statusCodeClass !== "5xx") {
  throw new Error(`unexpected metric preview status class: ${JSON.stringify(metricPreview)}`);
}

let spanIdCalls = 0;
const malformed = createRequestEvent(
  ({
    headers: { traceparent: "not-a-valid-traceparent" },
    method: "GET",
    originalUrl: "/bad?debug=true"
  } as unknown) as Request,
  { statusCode: 200 } as unknown as Response,
  {
    idFactory: () => "evt_nestjs_request_bad",
    spanIdFactory: () => {
      spanIdCalls += 1;
      return "b7ad6b7169203331";
    }
  }
);
if (malformed.type === "span" || malformed.attributes.logger !== "nestjs") {
  throw new Error(`malformed traceparent should fall back to log: ${JSON.stringify(malformed)}`);
}
if (malformed.attributes.message !== "GET /bad 200") {
  throw new Error(`malformed fallback should omit query text: ${JSON.stringify(malformed)}`);
}
if (spanIdCalls !== 0) {
  throw new Error("spanIdFactory should not run for malformed traceparent");
}

console.log(okText);
console.error(JSON.stringify({
  ok: true,
  attempts: requestTransport.sentBodies.length,
  autoCaptured: autoRequestEvent.attributes.name,
  activeTrace: activeTraceFromAuto?.spanId,
  errorCaptured: requestErrorEvent.attributes.title,
  errorStatus: failResponse.status,
  events: 10,
  loggerCaptured: errorIssue.attributes.title,
  metricCaptured: metricEvent.attributes.name,
  metricRoute: metricEvent.attributes.metadata.routeTemplate,
  traceCaptured: traceEvent.attributes.name,
  traceId: traceEvent.attributes.traceId,
  status: okResponse.status
}));

function addFullBatch(client: ReturnType<typeof createLogBrewNestClient>): void {
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

async function waitFor(predicate: () => boolean, message: () => string = () => "timed out waiting for NestJS capture"): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(message());
}
EOF

cat > consumer.ts <<'EOF'
import "reflect-metadata";
import { Controller, Get, Module, Req } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Request } from "express";
import { RecordingTransport, type LogAttributes } from "@logbrew/sdk";
import {
  createLogBrewNestLogger,
  createLogBrewNestClient,
  createRequestMetricEvent,
  createRequestEvent,
  getActiveLogBrewTrace,
  LogBrewInterceptor,
  type LogBrewRequestMetricEvent,
  type LogBrewRequestEvent,
  type LogBrewNestLogger,
  type LogBrewTraceContext
} from "@logbrew/nestjs";

const client = createLogBrewNestClient({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "typed-nestjs-smoke",
  sdkVersion: "0.1.1"
});
const logger: LogBrewNestLogger = createLogBrewNestLogger({
  client,
  baseLogger: console,
  transport: RecordingTransport.alwaysAccept()
});
logger.log("typed log", "TypedController");

@Controller()
class TypedController {
  @Get("/typed")
  typed(@Req() request: Request): { pending: number } {
    const trace: LogBrewTraceContext | undefined = request.logbrew?.trace ?? getActiveLogBrewTrace();
    const attributes: LogAttributes = {
      message: "typed worker",
      level: "info" as const
    };
    if (trace) {
      attributes.metadata = { traceId: trace.traceId, spanId: trace.spanId };
    }
    request.logbrew?.client.log("evt_log_001", "2026-06-02T10:00:03Z", attributes);
    return { pending: request.logbrew?.client.pendingEvents() ?? 0 };
  }
}

@Module({ controllers: [TypedController] })
class TypedModule {}

async function createApp(): Promise<unknown> {
  const app = await NestFactory.create(TypedModule, { logger: false });
  app.useGlobalInterceptors(new LogBrewInterceptor({
    client,
    captureRequestMetrics: true,
    requestEvent(request, response, { durationMs, trace }) {
      const event: LogBrewRequestEvent = createRequestEvent(request, response, {
        durationMs,
        now: () => "2026-06-02T10:00:06Z",
        spanIdFactory: () => "b7ad6b7169203331",
        trace
      });
      if (event.type === "span") {
        event.attributes.parentSpanId?.toUpperCase();
      } else {
        event.attributes.message.toUpperCase();
      }
      return event;
    },
    requestMetricEvent(request, response, { durationMs }) {
      const event: LogBrewRequestMetricEvent = createRequestMetricEvent(request, response, {
        durationMs,
        now: () => "2026-06-02T10:00:10Z"
      });
      event.attributes.metadata?.framework?.toString();
      return event;
    },
    transport: RecordingTransport.alwaysAccept()
  }));
  return app;
}

export { createApp };
EOF

cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "esModuleInterop": true,
    "skipLibCheck": false,
    "outDir": "dist"
  },
  "include": ["consumer.ts", "smoke.ts"]
}
EOF
npx tsc --project tsconfig.json

node dist/smoke.js > "$tmp_dir/nestjs-smoke.stdout.json" 2> "$tmp_dir/nestjs-smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/nestjs-smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/nestjs-smoke.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/nestjs-smoke.stderr.json"
grep -q '"attempts":2' "$tmp_dir/nestjs-smoke.stderr.json"
grep -q '"errorStatus":500' "$tmp_dir/nestjs-smoke.stderr.json"
grep -q 'GET /auto' "$tmp_dir/nestjs-smoke.stderr.json"
grep -q '"activeTrace":"b7ad6b7169203331"' "$tmp_dir/nestjs-smoke.stderr.json"
grep -q 'GET /fail failed' "$tmp_dir/nestjs-smoke.stderr.json"
grep -q 'http.server.duration' "$tmp_dir/nestjs-smoke.stderr.json"
grep -q '/metrics/:id' "$tmp_dir/nestjs-smoke.stderr.json"
grep -q 'GET /trace' "$tmp_dir/nestjs-smoke.stderr.json"
grep -q '4bf92f3577b34da6a3ce929d0e0e4736' "$tmp_dir/nestjs-smoke.stderr.json"

node -e 'const nestjs = require("@logbrew/nestjs"); if (typeof nestjs.LogBrewInterceptor !== "function") process.exit(1)'

node node_modules/@logbrew/nestjs/examples/index.mjs --help > "$tmp_dir/launcher-help.txt"
grep -q 'node node_modules/@logbrew/nestjs/examples/index.mjs readme-example' "$tmp_dir/launcher-help.txt"
node node_modules/@logbrew/nestjs/examples/index.mjs --list > "$tmp_dir/launcher-list.txt"
grep -q 'real-user-smoke -> node node_modules/@logbrew/nestjs/examples/index.mjs real-user-smoke' "$tmp_dir/launcher-list.txt"
node node_modules/@logbrew/nestjs/examples/index.mjs readme-example > "$tmp_dir/example-readme.stdout.json" 2> "$tmp_dir/example-readme.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/example-readme.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/example-readme.stdout.json" >/dev/null
grep -q '"attempts":1' "$tmp_dir/example-readme.stderr.json"
node node_modules/@logbrew/nestjs/examples/index.mjs > "$tmp_dir/example-default.stdout.json" 2> "$tmp_dir/example-default.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/example-default.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/example-default.stdout.json" >/dev/null
grep -q '"attempts":2' "$tmp_dir/example-default.stderr.json"
grep -q '"errorStatus":500' "$tmp_dir/example-default.stderr.json"
npm --prefix node_modules/@logbrew/nestjs/examples run list > "$tmp_dir/npm-helper-list.txt"
grep -q 'readme-example -> node node_modules/@logbrew/nestjs/examples/index.mjs readme-example' "$tmp_dir/npm-helper-list.txt"
npm --prefix node_modules/@logbrew/nestjs/examples run help > "$tmp_dir/npm-helper-help.txt"
grep -q 'npm --prefix node_modules/@logbrew/nestjs/examples run real-user-smoke' "$tmp_dir/npm-helper-help.txt"
npm --prefix node_modules/@logbrew/nestjs/examples run --silent real-user-smoke > "$tmp_dir/npm-helper-smoke.stdout.json" 2> "$tmp_dir/npm-helper-smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/npm-helper-smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/npm-helper-smoke.stdout.json" >/dev/null
grep -q '"attempts":2' "$tmp_dir/npm-helper-smoke.stderr.json"

echo "nestjs real-user smoke passed with @nestjs/common@$nest_common_version @nestjs/core@$nest_core_version @nestjs/platform-express@$nest_platform_express_version"
