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
import { createSSRApp, defineComponent, h } from "vue";
import { RecordingTransport } from "@logbrew/sdk";
import { renderToString } from "vue/server-renderer";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * @import { LogBrewClient } from "@logbrew/sdk"
 * @import { LogBrewVueContext } from "@logbrew/vue"
 * @typedef {{ readonly init: unknown, readonly input: unknown }} PropagatedRequest
 */

const UNAVAILABLE = 503;
const ACCEPTED = 202;
const NO_CONTENT = 204;
const POLL_ATTEMPTS = 20;
const POLL_DELAY_MS = 10;
const ONE_BODY = 1;
const FIRST = 0;
const SECOND = 1;
const THIRD = 2;
const BYTE_OFFSET = 1;
const FIRST_ATTEMPT = 0;

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
 * @param {() => boolean} predicate
 * @param {number} [attempt]
 * @returns {Promise<void>}
 */
async function waitFor(predicate, attempt = FIRST_ATTEMPT) {
  if (predicate()) {
    return;
  }
  if (attempt + ONE_BODY >= POLL_ATTEMPTS) {
    throw new Error("timed out waiting for Vue capture");
  }
  await sleep(POLL_DELAY_MS);
  await waitFor(predicate, attempt + ONE_BODY);
}

/**
 * @param {number} length
 * @returns {Uint8Array}
 */
function deterministicBytes(length) {
  return Uint8Array.from({ length }, (_value, index) => index + BYTE_OFFSET);
}

/**
 * @param {unknown} value
 * @param {readonly (string | number)[]} path
 * @returns {unknown}
 */
function readPath(value, path) {
  /** @type {unknown} */
  let current = value;
  for (const key of path) {
    current = typeof current === "object" && current !== null ? Reflect.get(current, key) : undefined;
  }
  return current;
}

/**
 * @param {string | null} text
 * @returns {unknown}
 */
function parseBody(text) {
  return text === null ? undefined : JSON.parse(text);
}

const requestTransport = new RecordingTransport([{ statusCode: UNAVAILABLE }, { statusCode: ACCEPTED }]);
const errorTransport = RecordingTransport.alwaysAccept();
const manualErrorTransport = RecordingTransport.alwaysAccept();
const client = createLogBrewVueClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  maxRetries: 1,
  sdkName: "vue-smoke-app",
  sdkVersion: "0.1.1"
});

const App = defineComponent({
  name: "VueSmokeApp",
  setup: () => {
    const logbrew = useLogBrew();
    addFullBatch(logbrew.client);
    const event = createVueViewEvent("VueSmokeApp", {
      idFactory: () => "evt_vue_view_001",
      now: () => "2026-06-02T10:00:06Z",
      path: "/smoke"
    });
    if (event.attributes.metadata?.["path"] !== "/smoke") {
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
  sdkVersion: "0.1.1"
});
const ErrorComponent = defineComponent({
  name: "ExplodingVueComponent",
  setup: () => {
    throw new Error("component exploded");
  }
});
const errorApp = createSSRApp(ErrorComponent);
errorApp.use(createLogBrewVuePlugin({
  client: errorClient,
  errorEvent: (error, { instance, info }) => createVueErrorEvent(error, instance, info, {
    idFactory: () => "evt_vue_error_001",
    now: () => "2026-06-02T10:00:07Z"
  }),
  transport: errorTransport
}));
try {
  await renderToString(errorApp);
} catch (error) {
  if (!(error instanceof Error) || error.message !== "component exploded") {
    throw error;
  }
}
await waitFor(() => errorTransport.sentBodies.length === ONE_BODY);

const manualClient = createLogBrewVueClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "vue-manual-error-smoke",
  sdkVersion: "0.1.1"
});
/** @type {LogBrewVueContext} */
const manualContext = {
  client: manualClient,
  logbrew: manualClient,
  transport: manualErrorTransport,

  previewJson: () => manualClient.previewJson(),

  flush: async () => manualClient.flush(manualErrorTransport),
  shutdown: async () => manualClient.shutdown(manualErrorTransport)
};
await captureVueError(new Error("manual vue failure"), null, "manual", manualContext, {
  idFactory: () => "evt_vue_error_manual",
  now: () => "2026-06-02T10:00:08Z"
});

const errorPayload = parseBody(errorTransport.lastBody());
const errorEvent = readPath(errorPayload, ["events", FIRST]);
if (readPath(errorEvent, ["type"]) !== "issue" || readPath(errorEvent, ["id"]) !== "evt_vue_error_001") {
  throw new Error(`unexpected error payload: ${String(errorTransport.lastBody())}`);
}
const manualErrorPayload = parseBody(manualErrorTransport.lastBody());
if (readPath(manualErrorPayload, ["events", FIRST, "id"]) !== "evt_vue_error_manual") {
  throw new Error(`unexpected manual error payload: ${String(manualErrorTransport.lastBody())}`);
}

/** @type {PropagatedRequest[]} */
const propagatedRequests = [];
const tracedFetch = createTraceparentFetch({
  fetchImpl: async (input, init = {}) => {
    propagatedRequests.push({ init, input });
    return { status: NO_CONTENT };
  },
  tracePropagationTargets: ["https://api.example.test/", /^\/api\//u],
  traceparentFactory: () => createVueTraceparent({
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
process.stdout.write(`${payload}\n`);
process.stderr.write(`${JSON.stringify({
  ok: true,

  attempts: requestTransport.sentBodies.length,
  errorCaptured: readPath(errorEvent, ["attributes", "title"]),
  events: eventCount,
  manualErrorCaptured: readPath(manualErrorPayload, ["events", FIRST, "attributes", "title"]),
  propagatedTraceparent,
  viewHelper: "evt_vue_view_001"
})}\n`);
