import {
  ANY_PORT,
  HOST,
  assertExcludes,
  createLatch,
  disconnectAfterFirstChunk,
  eventOfType,
  eventsOf,
  finalErrorHandler,
  readField,
  readPath,
  requestContext,
  serve,
  traceField,
  withinTimeout
} from "./support.js";
import { createNetworkDelivery, createRecordingDelivery } from "./delivery.js";
import { getActiveLogBrewTrace, logbrewErrorHandler, logbrewMiddleware } from "@logbrew/express";
import assert from "node:assert/strict";
import commonjsAdapter from "./commonjs.cjs";
import express from "express";
import { request } from "node:http";
import test from "node:test";

/**
 * @import { TestContext } from "node:test"
 * @import { Express, NextFunction, Request, Response } from "express"
 * @import { LogBrewExpressOptions } from "@logbrew/express"
 * @import { LogBrewClient, Transport } from "@logbrew/sdk"
 * @import { Latch } from "./support.js"
 * @import { Delivery } from "./delivery.js"
 * @typedef {{
 *   readonly aborted?: boolean,
 *   readonly commonjs?: boolean,
 *   readonly continued?: boolean,
 *   readonly failure?: boolean,
 *   readonly manual?: boolean,
 *   readonly metricsOnly?: boolean,
 *   readonly networkDelivery?: boolean
 * }} Scenario
 * @typedef {{
 *   readonly count: () => number,
 *   readonly onCaptureError: (error: unknown) => void,
 *   readonly onFlush: () => void,
 *   readonly wait: () => Promise<void>
 * }} Flushes
 * @typedef {{
 *   readonly abortListeners: readonly unknown[],
 *   readonly client: LogBrewClient,
 *   readonly finishListeners: readonly unknown[],
 *   readonly req: Request,
 *   readonly res: Response
 * }} Observed
 * @typedef {{
 *   readonly next: NextFunction,
 *   readonly onClose: () => void,
 *   readonly req: Request,
 *   readonly res: Response
 * }} StreamCall
 * @typedef {{
 *   readonly handle: (req: Request, res: Response, next: NextFunction) => void,
 *   readonly observed: () => Observed,
 *   readonly rememberListeners: (req: Request, res: Response, next: NextFunction) => void
 * }} StreamRoute
 * @typedef {{ readonly app: Express, readonly closed: Latch, readonly observed: () => Observed }} StreamApp
 * @typedef {{
 *   readonly delivery: Delivery,
 *   readonly flushes: Flushes,
 *   readonly observed: Observed,
 *   readonly onClose: () => void,
 *   readonly scenario: Scenario
 * }} Run
 */

const TRACE_ID = "11111111111111111111111111111111";
const SPAN_ID = "2222222222222222";
const PARENT_SPAN_ID = "4444444444444444";
const TIMESTAMP = "2026-08-29T12:00:00Z";
const SERVER_API_KEY = "test-key";
const STREAM_PATH = "/stream/private-id?search=private-query";
const PRIVATE_MARKERS = Object.freeze(["private-id", "private-query", "private-authorization", "private-cookie"]);
const FLUSH_TIMEOUT_MS = 500;
const NONE = 0;
const ONE = 1;
const METRICS_ONLY_EVENTS = 2;
const COMPLETED_EVENTS = 3;
const FAILED_EVENTS = 4;
const esmAdapter = Object.freeze({ logbrewErrorHandler, logbrewMiddleware });

/**
 * @returns {Flushes}
 */
function createFlushes() {
  const latch = createLatch();
  let flushes = NONE;
  return {
    count: () => flushes,
    onCaptureError: latch.fail,
    onFlush: () => {
      flushes += ONE;
      latch.open();
    },
    wait: latch.wait
  };
}

/**
 * @param {Scenario} scenario
 * @param {Transport} transport
 * @param {Flushes} flushes
 * @returns {LogBrewExpressOptions}
 */
function middlewareOptions(scenario, transport, flushes) {
  const automatic = scenario.manual !== true;
  return {
    captureRequestMetrics: automatic,
    captureRequests: automatic && scenario.metricsOnly !== true,
    now: () => TIMESTAMP,
    onCaptureError: flushes.onCaptureError,
    onFlush: flushes.onFlush,
    serverApiKey: SERVER_API_KEY,
    spanIdFactory: () => SPAN_ID,
    traceIdFactory: () => TRACE_ID,
    transport
  };
}

/**
 * @param {readonly unknown[]} listeners
 * @returns {ReadonlySet<unknown>}
 */
function listenerSet(listeners) {
  return new Set(listeners);
}

/**
 * @param {Request} req
 * @param {Response} res
 * @param {(listener: unknown) => boolean} isOriginal
 * @returns {Observed}
 */
function observeStream(req, res, isOriginal) {
  return {
    abortListeners: req.listeners("aborted"),
    client: requestContext(req).client,
    finishListeners: res.listeners("finish").filter((listener) => !isOriginal(listener)),
    req,
    res
  };
}

/**
 * @param {Scenario} scenario
 * @param {Response} res
 * @returns {void}
 */
