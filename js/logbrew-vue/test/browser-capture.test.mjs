import assert from "node:assert/strict";
import commonjsAdapter from "./commonjs.cjs";
import { createApp } from "vue";
import { createLogBrewVuePlugin } from "@logbrew/vue";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";

/**
 * @import { App, ComponentPublicInstance } from "vue"
 * @typedef {{ readonly createLogBrewVuePlugin: typeof createLogBrewVuePlugin, readonly format: string }} Adapter
 * @typedef {(error: unknown, instance: ComponentPublicInstance | null, info: string) => unknown} Handler
 * @typedef {{ readonly headers: unknown, readonly url: string }} AppRequest
 * @typedef {{ readonly appRequests: readonly AppRequest[], readonly bodies: readonly string[] }} Capture
 */

const DEFAULT_ENDPOINT = "https://api.logbrew.co/v1/events";
const API_URL = "https://api.example.test/cart";
const WAIT_MS = 1000;
const NO_DELAY = 0;
const NONE = 0;
const FIRST = 0;
const ONE = 1;
const TWO = 2;

/** @type {(readonly unknown[])[]} */
const windowCalls = [];

/** @type {readonly Adapter[]} */
const adapters = [
  { createLogBrewVuePlugin, format: "esm" },
  { createLogBrewVuePlugin: commonjsAdapter.createLogBrewVuePlugin, format: "cjs" }
];

/**
 * @param {readonly unknown[]} args
 * @returns {number}
 */
function recordCall(...args) {
  return windowCalls.push(args);
}

/**
 * @param {unknown} value
 * @param {readonly string[]} path
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
 * @param {readonly string[]} bodies
 * @param {string} type
 * @returns {unknown[]}
 */
function deliveredEvents(bodies, type) {
  return bodies.flatMap((body) => {
    /** @type {unknown} */
    const events = readPath(JSON.parse(body), ["events"]);
    /** @type {unknown[]} */
    const list = Array.isArray(events) ? events : [];
    return list.filter((event) => readPath(event, ["type"]) === type);
  });
}

/**
 * @param {() => boolean} predicate
 * @param {number} [deadline]
 * @returns {Promise<void>}
 */
async function waitFor(predicate, deadline = Date.now() + WAIT_MS) {
  if (predicate()) {
    return;
  }
  if (Date.now() >= deadline) {
    throw new Error("delivery was not observed");
  }
  await sleep(NO_DELAY);
  await waitFor(predicate, deadline);
}

/**
 * @param {unknown} value
 * @returns {value is Window}
 */
function isWindow(value) {
  return typeof value === "object" && value !== null && "addEventListener" in value;
}

/**
 * @param {(request: AppRequest) => number} recordRequest
 * @returns {Window}
 */
function createBrowserWindow(recordRequest) {
  const browserWindow = {
    addEventListener: recordCall,
    console: { debug: recordCall, error: recordCall, info: recordCall, log: recordCall, warn: recordCall },
    /**
     * @param {RequestInfo | URL} input
     * @param {RequestInit} [init]
     * @returns {Promise<Response>}
     */
    async fetch(input, init) {
      recordRequest({ headers: init?.headers, url: new Request(input).url });
      return new Response("{}", { status: 200 });
    },
    history: { pushState: recordCall, replaceState: recordCall },
    location: new URL("https://shop.example.test/checkout"),
    navigator: { userAgent: "test" },
    removeEventListener: recordCall
  };
  if (!isWindow(browserWindow)) {
    throw new TypeError("expected a browser window double");
  }
  return browserWindow;
}

/**
 * @param {(body: string) => number} recordBody
 * @returns {typeof fetch}
 */
function deliveryFetch(recordBody) {
  return async (input, init) => {
    assert.equal(new Request(input).url, DEFAULT_ENDPOINT);
    const body = init?.body;
    assert.ok(typeof body === "string", "delivery sends a JSON body");
    recordBody(body);
    return new Response("{}", { status: 202 });
  };
}

