import { RecordingTransport } from "@logbrew/sdk";
import { compileComponent } from "./support.mjs";
import { createLogBrewSvelteClient } from "@logbrew/svelte";
import { render } from "svelte/server";

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
const client = createLogBrewSvelteClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "svelte-readme-example",
  sdkVersion: "0.1.0"
});

const App = await compileComponent("ReadmeExample.svelte", `
<script>
  import { createSvelteViewEvent, setLogBrewContext, useLogBrew } from "@logbrew/svelte";

  export let client;
  export let transport;

  setLogBrewContext({ client, transport });
  const logbrew = useLogBrew();

  logbrew.client.release("evt_release_001", "2026-06-02T10:00:00Z", {
    version: "1.2.3",
    commit: "abc123def456",
    notes: "Public release marker"
  });
  logbrew.client.environment("evt_environment_001", "2026-06-02T10:00:01Z", {
    name: "production",
    region: "global"
  });
  logbrew.client.issue("evt_issue_001", "2026-06-02T10:00:02Z", {
    title: "Checkout timeout",
    level: "error",
    message: "Request timed out after retry budget"
  });
  logbrew.client.log("evt_log_001", "2026-06-02T10:00:03Z", {
    message: "worker started",
    level: "info",
    logger: "job-runner"
  });
  logbrew.client.span("evt_span_001", "2026-06-02T10:00:04Z", {
    name: "GET /health",
    traceId: "trace_001",
    spanId: "span_001",
    status: "ok",
    durationMs: 12.5
  });
  logbrew.client.action("evt_action_001", "2026-06-02T10:00:05Z", {
    name: "deploy",
    status: "success"
  });

  const event = createSvelteViewEvent("ReadmeExample", {
    idFactory: () => "evt_svelte_view_001",
    now: () => "2026-06-02T10:00:06Z",
    path: "/readme"
  });
  if (event.attributes.metadata.path !== "/readme") {
    throw new Error("unexpected Svelte view event");
  }
</script>

<pre>LogBrew Svelte example</pre>
`, ".logbrew-svelte-example-");

const rendered = render(App, { props: { client, transport } });
if (!rendered.body.includes("LogBrew Svelte example")) {
  throw new Error(`unexpected Svelte render output: ${rendered.body}`);
}
const payload = client.previewJson();
await client.shutdown(transport);

process.stdout.write(`${payload}\n`);
process.stderr.write(`${JSON.stringify({
  ok: true,

  attempts: transport.sentBodies.length,
  events: countEvents(payload),
  rendered: true,
  viewHelper: "evt_svelte_view_001"
})}\n`);
