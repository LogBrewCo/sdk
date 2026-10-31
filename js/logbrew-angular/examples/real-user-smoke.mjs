import { ErrorHandler, Injector, runInInjectionContext } from "@angular/core";
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
import { RecordingTransport } from "@logbrew/sdk";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * @import { LogBrewClient } from "@logbrew/sdk"
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
    throw new Error("timed out waiting for Angular capture");
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
const client = createLogBrewAngularClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  maxRetries: 1,
  sdkName: "angular-smoke-app",
  sdkVersion: "0.1.0"
});

const injector = Injector.create({ providers: provideLogBrew({
  captureErrors: false,
  client,
  transport: requestTransport
}) });

runInInjectionContext(injector, () => {
  const logbrew = injectLogBrew();
  addFullBatch(logbrew.client);
  const event = createAngularViewEvent("AngularSmokeComponent", {
    idFactory: () => "evt_angular_view_001",
    now: () => "2026-06-02T10:00:06Z",
    path: "/smoke"
  });
  if (event.attributes.metadata?.["path"] !== "/smoke") {
    throw new Error(`unexpected view event: ${JSON.stringify(event)}`);
  }
});

const payload = client.previewJson();
await client.shutdown(requestTransport);

const delegation = { delegated: false };
const errorClient = createLogBrewAngularClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "angular-error-smoke",
  sdkVersion: "0.1.0"
});
const errorInjector = Injector.create({ providers: provideLogBrew({
  client: errorClient,
  delegateErrorHandler: (error) => {
    delegation.delegated = error instanceof Error && error.message === "component exploded";
  },
  errorEvent: (error) => createAngularErrorEvent(error, {
    component: "AngularSmokeComponent",
    info: "change detection",
    route: "/smoke"
  }, {
    idFactory: () => "evt_angular_error_001",
    now: () => "2026-06-02T10:00:07Z"
  }),
  transport: errorTransport
}) });
errorInjector.get(ErrorHandler).handleError(new Error("component exploded"));
await waitFor(() => errorTransport.sentBodies.length === ONE_BODY);
if (!delegation.delegated) {
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

const errorPayload = parseBody(errorTransport.lastBody());
const errorEvent = readPath(errorPayload, ["events", FIRST]);
if (readPath(errorEvent, ["type"]) !== "issue" || readPath(errorEvent, ["id"]) !== "evt_angular_error_001") {
  throw new Error(`unexpected error payload: ${String(errorTransport.lastBody())}`);
}
const manualErrorPayload = parseBody(manualErrorTransport.lastBody());
if (readPath(manualErrorPayload, ["events", FIRST, "id"]) !== "evt_angular_error_manual") {
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
  traceparentFactory: () => createAngularTraceparent({
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
  delegated: delegation.delegated,
  errorCaptured: readPath(errorEvent, ["attributes", "title"]),
  events: eventCount,
  manualErrorCaptured: readPath(manualErrorPayload, ["events", FIRST, "attributes", "title"]),
  propagatedTraceparent,
  viewHelper: "evt_angular_view_001"
})}\n`);
