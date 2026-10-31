import { Injector, runInInjectionContext } from "@angular/core";
import { createAngularViewEvent, createLogBrewAngularClient, injectLogBrew, provideLogBrew } from "@logbrew/angular";
import { RecordingTransport } from "@logbrew/sdk";

/**
 * @import { LogBrewClient } from "@logbrew/sdk"
 */

/**
 * @param {LogBrewClient} logbrew
 * @returns {void}
 */
function addFullBatch(logbrew) {
  logbrew.release("evt_release_001", "2026-06-02T10:00:00Z", {
    commit: "abc123def456",
    notes: "Public release marker",
    version: "1.2.3"
  });
  logbrew.environment("evt_environment_001", "2026-06-02T10:00:01Z", {
    name: "production",
    region: "global"
  });
  logbrew.issue("evt_issue_001", "2026-06-02T10:00:02Z", {
    level: "error",
    message: "Request timed out after retry budget",
    title: "Checkout timeout"
  });
  logbrew.log("evt_log_001", "2026-06-02T10:00:03Z", {
    level: "info",
    logger: "job-runner",
    message: "worker started"
  });
  logbrew.span("evt_span_001", "2026-06-02T10:00:04Z", {
    durationMs: 12.5,
    name: "GET /health",
    spanId: "span_001",
    status: "ok",
    traceId: "trace_001"
  });
  logbrew.action("evt_action_001", "2026-06-02T10:00:05Z", {
    name: "deploy",
    status: "success"
  });
}

/**
 * @param {string} text
 * @returns {number}
 */
function countEvents(text) {
  /** @type {unknown} */
  const parsed = JSON.parse(text);
  /** @type {unknown} */
  const events = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "events") : undefined;
  return Array.isArray(events) ? events.length : Number.NaN;
}

const transport = RecordingTransport.alwaysAccept();
const client = createLogBrewAngularClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "angular-readme-example",
  sdkVersion: "0.1.0"
});

const injector = Injector.create({ providers: provideLogBrew({
  captureErrors: false,
  client,
  transport
}) });

runInInjectionContext(injector, () => {
  const logbrew = injectLogBrew();
  addFullBatch(logbrew.client);
  const event = createAngularViewEvent("ReadmeExample", {
    idFactory: () => "evt_angular_view_001",
    now: () => "2026-06-02T10:00:06Z",
    path: "/readme"
  });
  if (event.attributes.metadata?.["path"] !== "/readme") {
    throw new Error(`unexpected view event: ${JSON.stringify(event)}`);
  }
});

const payload = client.previewJson();
await client.shutdown(transport);

process.stdout.write(`${payload}\n`);
process.stderr.write(`${JSON.stringify({
  ok: true,

  attempts: transport.sentBodies.length,
  events: countEvents(payload),

  viewHelper: "evt_angular_view_001"
})}\n`);
