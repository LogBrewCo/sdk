import { ErrorHandler, createEnvironmentInjector, runInInjectionContext } from "@angular/core";
import { RecordingTransport } from "@logbrew/sdk";
import {
  captureAngularError,
  createAngularErrorEvent,
  createAngularTraceparent,
  createAngularViewEvent,
  createLogBrewAngularClient,
  createLogBrewAngularContext,
  createTraceparentFetch,
  injectLogBrew,
  provideLogBrew,
  shouldPropagateTraceparent
} from "@logbrew/angular";

const requestTransport = new RecordingTransport([{ statusCode: 503 }, { statusCode: 202 }]);
const errorTransport = RecordingTransport.alwaysAccept();
const manualErrorTransport = RecordingTransport.alwaysAccept();
const client = createLogBrewAngularClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "angular-smoke-app",
  sdkVersion: "0.1.0",
  maxRetries: 1
});

const injector = createEnvironmentInjector(provideLogBrew({
  captureErrors: false,
  client,
  transport: requestTransport
}), null);

runInInjectionContext(injector, () => {
  const logbrew = injectLogBrew();
  addFullBatch(logbrew.client);
  const event = createAngularViewEvent("AngularSmokeComponent", {
    idFactory: () => "evt_angular_view_001",
    now: () => "2026-06-02T10:00:06Z",
    path: "/smoke"
  });
  if (event.attributes.metadata.path !== "/smoke") {
    throw new Error(`unexpected view event: ${JSON.stringify(event)}`);
  }
});

const payload = client.previewJson();
await client.shutdown(requestTransport);

let delegated = false;
const errorClient = createLogBrewAngularClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "angular-error-smoke",
  sdkVersion: "0.1.0"
});
const errorInjector = createEnvironmentInjector(provideLogBrew({
  client: errorClient,
  delegateErrorHandler(error) {
    delegated = error instanceof Error && error.message === "component exploded";
  },
  errorEvent(error) {
    return createAngularErrorEvent(error, {
      component: "AngularSmokeComponent",
      info: "change detection",
      route: "/smoke"
    }, {
      idFactory: () => "evt_angular_error_001",
      now: () => "2026-06-02T10:00:07Z"
    });
  },
  transport: errorTransport
}), null);
errorInjector.get(ErrorHandler).handleError(new Error("component exploded"));
await waitFor(() => errorTransport.sentBodies.length === 1);
if (!delegated) {
  throw new Error("expected delegate error handler to be called");
}

const manualClient = createLogBrewAngularClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "angular-manual-error-smoke",
  sdkVersion: "0.1.0"
});
const manualContext = createLogBrewAngularContext(manualClient, manualErrorTransport);
await captureAngularError(new Error("manual angular failure"), manualContext, {
  component: "ManualAngularComponent",
  idFactory: () => "evt_angular_error_manual",
  now: () => "2026-06-02T10:00:08Z"
});

const errorPayload = JSON.parse(errorTransport.lastBody());
if (errorPayload.events[0].type !== "issue" || errorPayload.events[0].id !== "evt_angular_error_001") {
  throw new Error(`unexpected error payload: ${errorTransport.lastBody()}`);
}
const manualErrorPayload = JSON.parse(manualErrorTransport.lastBody());
if (manualErrorPayload.events[0].id !== "evt_angular_error_manual") {
  throw new Error(`unexpected manual error payload: ${manualErrorTransport.lastBody()}`);
}

const propagatedRequests = [];
const tracedFetch = createTraceparentFetch({
  fetchImpl: async (input, init = {}) => {
    propagatedRequests.push({ input, init });
    return { status: 204 };
  },
  traceparentFactory: () => createAngularTraceparent({
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
  delegated,
  errorCaptured: errorPayload.events[0].attributes.title,
  events: JSON.parse(payload).events.length,
  manualErrorCaptured: manualErrorPayload.events[0].attributes.title,
  propagatedTraceparent,
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

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error("timed out waiting for Angular capture");
}

function deterministicBytes(length) {
  return Uint8Array.from({ length }, (_value, index) => index + 1);
}
