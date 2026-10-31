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
import { compileComponent, readPath } from "./support.mjs";
import { RecordingTransport } from "@logbrew/sdk";
import { render } from "svelte/server";

/**
 * @typedef {{ readonly endpoint: unknown, readonly init: unknown }} DeliveredRequest
 * @typedef {{ readonly init: unknown, readonly input: unknown }} PropagatedRequest
 */

const UNAVAILABLE = 503;
const ACCEPTED = 202;
const NO_CONTENT = 204;
const SERVER_ERROR = 500;
const REQUEST_STARTED_MS = 100;
const REQUEST_ENDED_MS = 112;
const FIRST = 0;
const SECOND = 1;
const THIRD = 2;
const ONE = 1;
const BYTE_OFFSET = 1;

/**
 * @param {string | null} text
 * @returns {unknown}
 */
function parseBody(text) {
  return text === null ? undefined : JSON.parse(text);
}

/**
 * @param {string} body
 * @returns {unknown[]}
 */
function eventsInBody(body) {
  const events = readPath(parseBody(body), ["events"]);
  return Array.isArray(events) ? events : [];
}

/**
 * @param {number} length
 * @returns {Uint8Array}
 */
function deterministicBytes(length) {
  return Uint8Array.from({ length }, (_value, index) => index + BYTE_OFFSET);
}

/**
 * @param {unknown} span
 * @param {unknown} issue
 * @returns {boolean}
 */
function correlatedEvidence(span, issue) {
  const frames = readPath(issue, ["attributes", "stackFrames", "length"]);
  return readPath(span, ["attributes", "metadata", "operation"]) === "http.server"
    && readPath(issue, ["attributes", "exception", "mechanism", "type"]) === "sveltekit.handle_error"
    && readPath(issue, ["attributes", "exception", "mechanism", "handled"]) === false
    && readPath(issue, ["attributes", "exceptionChain", "entries", "length"]) === ONE
    && !(typeof frames === "number" && frames < ONE)
    && readPath(issue, ["attributes", "breadcrumbs", "length"]) === ONE
    && readPath(issue, ["attributes", "breadcrumbs", FIRST, "category"]) === "sveltekit.request"
    && readPath(issue, ["attributes", "metadata", "routeTemplate"]) === "/orders/[id]"
    && readPath(issue, ["attributes", "metadata", "errorStack"]) === undefined
    && readPath(issue, ["attributes", "metadata", "traceId"]) === readPath(span, ["attributes", "traceId"])
    && readPath(issue, ["attributes", "metadata", "spanId"]) === readPath(span, ["attributes", "spanId"])
    && readPath(issue, ["attributes", "evidence", "likelyFixArea", "file"]) === "src/lib/orders.js";
}

const requestTransport = new RecordingTransport([{ statusCode: UNAVAILABLE }, { statusCode: ACCEPTED }]);
const errorTransport = RecordingTransport.alwaysAccept();
const client = createLogBrewSvelteClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  maxRetries: 1,
  sdkName: "svelte-smoke-app",
  sdkVersion: "0.1.0"
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
`, ".logbrew-svelte-smoke-");

const rendered = render(App, { props: { client, transport: requestTransport } });
if (!rendered.body.includes("LogBrew Svelte smoke")) {
  throw new Error(`unexpected Svelte render output: ${rendered.body}`);
}
const payload = client.previewJson();
await client.shutdown(requestTransport);

const missingContext = { failed: false };
const MissingContext = await compileComponent("MissingContext.svelte", `
<script>
  import { useLogBrew } from "@logbrew/svelte";
  useLogBrew();