/**
 * @param {App} app
 * @returns {Handler}
 */
function installedHandler(app) {
  /** @type {Handler | undefined} */
  const handler = app.config.errorHandler;
  if (handler === undefined) {
    throw new Error("expected an installed Vue error handler");
  }
  return handler;
}

/**
 * @param {Handler} handler
 * @param {readonly string[]} bodies
 * @returns {Promise<void>}
 */
async function failTwice(handler, bodies) {
  handler(new Error("payment declined"), null, "native event handler");
  await waitFor(() => deliveredEvents(bodies, "issue").length === ONE);
  handler(new Error("payment declined"), null, "native event handler");
  await waitFor(() => deliveredEvents(bodies, "issue").length === TWO);
}

/**
 * @param {Adapter} adapter
 * @returns {Promise<Capture>}
 */
async function captureTwoErrors(adapter) {
  /** @type {AppRequest[]} */
  const appRequests = [];
  /** @type {string[]} */
  const bodies = [];
  const browserWindow = createBrowserWindow((request) => appRequests.push(request));
  const app = createApp({});
  app.use(adapter.createLogBrewVuePlugin({
    browserWindow,
    clientKey: "LOGBREW_CLIENT_KEY",
    fetchImpl: deliveryFetch((body) => bodies.push(body)),
    tracePropagationTargets: ["https://api.example.test/"]
  }));
  await browserWindow.fetch(API_URL);
  await failTwice(installedHandler(app), bodies);
  return { appRequests, bodies };
}

/**
 * @param {unknown} issue
 * @returns {void}
 */
function assertIssueContext(issue) {
  const stackFrames = readPath(issue, ["attributes", "stackFrames"]);
  assert.ok(Array.isArray(stackFrames) && stackFrames.length > NONE, "issue carries stack frames");
  const breadcrumbs = readPath(issue, ["attributes", "breadcrumbs"]);
  assert.ok(
    Array.isArray(breadcrumbs) && breadcrumbs.some((crumb) => readPath(crumb, ["category"]) === "fetch"),
    "issue carries the fetch breadcrumb"
  );
}

/**
 * @param {Capture} capture
 * @param {unknown} issue
 * @returns {void}
 */
function assertRequestSpan(capture, issue) {
  const fetchSpan = deliveredEvents(capture.bodies, "span").find((span) => readPath(span, ["attributes", "name"]) === "browser.fetch GET /cart");
  assert.notEqual(fetchSpan, undefined, "app request becomes a span");
  const traceId = readPath(fetchSpan, ["attributes", "traceId"]);
  assert.equal(readPath(issue, ["attributes", "context", "trace", "traceId"]), traceId, "issue and span share the page trace");
  const [first, second] = deliveredEvents(capture.bodies, "issue");
  assert.notEqual(readPath(first, ["id"]), readPath(second, ["id"]), "2 identical errors keep different event IDs");
  const sessionId = readPath(first, ["attributes", "context", "session", "id"]);
  assert.match(String(sessionId), /^[0-9a-f]{32}$/u);
  assert.equal(readPath(fetchSpan, ["attributes", "context", "session", "id"]), sessionId, "every event shares the session");
  assert.match(String(readPath(capture.appRequests[FIRST], ["headers", "traceparent"])), new RegExp(`^00-${String(traceId)}-`, "u"));
}

for (const adapter of adapters) {
  void test(`Vue plugin delivers issues with stack frames, breadcrumbs, and request spans by default in ${adapter.format}`, async () => {
    const capture = await captureTwoErrors(adapter);
    const [issue] = deliveredEvents(capture.bodies, "issue");
    assertIssueContext(issue);
    assertRequestSpan(capture, issue);
    assert.equal(readPath(issue, ["attributes", "metadata", "info"]), "native event handler");
  });
}
