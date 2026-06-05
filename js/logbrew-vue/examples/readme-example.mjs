import { createSSRApp, defineComponent, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { RecordingTransport } from "@logbrew/sdk";
import {
  createLogBrewVueClient,
  createLogBrewVuePlugin,
  createVueViewEvent,
  useLogBrew
} from "@logbrew/vue";

const transport = RecordingTransport.alwaysAccept();
const client = createLogBrewVueClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "vue-readme-example",
  sdkVersion: "0.1.0"
});

const App = defineComponent({
  name: "ReadmeExample",
  setup() {
    const logbrew = useLogBrew();
    addFullBatch(logbrew.client);
    const event = createVueViewEvent("ReadmeExample", {
      idFactory: () => "evt_vue_view_001",
      now: () => "2026-06-02T10:00:06Z",
      path: "/readme"
    });
    if (event.attributes.metadata.path !== "/readme") {
      throw new Error(`unexpected view event: ${JSON.stringify(event)}`);
    }
    return () => h("pre", "LogBrew Vue example");
  }
});

const app = createSSRApp(App);
app.use(createLogBrewVuePlugin({
  captureErrors: false,
  client,
  transport
}));

await renderToString(app);
const payload = client.previewJson();
await client.shutdown(transport);

console.log(payload);
console.error(JSON.stringify({
  ok: true,
  attempts: transport.sentBodies.length,
  events: JSON.parse(payload).events.length,
  viewHelper: "evt_vue_view_001"
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
