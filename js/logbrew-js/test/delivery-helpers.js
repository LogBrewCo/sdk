import { LogBrewClient } from "@logbrew/sdk";
import assert from "node:assert/strict";
import { once } from "node:events";

/**
 * @typedef {{ readonly promise: Readonly<Promise<unknown>>, readonly resolve: (value?: unknown) => void }} Deferred
 * @typedef {{ readonly send: (apiKey: string, body: string) => Promise<unknown> }} LooseTransport
 * @typedef {{ readonly response: Deferred, readonly started: Deferred, readonly transport: LooseTransport }} BlockedTransport
 * @typedef {{ readonly bodies: readonly string[], readonly release: Deferred, readonly started: Deferred, readonly transport: LooseTransport }} GatedTransport
 */

const SUPPORTED_EVENT_TYPES = ["release", "environment", "issue", "log", "span", "action"];
const LOGGER_TRACE = {
  parentSpanId: "00f067aa0ba902b7",
  sampled: true,
  spanId: "b7ad6b7169203331",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736"
};
const NEXT = 1;
const STATUS_ACCEPTED = 202;
const STATUS_NO_CONTENT = 204;
const STATUS_UNAVAILABLE = 503;
const SETTLED = "settled";
const BASE_CONFIG = {
  apiKey: "LOGBREW_API_KEY",
  maxRetries: 2,
  sdkName: "logbrew-js",
  sdkVersion: "0.1.0"
};

/**
 * @param {Readonly<Record<PropertyKey, unknown>>} overrides
 * @returns {LogBrewClient}
 */
function sampleClient(overrides = {}) {
  /** @type {unknown} */
  const client = Reflect.apply(LogBrewClient.create.bind(LogBrewClient), undefined, [{ ...BASE_CONFIG, ...overrides }]);
  assert.ok(client instanceof LogBrewClient);
  return client;
}

/**
 * @param {LogBrewClient} client
 * @returns {void}
 */
function enqueueAll(client) {
  client.release("evt_release_001", "2026-06-02T10:00:00Z", { commit: "abc123def456", version: "1.2.3" });
  client.environment("evt_environment_001", "2026-06-02T10:00:01Z", { name: "production", region: "global" });
  client.issue("evt_issue_001", "2026-06-02T10:00:02Z", {
    level: "error",
    message: "Request timed out after retry budget",
    title: "Checkout timeout"
  });
  client.log("evt_log_001", "2026-06-02T10:00:03Z", { level: "info", logger: "job-runner", message: "worker started" });
  client.span("evt_span_001", "2026-06-02T10:00:04Z", {
    durationMs: 12.5,
    name: "GET /health",
    spanId: "span_001",
    status: "ok",
    traceId: "trace_001"
  });
  client.action("evt_action_001", "2026-06-02T10:00:05Z", { name: "deploy", status: "success" });
}

/**
 * @param {string} text
 * @returns {unknown}
 */
function parseJson(text) {
  /** @type {unknown} */
  const parsed = JSON.parse(text);
  return parsed;
}

/**
 * @param {unknown} value
 * @param {string} keyPath
 * @returns {unknown}
 */
function pick(value, keyPath) {
  let current = value;
  for (const key of keyPath.split(".")) {
    current = typeof current === "object" && current !== null ? Reflect.get(current, key) : undefined;
  }
  return current;
}

/**
 * @param {unknown} value
 * @returns {readonly unknown[]}
 */
function list(value) {
  assert.ok(Array.isArray(value), "expected an array");
  /** @type {readonly unknown[]} */
  const items = value;
  return items;
}

/**
 * @param {LogBrewClient} client
 * @returns {readonly unknown[]}
 */
function previewEvents(client) {
  const payload = parseJson(client.previewJson());
  return list(pick(payload, "events"));
}

/**
 * @param {string | null | undefined} body
 * @returns {readonly unknown[]}
 */
function bodyEvents(body) {
  assert.ok(typeof body === "string", "expected a request body");
  return list(pick(parseJson(body), "events"));
}

/**
 * @param {string | null | undefined} body
 * @returns {readonly unknown[]}
 */
function eventIds(body) {
  return bodyEvents(body).map((event) => pick(event, "id"));
}

/**
 * @param {unknown} payload
 * @returns {void}
 */
function assertEventTypes(payload) {
  assert.deepEqual(list(pick(payload, "events")).map((event) => pick(event, "type")), SUPPORTED_EVENT_TYPES);
}

/**
 * @param {string} text
 * @param {readonly string[]} needles
 * @returns {void}
 */
function assertExcludes(text, needles) {
  for (const needle of needles) {
    assert.equal(text.includes(needle), false);
  }
}

/**
 * @param {unknown} health
 * @param {Readonly<Record<string, unknown>>} expected
 * @returns {void}
 */
function assertFields(health, expected) {
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(pick(health, key), value, key);
  }
}

/**
 * @returns {Deferred}
 */
function deferred() {
  const target = new EventTarget();
  /** @type {{ value: unknown }} */
  const state = { value: undefined };
  /** @returns {Promise<unknown>} */
  async function settle() {
    await once(target, SETTLED);
    return state.value;
  }
  const promise = settle();
  return {
    promise,
    resolve(value) {
      state.value = value;
      target.dispatchEvent(new Event(SETTLED));
    }
  };
}

/**
 * @returns {BlockedTransport}
 */
function blockedTransport() {
  const started = deferred();
  const response = deferred();
  return {
    response,
    started,
    transport: {
      async send() {
        started.resolve();
        return response.promise;
      }
    }
  };
}

/**
 * @param {number} firstStatus
 * @returns {GatedTransport}
 */
function gatedFirstSend(firstStatus) {
  const started = deferred();
  const release = deferred();
  /** @type {string[]} */
  const bodies = [];
  return {
    bodies,
    release,
    started,
    transport: {
      async send(_apiKey, body) {
        bodies.push(body);
        if (bodies.length === NEXT) {
          started.resolve();
          await release.promise;
          return { attempts: NEXT, statusCode: firstStatus };
        }
        return { attempts: NEXT, statusCode: STATUS_ACCEPTED };
      }
    }
  };
}

/**
 * @param {LogBrewClient} client
 * @param {LooseTransport} transport
 * @returns {Promise<unknown>}
 */
async function flushWith(client, transport) {
  /** @type {unknown} */
  const pending = Reflect.apply(client.flush.bind(client), undefined, [transport]);
  return pending;
}

export {
  LOGGER_TRACE,
  STATUS_ACCEPTED,
  STATUS_NO_CONTENT,
  STATUS_UNAVAILABLE,
  assertEventTypes,
  assertExcludes,
  assertFields,
  blockedTransport,
  bodyEvents,
  deferred,
  enqueueAll,
  eventIds,
  flushWith,
  gatedFirstSend,
  list,
  parseJson,
  pick,
  previewEvents,
  sampleClient
};