function endUnlessAborted(scenario, res) {
  if (scenario.aborted !== true) {
    res.end("last chunk");
  }
}

/**
 * @param {StreamCall} call
 * @returns {void}
 */
function beginStream(call) {
  const { onClose, req, res } = call;
  assert.equal(getActiveLogBrewTrace()?.spanId, SPAN_ID);
  requestContext(req).client.log("stream-log", TIMESTAMP, { level: "info", message: "stream started" });
  res.once("close", onClose);
  req.once("aborted", onClose);
  res.write("first chunk");
  res.flushHeaders();
}

/**
 * @param {Scenario} scenario
 * @param {StreamCall} call
 * @returns {void}
 */
function streamResponse(scenario, call) {
  beginStream(call);
  if (scenario.failure !== true) {
    endUnlessAborted(scenario, call.res);
    return;
  }
  call.next(new TypeError("stream failure"));
}

/**
 * @param {Scenario} scenario
 * @param {() => void} onClose
 * @returns {StreamRoute}
 */
function createStreamRoute(scenario, onClose) {
  /** @type {ReadonlySet<unknown>} */
  let original = new Set();
  /** @type {Observed[]} */
  const observed = [];
  return {
    handle: (req, res, next) => {
      observed.push(observeStream(req, res, (listener) => original.has(listener)));
      streamResponse(scenario, { next, onClose, req, res });
    },
    observed: () => {
      const [first] = observed;
      assert.ok(first !== undefined, "stream route never ran");
      return first;
    },
    rememberListeners: (_req, res, next) => {
      original = listenerSet(res.listeners("finish"));
      next();
    }
  };
}

/**
 * @param {unknown} error
 * @param {Response} res
 * @returns {void}
 */
function destroyAfterStreamFailure(error, res) {
  assert.equal(readField(error, "message"), "stream failure");
  res.destroy();
}

/**
 * @param {Scenario} scenario
 * @param {Transport} transport
 * @param {Flushes} flushes
 * @returns {StreamApp}
 */
function createStreamApp(scenario, transport, flushes) {
  const adapter = scenario.commonjs === true ? commonjsAdapter : esmAdapter;
  const closed = createLatch();
  const route = createStreamRoute(scenario, closed.open);
  const app = express();
  app.use(route.rememberListeners);
  app.use(adapter.logbrewMiddleware(middlewareOptions(scenario, transport, flushes)));
  app.get("/stream/:id", route.handle);
  app.use(adapter.logbrewErrorHandler());
  app.use(finalErrorHandler(destroyAfterStreamFailure));
  return { app, closed, observed: route.observed };
}

/**
 * @param {boolean} continued
 * @returns {string}
 */
function rawStreamRequest(continued) {
  const propagation = continued ? `traceparent: 00-${TRACE_ID}-${PARENT_SPAN_ID}-00\r\n` : "";
  return `GET ${STREAM_PATH} HTTP/1.1\r\nHost: localhost\r\nAuthorization: private-authorization\r\nCookie: private-cookie\r\n${propagation}\r\n`;
}

/**
 * @param {number} port
 * @param {boolean} failure
 * @returns {Promise<void>}
 */
async function readStream(port, failure) {
  const finished = createLatch();
  /**
   * @param {unknown} error
   * @returns {void}
   */
  function settle(error) {
    if (failure) {
      finished.open();
    } else {
      finished.fail(error);
    }
  }
  const headers = { authorization: "private-authorization", cookie: "private-cookie" };
  const outgoing = request({ headers, host: HOST, path: STREAM_PATH, port }, (incoming) => {
    incoming.on("error", settle);
    incoming.on("end", finished.open);
    incoming.resume();
  });
  outgoing.on("error", settle);
  outgoing.end();
  await finished.wait();
}

/**
 * @param {number} port
 * @param {Scenario} scenario
 * @returns {Promise<void>}
 */
async function sendStreamRequest(port, scenario) {
  await (scenario.aborted === true
    ? disconnectAfterFirstChunk(port, rawStreamRequest(scenario.continued === true))
    : readStream(port, scenario.failure === true));
}

/**
 * @param {Run} run
 * @returns {Promise<void>}
 */
async function settleDelivery(run) {
  if (run.scenario.manual === true) {
    assert.equal(run.flushes.count(), NONE);
    assert.equal(run.observed.client.pendingEvents(), ONE);
    await run.observed.client.shutdown(run.delivery.transport);
  } else {
    await withinTimeout(run.flushes.wait, FLUSH_TIMEOUT_MS, "closed response never flushed");
  }
}

/**
 * @param {Run} run
 * @returns {void}
 */
function assertReleased(run) {
  const { observed, scenario } = run;
  const finish = listenerSet(observed.res.listeners("finish"));
  const aborted = listenerSet(observed.req.listeners("aborted"));
  assert.equal(run.flushes.count(), scenario.manual === true ? NONE : ONE);
  assert.equal(observed.client.pendingEvents(), NONE);
  assert.ok(observed.finishListeners.every((listener) => !finish.has(listener)));
  assert.ok(observed.abortListeners.every((listener) => !aborted.has(listener)));
  assert.ok(observed.res.listeners("close").every((listener) => listener === run.onClose));
  assert.equal(getActiveLogBrewTrace(), undefined);
}

