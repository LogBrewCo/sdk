import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "svelte/compiler";
import { render } from "svelte/server";
import { RecordingTransport } from "@logbrew/sdk";
import {
  captureSvelteError,
  createLogBrewSvelteClient,
  createLogBrewSvelteContext,
  createLogBrewSvelteKitHooks,
  createSvelteErrorEvent,
  createSvelteTraceparent,
  createTraceparentFetch,
  shouldPropagateTraceparent
} from "@logbrew/svelte";

const requestTransport = new RecordingTransport([{ statusCode: 503 }, { statusCode: 202 }]);
const errorTransport = RecordingTransport.alwaysAccept();
const client = createLogBrewSvelteClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "svelte-smoke-app",
  sdkVersion: "0.1.0",
  maxRetries: 1
});

const App = await compileComponent("Smoke.svelte", `
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

  const event = createSvelteViewEvent("Smoke", {
    idFactory: () => "evt_svelte_view_001",
    now: () => "2026-06-02T10:00:06Z",
    path: "/smoke"
  });
  if (event.attributes.metadata.path !== "/smoke") {
    throw new Error("unexpected Svelte view event");
  }
</script>

<pre>LogBrew Svelte smoke</pre>
`);

const rendered = render(App, { props: { client, transport: requestTransport } });
if (!rendered.html.includes("LogBrew Svelte smoke")) {
  throw new Error(`unexpected Svelte render output: ${rendered.html}`);
}
const payload = client.previewJson();
await client.shutdown(requestTransport);

let missingContextFailed = false;
const MissingContext = await compileComponent("MissingContext.svelte", `
<script>
  import { useLogBrew } from "@logbrew/svelte";
  useLogBrew();
</script>
`);
try {
  void render(MissingContext).html;
} catch (error) {
  if (error?.code !== "configuration_error") {
    throw error;
  }
  missingContextFailed = true;
}
if (!missingContextFailed) {
  throw new Error("expected missing Svelte context to fail");
}

const deliveredRequests = [];
const deliveryContext = createLogBrewSvelteContext({
  clientKey: "LOGBREW_CLIENT_KEY",
  fetchImpl: async (endpoint, init) => {
    deliveredRequests.push({ endpoint, init });
    return { headers: { get: () => null }, status: 202 };
  },
  sdkName: "svelte-delivery-smoke",
  sdkVersion: "0.1.1"
});
deliveryContext.client.log("evt_svelte_delivery_001", "2026-06-02T10:00:07Z", {
  level: "info",
  message: "Svelte delivery probe"
});
await deliveryContext.flush();
if (deliveredRequests[0]?.endpoint !== "https://api.logbrew.co/v1/events"
  || deliveredRequests[0]?.init?.headers?.authorization !== "Bearer LOGBREW_CLIENT_KEY") {
  throw new Error("expected default authenticated .co delivery");
}

const errorClient = createLogBrewSvelteClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "svelte-error-smoke",
  sdkVersion: "0.1.1"
});
const errorContext = createLogBrewSvelteContext({
  client: errorClient,
  transport: errorTransport
});
errorClient.addBreadcrumb({
  category: "navigation",
  message: "/orders/[id]",
  type: "navigation"
}, "2026-06-02T10:00:08Z");
const hooks = createLogBrewSvelteKitHooks(errorContext, {
  evidence: {
    likelyRootCause: "The order state decoder rejected a valid value.",
    likelyFixArea: { file: "src/lib/orders.js", function: "decodeOrder", line: 42 }
  },
  now: () => "2026-06-02T10:00:09Z",
  nowMs: (() => {
    const values = [100, 112];
    return () => values.shift();
  })(),
  randomValues: deterministicBytes
});
const requestEvent = {
  request: {
    headers: {
      get: (name) => name === "traceparent"
        ? "00-11111111111111111111111111111111-2222222222222222-01"
        : null
    },
    method: "GET"
  },
  route: { id: "/orders/[id]" }
};
const response = await hooks.handle({
  event: requestEvent,
  resolve: async () => ({ status: 500 })
});
if (response.status !== 500) {
  throw new Error("SvelteKit handle changed the app response");
}
const malformedResponse = await createLogBrewSvelteKitHooks(errorContext, {
  captureRequests: false,
  randomValues: deterministicBytes
}).handle({
  event: { request: { headers: { get: () => "malformed" }, method: "GET" } },
  resolve: async () => ({ status: 204 })
});
if (malformedResponse.status !== 204) {
  throw new Error("malformed traceparent changed the app response");
}
await hooks.handleError({
  error: new Error("component exploded"),
  event: requestEvent,
  message: "Internal Error",
  status: 500
});

const errorEvents = errorTransport.sentBodies.flatMap((body) => JSON.parse(body).events);
const requestSpan = errorEvents.find((event) => event.type === "span");
const capturedIssue = errorEvents.find((event) => event.type === "issue");
if (!requestSpan || !capturedIssue
  || requestSpan.attributes.metadata?.operation !== "http.server"
  || capturedIssue.attributes.exception?.mechanism?.type !== "sveltekit.handle_error"
  || capturedIssue.attributes.exception?.mechanism?.handled !== false
  || capturedIssue.attributes.exceptionChain?.entries?.length !== 1
  || capturedIssue.attributes.stackFrames?.length < 1
  || capturedIssue.attributes.breadcrumbs?.length !== 1
  || capturedIssue.attributes.breadcrumbs[0].category !== "sveltekit.request"
  || capturedIssue.attributes.metadata?.routeTemplate !== "/orders/[id]"
  || capturedIssue.attributes.metadata?.errorStack !== undefined
  || capturedIssue.attributes.metadata?.traceId !== requestSpan.attributes.traceId
  || capturedIssue.attributes.metadata?.spanId !== requestSpan.attributes.spanId
  || capturedIssue.attributes.evidence?.likelyFixArea?.file !== "src/lib/orders.js") {
  throw new Error(`unexpected correlated SvelteKit evidence: ${JSON.stringify(errorEvents)}`);
}

await captureSvelteError(new Error("second component failure"), errorContext, {
  component: "ExplodingSvelteComponent",
  errorEvent(error) {
    return createSvelteErrorEvent(error, {
      component: "ExplodingSvelteComponent",
      idFactory: () => "evt_svelte_error_002",
      info: "boundary",
      now: () => "2026-06-02T10:00:10Z"
    });
  }
});
if (JSON.parse(errorTransport.lastBody()).events[0].id !== "evt_svelte_error_002") {
  throw new Error("captureSvelteError must keep the shared context reusable");
}
if (JSON.parse(errorTransport.lastBody()).events[0].attributes.breadcrumbs?.length !== 1) {
  throw new Error("component capture must retain its client breadcrumbs");
}

const propagatedRequests = [];
const tracedFetch = createTraceparentFetch({
  fetchImpl: async (input, init = {}) => {
    propagatedRequests.push({ input, init });
    return { status: 204 };
  },
  traceparentFactory: () => createSvelteTraceparent({
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
  defaultDelivery: deliveredRequests.length,
  events: JSON.parse(payload).events.length,
  issueEvidence: capturedIssue.attributes.stackFrames.length,
  missingContextFailed,
  propagatedTraceparent,
  rendered: true
}));

async function compileComponent(filename, source) {
  const dir = await mkdtemp(join(process.cwd(), ".logbrew-svelte-smoke-"));
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

function deterministicBytes(length) {
  return Uint8Array.from({ length }, (_value, index) => index + 1);
}
