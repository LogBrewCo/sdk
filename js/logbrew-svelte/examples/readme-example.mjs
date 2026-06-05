import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "svelte/compiler";
import { render } from "svelte/server";
import { RecordingTransport } from "@logbrew/sdk";
import { createLogBrewSvelteClient } from "@logbrew/svelte";

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
`);

const rendered = render(App, { props: { client, transport } });
if (!rendered.html.includes("LogBrew Svelte example")) {
  throw new Error(`unexpected Svelte render output: ${rendered.html}`);
}
const payload = client.previewJson();
await client.shutdown(transport);

console.log(payload);
console.error(JSON.stringify({
  ok: true,
  attempts: transport.sentBodies.length,
  events: JSON.parse(payload).events.length,
  rendered: true,
  viewHelper: "evt_svelte_view_001"
}));

async function compileComponent(filename, source) {
  const dir = await mkdtemp(join(process.cwd(), ".logbrew-svelte-example-"));
  try {
    const compiled = compile(source, { generate: "server", filename });
    const modulePath = join(dir, `${filename}.mjs`);
    await writeFile(modulePath, compiled.js.code, "utf8");
    const module = await import(pathToFileURL(modulePath).href);
    return module.default;
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}
