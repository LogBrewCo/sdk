import { LogBrewClient } from "@logbrew/sdk";
import { once } from "node:events";

/**
 * @import { DroppedEvent } from "@logbrew/sdk"
 * @typedef {Readonly<{
 *   maxBatchBytes?: number,
 *   maxBatchEvents?: number,
 *   maxQueueBytes?: number,
 *   maxQueueSize?: number,
 *   maxRetries?: number,
 *   onEventDropped?: (drop: Readonly<DroppedEvent>) => void,
 *   sdkName?: string,
 *   sdkVersion?: string
 * }>} ClientOverrides
 * @typedef {{ readonly promise: Promise<void>, readonly resolve: () => void }} Signal
 * @typedef {Readonly<{ statusCode: number }>} StatusResponse
 * @typedef {{ readonly promise: Promise<StatusResponse>, readonly resolve: (response: StatusResponse) => void }} PendingResponse
 * @typedef {{ readonly send: (apiKey: string, body: string) => Promise<StatusResponse> }} StatusTransport
 * @typedef {{
 *   readonly release: (response: StatusResponse) => void,
 *   readonly sentBodies: readonly string[],
 *   readonly started: Readonly<Promise<void>>,
 *   readonly transport: StatusTransport
 * }} HeldTransport
 * @typedef {(...args: readonly never[]) => unknown} AnyFunction
 */

const SUPPORTED_EVENT_TYPES = ["release", "environment", "issue", "log", "span", "action"];
const EXPECTED_EVENT_COUNT = SUPPORTED_EVENT_TYPES.length;
const DEFAULT_MAX_RETRIES = 2;
const SPAN_DURATION_MS = 12.5;
const RESOLVED = "resolved";
const ACCEPTED = 202;
const FIRST_SEND = 1;

/**
 * @param {ClientOverrides} overrides
 * @returns {LogBrewClient}
 */
function sampleClient(overrides = {}) {
  return LogBrewClient.create({
    apiKey: "LOGBREW_API_KEY",
    maxRetries: DEFAULT_MAX_RETRIES,
    sdkName: "logbrew-js",
    sdkVersion: "0.1.0",
    ...overrides
  });
}

/**
 * @param {LogBrewClient} client
 * @returns {void}
 */
function enqueueAll(client) {
  client.release("evt_release_001", "2026-06-02T10:00:00Z", {
    commit: "abc123def456",
    version: "1.2.3"
  });
  client.environment("evt_environment_001", "2026-06-02T10:00:01Z", {
    name: "production",
    region: "global"
  });
  client.issue("evt_issue_001", "2026-06-02T10:00:02Z", {
    level: "error",
    message: "Request timed out after retry budget",
    title: "Checkout timeout"
  });
  client.log("evt_log_001", "2026-06-02T10:00:03Z", {
    level: "info",
    logger: "job-runner",
    message: "worker started"
  });
  client.span("evt_span_001", "2026-06-02T10:00:04Z", {
    durationMs: SPAN_DURATION_MS,
    name: "GET /health",
    spanId: "span_001",
    status: "ok",
    traceId: "trace_001"
  });
  client.action("evt_action_001", "2026-06-02T10:00:05Z", {
    name: "deploy",
    status: "success"
  });
}

/**
 * @param {() => Promise<unknown>} run
 * @returns {Promise<unknown>}
 */
async function captureRejection(run) {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected callback to reject");
}

/**
 * @param {Readonly<Promise<readonly unknown[]>>} pending
 * @returns {Promise<void>}
 */
async function settled(pending) {
  await pending;
}

/**
 * @returns {Signal}
 */
function signal() {
  const target = new EventTarget();
  const pending = once(target, RESOLVED);
  return {
    promise: settled(pending),
    resolve() {
      target.dispatchEvent(new Event(RESOLVED));
    }
  };
}

/**
 * @param {Readonly<Promise<void>>} opened
 * @param {readonly StatusResponse[]} responses
 * @returns {Promise<StatusResponse>}
 */
async function responseAfter(opened, responses) {
  await opened;
  const [response] = responses;
  if (response === undefined) {
    throw new Error("expected a transport response");
  }
  return response;
}

/**
 * @returns {PendingResponse}
 */
function pendingResponse() {
  const gate = signal();
  /** @type {StatusResponse[]} */
  const responses = [];
  return {
    promise: responseAfter(gate.promise, responses),
    resolve(response) {
      responses.push(response);
      gate.resolve();
    }
  };
}

/**
 * @returns {HeldTransport}
 */
function heldTransport() {
  const started = signal();
  const response = pendingResponse();
  /** @type {string[]} */
  const sentBodies = [];
  return {
    release: response.resolve,
    sentBodies,
    started: started.promise,
    transport: {
      async send(_apiKey, body) {
        sentBodies.push(body);
        if (sentBodies.length === FIRST_SEND) {
          started.resolve();
          return response.promise;
        }
        return { statusCode: ACCEPTED };
      }
    }
  };
}

/**
 * @param {unknown} value
 * @returns {value is Readonly<Record<string, unknown>>}
 */
function isRecord(value) {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {unknown}
 */
function field(value, key) {
  return isRecord(value) ? value[key] : undefined;
}

/**
 * @param {unknown} value
 * @returns {readonly unknown[]}
 */
function list(value) {
  /** @type {readonly unknown[]} */
  const items = Array.isArray(value) ? value : [];
  return items;
}

/**
 * @param {string} body
 * @returns {readonly unknown[]}
 */
function bodyEvents(body) {
  /** @type {unknown} */
  const payload = JSON.parse(body);
  return list(field(payload, "events"));
}

/**
 * @param {string | null | undefined} body
 * @returns {readonly unknown[]}
 */
function bodyEventIds(body) {
  if (typeof body !== "string") {
    throw new TypeError("expected a request body");
  }
  return bodyEvents(body).map((event) => field(event, "id"));
}

/**
 * @param {LogBrewClient} client
 * @returns {readonly unknown[]}
 */
function previewEventIds(client) {
  return bodyEventIds(client.previewJson());
}

/**
 * @param {LogBrewClient} client
 * @returns {unknown}
 */
function firstPreviewEvent(client) {
  const [event] = bodyEvents(client.previewJson());
  return event;
}

/**
 * @param {AnyFunction} target
 * @param {readonly unknown[]} args
 * @returns {unknown}
 */
function callUnchecked(target, args) {
  /** @type {unknown} */
  const result = Reflect.apply(target, undefined, args);
  return result;
}

/**
 * @param {unknown} target
 * @param {string} name
 * @param {readonly unknown[]} args
 * @returns {unknown}
 */
function invokeUnchecked(target, name, args) {
  const method = field(target, name);
  if (typeof method !== "function") {
    throw new TypeError(`expected ${name} to be a method`);
  }
  /** @type {unknown} */
  const result = Reflect.apply(method, target, args);
  return result;
}

/**
 * @param {LogBrewClient} client
 * @param {"flush" | "shutdown"} operation
 * @param {StatusTransport} transport
 * @returns {Promise<unknown>}
 */
async function deliverUnchecked(client, operation, transport) {
  /** @type {unknown} */
  const response = await invokeUnchecked(client, operation, [transport]);
  return response;
}

export {
  EXPECTED_EVENT_COUNT,
  bodyEventIds,
  bodyEvents,
  callUnchecked,
  captureRejection,
  deliverUnchecked,
  enqueueAll,
  field,
  firstPreviewEvent,
  heldTransport,
  invokeUnchecked,
  previewEventIds,
  sampleClient
};
