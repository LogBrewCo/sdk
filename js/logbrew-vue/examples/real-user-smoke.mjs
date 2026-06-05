import { createSSRApp, defineComponent, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { RecordingTransport } from "@logbrew/sdk";
import {
  captureVueError,
  createLogBrewVueClient,
  createLogBrewVuePlugin,
  createTraceparentFetch,
  createVueErrorEvent,
  createVueTraceparent,
  createVueViewEvent,
  shouldPropagateTraceparent,
  useLogBrew
} from "@logbrew/vue";

const requestTransport = new RecordingTransport([{ statusCode: 503 }, { statusCode: 202 }]);
const errorTransport = RecordingTransport.alwaysAccept();
const manualErrorTransport = RecordingTransport.alwaysAccept();
const client = createLogBrewVueClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "vue-smoke-app",
  sdkVersion: "0.1.0",
  maxRetries: 1
});

const App = defineComponent({
  name: "VueSmokeApp",
  setup() {
    const logbrew = useLogBrew();
    addFullBatch(logbrew.client);
    const event = createVueViewEvent("VueSmokeApp", {
      idFactory: () => "evt_vue_view_001",
      now: () => "2026-06-02T10:00:06Z",
      path: "/smoke"
    });
    if (event.attributes.metadata.path !== "/smoke") {
      throw new Error(`unexpected view event: ${JSON.stringify(event)}`);
    }
    return () => h("pre", "LogBrew Vue smoke");
  }
});

const app = createSSRApp(App);
app.use(createLogBrewVuePlugin({
  captureErrors: false,
  client,
  transport: requestTransport
}));

await renderToString(app);
const payload = client.previewJson();
await client.shutdown(requestTransport);

const errorClient = createLogBrewVueClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "vue-error-smoke",
  sdkVersion: "0.1.0"
});
const ErrorComponent = defineComponent({
  name: "ExplodingVueComponent",
  setup() {
    throw new Error("component exploded");
  }
});
const errorApp = createSSRApp(ErrorComponent);
errorApp.use(createLogBrewVuePlugin({
  client: errorClient,
  errorEvent(error, { instance, info }) {
    return createVueErrorEvent(error, instance, info, {
      idFactory: () => "evt_vue_error_001",
      now: () => "2026-06-02T10:00:07Z"
    });
  },
  transport: errorTransport
}));
try {
  await renderToString(errorApp);
} catch (error) {
  if (!(error instanceof Error) || error.message !== "component exploded") {
    throw error;
  }
}
await waitFor(() => errorTransport.sentBodies.length === 1);

const manualContext = {
  client: createLogBrewVueClient({
    clientKey: "LOGBREW_CLIENT_KEY",
    sdkName: "vue-manual-error-smoke",
    sdkVersion: "0.1.0"
  }),
  logbrew: null,
  transport: manualErrorTransport,
  previewJson() {
    return this.client.previewJson();
  },
  flush() {
    return this.client.flush(this.transport);
  },
  shutdown() {
    return this.client.shutdown(this.transport);
  }
};
manualContext.logbrew = manualContext.client;
await captureVueError(new Error("manual vue failure"), null, "manual", manualContext, {
  idFactory: () => "evt_vue_error_manual",
  now: () => "2026-06-02T10:00:08Z"
});

const errorPayload = JSON.parse(errorTransport.lastBody());
if (errorPayload.events[0].type !== "issue" || errorPayload.events[0].id !== "evt_vue_error_001") {
  throw new Error(`unexpected error payload: ${errorTransport.lastBody()}`);
}
const manualErrorPayload = JSON.parse(manualErrorTransport.lastBody());
if (manualErrorPayload.events[0].id !== "evt_vue_error_manual") {
  throw new Error(`unexpected manual error payload: ${manualErrorTransport.lastBody()}`);
}

const propagatedRequests = [];
const tracedFetch = createTraceparentFetch({
  fetchImpl: async (input, init = {}) => {
    propagatedRequests.push({ input, init });
    return { status: 204 };
  },
  traceparentFactory: () => createVueTraceparent({
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
  errorCaptured: errorPayload.events[0].attributes.title,
  events: JSON.parse(payload).events.length,
  manualErrorCaptured: manualErrorPayload.events[0].attributes.title,
  propagatedTraceparent,
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

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error("timed out waiting for Vue capture");
}

function deterministicBytes(length) {
  return Uint8Array.from({ length }, (_value, index) => index + 1);
}
