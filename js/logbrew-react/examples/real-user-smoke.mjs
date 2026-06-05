import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const sdk = await import("@logbrew/sdk").catch(async (error) => {
  if (error && error.code === "ERR_MODULE_NOT_FOUND") {
    return import("../../logbrew-js/index.js");
  }
  throw error;
});

const reactSdk = await import("@logbrew/react").catch(async (error) => {
  if (error && error.code === "ERR_MODULE_NOT_FOUND") {
    return import("../index.js");
  }
  throw error;
});

const { RecordingTransport } = sdk;
const {
  LogBrewProvider,
  captureReactError,
  createLogBrewReactClient,
  createReactErrorEvent,
  createReactTraceparent,
  createTraceparentFetch,
  shouldPropagateTraceparent,
  useLogBrew,
  useLogBrewActions
} = reactSdk;

const client = createLogBrewReactClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "logbrew-react",
  sdkVersion: "0.1.0",
  maxRetries: 1
});

function HookSmoke() {
  const logbrew = useLogBrew();
  const actions = useLogBrewActions();
  actions.release("evt_release_001", "2026-06-02T10:00:00Z", {
    version: "1.2.3",
    commit: "abc123def456",
    notes: "Public release marker"
  });
  actions.environment("evt_environment_001", "2026-06-02T10:00:01Z", {
    name: "production",
    region: "global"
  });
  actions.issue("evt_issue_001", "2026-06-02T10:00:02Z", {
    title: "Checkout timeout",
    level: "error",
    message: "Request timed out after retry budget"
  });
  actions.log("evt_log_001", "2026-06-02T10:00:03Z", {
    message: "worker started",
    level: "info",
    logger: "job-runner"
  });
  actions.span("evt_span_001", "2026-06-02T10:00:04Z", {
    name: "GET /health",
    traceId: "trace_001",
    spanId: "span_001",
    status: "ok",
    durationMs: 12.5
  });
  actions.action("evt_action_001", "2026-06-02T10:00:05Z", {
    name: "deploy",
    status: "success"
  });
  return React.createElement("span", { "data-logbrew-pending": logbrew.pendingEvents() }, "pending events");
}

const markup = renderToStaticMarkup(
  React.createElement(
    LogBrewProvider,
    { client },
    React.createElement(HookSmoke)
  )
);
if (!markup.includes('data-logbrew-pending="6"')) {
  throw new Error(`expected hook actions to create six pending events, got ${markup}`);
}

try {
  renderToStaticMarkup(React.createElement(() => {
    useLogBrew();
    return React.createElement("span", null, "unreachable");
  }));
  throw new Error("expected useLogBrew outside provider to fail");
} catch (error) {
  if (error?.code !== "configuration_error") {
    throw error;
  }
}

const propagatedRequests = [];
const tracedFetch = createTraceparentFetch({
  fetchImpl: async (input, init = {}) => {
    propagatedRequests.push({ input, init });
    return { status: 204 };
  },
  traceparentFactory: () => createReactTraceparent({
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

const errorClient = createLogBrewReactClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "logbrew-react-errors",
  sdkVersion: "0.1.0",
  maxRetries: 1
});
const componentError = new Error("Checkout component failed");
componentError.stack = "Error: Checkout component failed\n    at CheckoutButton";
captureReactError(errorClient, componentError, {
  id: "evt_issue_react_error",
  timestamp: "2026-06-02T10:00:06Z",
  componentStack: "\n    at CheckoutButton\n    at LogBrewErrorBoundary",
  metadata: { route: "checkout" }
});
captureReactError(errorClient, "non-error React failure", {
  id: "evt_issue_react_non_error",
  timestamp: "2026-06-02T10:00:07Z",
  level: "warning",
  metadata: { route: "checkout" }
});
const stackEvent = createReactErrorEvent(componentError, {
  id: "evt_issue_react_stack",
  timestamp: "2026-06-02T10:00:08Z",
  componentStack: "\n    at CheckoutButton",
  includeStack: true
});
errorClient.issue(stackEvent.id, stackEvent.timestamp, stackEvent.attributes);
const errorPreview = JSON.parse(errorClient.previewJson());
if (errorPreview.events.length !== 3) {
  throw new Error(`expected three React error events, got ${errorPreview.events.length}`);
}
const [boundaryLike, nonErrorLike, stackLike] = errorPreview.events;
if (boundaryLike.attributes.title !== "React error: Checkout component failed") {
  throw new Error(`unexpected React error title: ${boundaryLike.attributes.title}`);
}
if (boundaryLike.attributes.metadata.source !== "react.error") {
  throw new Error("expected React error source metadata");
}
if (!boundaryLike.attributes.metadata.componentStack.includes("CheckoutButton")) {
  throw new Error("expected component stack metadata for React error");
}
if ("errorStack" in boundaryLike.attributes.metadata) {
  throw new Error("expected raw error stack to stay opt-in");
}
if (nonErrorLike.attributes.level !== "warning" || nonErrorLike.attributes.metadata.errorValueType !== "string") {
  throw new Error("expected non-Error React capture to keep warning level and value type");
}
if (stackLike.attributes.metadata.errorStack !== componentError.stack) {
  throw new Error("expected includeStack to attach raw error stack metadata");
}

const preview = client.previewJson();
const retryTransport = new RecordingTransport([
  { statusCode: 503 },
  { statusCode: 202 }
]);
const response = await client.shutdown(retryTransport);
const errorResponse = await errorClient.shutdown(new RecordingTransport([
  { statusCode: 503 },
  { statusCode: 202 }
]));

console.log(preview);
console.error(JSON.stringify({
  ok: true,
  status: response.statusCode,
  attempts: response.attempts,
  events: 6,
  manualErrorAttempts: errorResponse.attempts,
  manualErrorEvents: errorPreview.events.length,
  propagatedTraceparent,
  rendered: true
}));

function deterministicBytes(length) {
  return Uint8Array.from({ length }, (_value, index) => index + 1);
}