/**
 * @param {Scenario} scenario
 * @returns {number}
 */
function expectedEventCount(scenario) {
  if (scenario.manual === true) {
    return ONE;
  }
  if (scenario.metricsOnly === true) {
    return METRICS_ONLY_EVENTS;
  }
  return scenario.failure === true ? FAILED_EVENTS : COMPLETED_EVENTS;
}

/**
 * @param {readonly unknown[]} events
 * @param {Scenario} scenario
 * @returns {void}
 */
function assertLog(events, scenario) {
  const log = events.find((event) => readField(event, "id") === "stream-log");
  assert.equal(traceField(log, "traceId"), TRACE_ID);
  assert.equal(traceField(log, "spanId"), SPAN_ID);
  assert.equal(traceField(log, "sampled"), scenario.continued !== true);
}

/**
 * @param {unknown} span
 * @param {Scenario} scenario
 * @returns {void}
 */
function assertSpan(span, scenario) {
  if (scenario.metricsOnly === true || scenario.manual === true) {
    return;
  }
  const failed = scenario.aborted === true || scenario.failure === true;
  assert.equal(readPath(span, ["attributes", "name"]), "GET /stream/:id");
  assert.equal(readPath(span, ["attributes", "traceId"]), TRACE_ID);
  assert.equal(readPath(span, ["attributes", "spanId"]), SPAN_ID);
  assert.equal(readPath(span, ["attributes", "parentSpanId"]), scenario.continued === true ? PARENT_SPAN_ID : undefined);
  assert.equal(readPath(span, ["attributes", "status"]), failed ? "error" : "ok");
  assert.equal(readPath(span, ["attributes", "metadata", "responseCompleted"]), failed ? false : undefined);
}

/**
 * @param {unknown} metric
 * @param {Scenario} scenario
 * @returns {void}
 */
function assertMetric(metric, scenario) {
  if (scenario.manual === true) {
    return;
  }
  const failed = scenario.aborted === true || scenario.failure === true;
  assert.equal(readPath(metric, ["attributes", "metadata", "routeTemplate"]), "/stream/:id");
  assert.equal(traceField(metric, "spanId"), SPAN_ID);
  assert.equal(traceField(metric, "sampled"), scenario.continued !== true);
  assert.equal(readPath(metric, ["attributes", "metadata", "responseCompleted"]), failed ? false : undefined);
}

/**
 * @param {Run} run
 * @returns {string}
 */
function deliveredBody(run) {
  const body = run.delivery.body();
  assert.ok(body !== undefined, "no batch was delivered");
  if (run.scenario.networkDelivery === true) {
    assert.equal(run.delivery.count(), ONE);
  }
  assertExcludes(body, PRIVATE_MARKERS);
  return body;
}

/**
 * @param {Run} run
 * @returns {void}
 */
function assertEvents(run) {
  const { scenario } = run;
  const events = eventsOf(deliveredBody(run));
  assert.equal(events.length, expectedEventCount(scenario));
  assertLog(events, scenario);
  assertSpan(eventOfType(events, "span"), scenario);
  assertMetric(eventOfType(events, "metric"), scenario);
  if (scenario.failure === true) {
    assert.equal(traceField(eventOfType(events, "issue"), "spanId"), SPAN_ID);
  }
}

/**
 * @param {TestContext} testContext
 * @param {Scenario} [scenario]
 * @returns {Promise<void>}
 */
async function runRequest(testContext, scenario = {}) {
  const delivery = scenario.networkDelivery === true
    ? await createNetworkDelivery(testContext, SERVER_API_KEY)
    : createRecordingDelivery();
  const flushes = createFlushes();
  const stream = createStreamApp(scenario, delivery.transport, flushes);
  const server = await serve(testContext, () => stream.app.listen(ANY_PORT, HOST));
  await sendStreamRequest(server.port, scenario);
  await stream.closed.wait();
  const run = { delivery, flushes, observed: stream.observed(), onClose: stream.closed.open, scenario };
  await settleDelivery(run);
  assertReleased(run);
  assertEvents(run);
}

/** @type {ReadonlyArray<readonly [string, Scenario]>} */
const SCENARIOS = [
  ["client disconnect flushes streamed request telemetry", { aborted: true }],
  ["completed streams flush once and release lifecycle listeners", {}],
  ["late streaming errors flush their issue and failed request once", { failure: true }],
  ["metrics-only disconnected requests flush without a request span", { aborted: true, metricsOnly: true }],
  ["CommonJS consumers flush disconnected streams", { aborted: true, commonjs: true }],
  ["disconnected streams deliver one correlated batch over HTTP", { aborted: true, continued: true, networkDelivery: true }],
  ["disabled automatic capture preserves manual delivery", { aborted: true, manual: true }]
];

for (const [name, scenario] of SCENARIOS) {
  void test(name, async (testContext) => {
    await runRequest(testContext, scenario);
  });
}