</script>
`, ".logbrew-svelte-smoke-");
try {
  void render(MissingContext).body;
} catch (error) {
  if (readPath(error, ["code"]) !== "configuration_error") {
    throw error;
  }
  missingContext.failed = true;
}
if (!missingContext.failed) {
  throw new Error("expected missing Svelte context to fail");
}

/** @type {DeliveredRequest[]} */
const deliveredRequests = [];
const deliveryContext = createLogBrewSvelteContext({
  clientKey: "LOGBREW_CLIENT_KEY",
  fetchImpl: async (endpoint, init) => {
    deliveredRequests.push({ endpoint, init });
    return new Response(undefined, { status: ACCEPTED });
  },
  sdkName: "svelte-delivery-smoke",
  sdkVersion: "0.1.1"
});
deliveryContext.client.log("evt_svelte_delivery_001", "2026-06-02T10:00:07Z", {
  level: "info",
  message: "Svelte delivery probe"
});
await deliveryContext.flush();
if (readPath(deliveredRequests, [FIRST, "endpoint"]) !== "https://api.logbrew.co/v1/events"
  || readPath(deliveredRequests, [FIRST, "init", "headers", "authorization"]) !== "Bearer LOGBREW_CLIENT_KEY") {
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
const nowValues = [REQUEST_STARTED_MS, REQUEST_ENDED_MS];
const hooks = createLogBrewSvelteKitHooks(errorContext, {
  evidence: {
    likelyFixArea: { file: "src/lib/orders.js", function: "decodeOrder", line: 42 },
    likelyRootCause: "The order state decoder rejected a valid value."
  },
  now: () => "2026-06-02T10:00:09Z",
  nowMs: () => nowValues.shift() ?? REQUEST_ENDED_MS,
  randomValues: deterministicBytes
});
const requestEvent = {
  request: {
    headers: new Headers({ traceparent: "00-11111111111111111111111111111111-2222222222222222-01" }),
    method: "GET"
  },
  route: { id: "/orders/[id]" }
};
const response = await hooks.handle({
  event: requestEvent,
  resolve: async () => ({ status: SERVER_ERROR })
});
if (response.status !== SERVER_ERROR) {
  throw new Error("SvelteKit handle changed the app response");
}
const malformedResponse = await createLogBrewSvelteKitHooks(errorContext, {
  captureRequests: false,
  randomValues: deterministicBytes
}).handle({
  event: { request: { headers: new Headers({ traceparent: "malformed" }), method: "GET" } },
  resolve: async () => ({ status: NO_CONTENT })
});
if (malformedResponse.status !== NO_CONTENT) {
  throw new Error("malformed traceparent changed the app response");
}
await hooks.handleError({
  error: new Error("component exploded"),
  event: requestEvent,
  message: "Internal Error",
  status: SERVER_ERROR
});

const errorEvents = errorTransport.sentBodies.flatMap((body) => eventsInBody(body));
const requestSpan = errorEvents.find((event) => readPath(event, ["type"]) === "span");
const capturedIssue = errorEvents.find((event) => readPath(event, ["type"]) === "issue");
if (requestSpan === undefined || capturedIssue === undefined || !correlatedEvidence(requestSpan, capturedIssue)) {
  throw new Error(`unexpected correlated SvelteKit evidence: ${JSON.stringify(errorEvents)}`);
}

await captureSvelteError(new Error("second component failure"), errorContext, {
  component: "ExplodingSvelteComponent",
  errorEvent: (error) => createSvelteErrorEvent(error, {
    component: "ExplodingSvelteComponent",
    idFactory: () => "evt_svelte_error_002",
    info: "boundary",
    now: () => "2026-06-02T10:00:10Z"
  })
});
const lastEvent = readPath(parseBody(errorTransport.lastBody()), ["events", FIRST]);
if (readPath(lastEvent, ["id"]) !== "evt_svelte_error_002") {
  throw new Error("captureSvelteError must keep the shared context reusable");
}
if (readPath(lastEvent, ["attributes", "breadcrumbs", "length"]) !== ONE) {
  throw new Error("component capture must retain its client breadcrumbs");
}

/** @type {PropagatedRequest[]} */
const propagatedRequests = [];
const tracedFetch = createTraceparentFetch({
  fetchImpl: async (input, init = {}) => {
    propagatedRequests.push({ init, input });
    return new Response(undefined, { status: NO_CONTENT });
  },
  tracePropagationTargets: ["https://api.example.test/", /^\/api\//u],
  traceparentFactory: () => createSvelteTraceparent({
    randomValues: deterministicBytes
  })
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
const propagatedTraceparent = readPath(propagatedRequests, [FIRST, "init", "headers", "traceparent"]);
if (propagatedTraceparent !== "00-0102030405060708090a0b0c0d0e0f10-0102030405060708-01") {
  throw new Error(`unexpected propagated traceparent: ${String(propagatedTraceparent)}`);
}
if (readPath(propagatedRequests, [FIRST, "init", "headers", "accept"]) !== "application/json") {
  throw new Error("expected traced fetch to preserve existing headers");
}
if (readPath(propagatedRequests, [SECOND, "init", "headers", "traceparent"]) !== undefined) {
  throw new Error("unmatched requests should not receive traceparent");
}
if (readPath(propagatedRequests, [THIRD, "init", "headers", "traceparent"]) !== propagatedTraceparent) {
  throw new Error("relative matched requests should receive traceparent");
}

const eventCount = readPath(parseBody(payload), ["events", "length"]);
const issueEvidence = readPath(capturedIssue, ["attributes", "stackFrames", "length"]);
process.stdout.write(`${payload}\n`);
process.stderr.write(`${JSON.stringify({
  ok: true,

  attempts: requestTransport.sentBodies.length,
  defaultDelivery: deliveredRequests.length,
  events: eventCount,
  issueEvidence,
  missingContextFailed: missingContext.failed,
  propagatedTraceparent,
  rendered: true
})}\n`);
