import { createEnvironmentInjector, runInInjectionContext } from "@angular/core";
import { RecordingTransport } from "@logbrew/sdk";
import {
  createAngularViewEvent,
  createLogBrewAngularClient,
  injectLogBrew,
  provideLogBrew
} from "@logbrew/angular";

const transport = RecordingTransport.alwaysAccept();
const client = createLogBrewAngularClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "angular-readme-example",
  sdkVersion: "0.1.0"
});

const injector = createEnvironmentInjector(provideLogBrew({
  captureErrors: false,
  client,
  transport
}), null);

runInInjectionContext(injector, () => {
  const logbrew = injectLogBrew();
  addFullBatch(logbrew.client);
  const event = createAngularViewEvent("ReadmeExample", {
    idFactory: () => "evt_angular_view_001",
    now: () => "2026-06-02T10:00:06Z",
    path: "/readme"
  });
  if (event.attributes.metadata.path !== "/readme") {
    throw new Error(`unexpected view event: ${JSON.stringify(event)}`);
  }
});

const payload = client.previewJson();
await client.shutdown(transport);

console.log(payload);
console.error(JSON.stringify({
  ok: true,
  attempts: transport.sentBodies.length,
  events: JSON.parse(payload).events.length,
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
