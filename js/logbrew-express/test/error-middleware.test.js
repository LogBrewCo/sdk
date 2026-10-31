import {
  ANY_PORT,
  HOST,
  SERVER_ERROR,
  assertExcludes,
  assertSameMembers,
  createFlushLatch,
  createLatch,
  createRecorder,
  eventOfType,
  eventType,
  eventsOf,
  eventsOfType,
  expectedTraceIds,
  finalErrorHandler,
  readPath,
  serve,
  traceField,
  traceparentFor
} from "./support.js";
import { createErrorEvent, getActiveLogBrewTrace, logbrewErrorHandler, logbrewMiddleware } from "@logbrew/express";
import assert from "node:assert/strict";
import express from "express";
import test from "node:test";

/**
 * @import { TestContext } from "node:test"
 * @import { Express, NextFunction, Request, Response } from "express"
 * @import { LogBrewExpressErrorHandlerOptions } from "@logbrew/express"
 * @import { LogBrewTraceContext } from "@logbrew/node"
 * @import { LogBrewClient } from "@logbrew/sdk"
 * @import { FlushLatch, Recorder } from "./support.js"
 * @typedef {{
 *   readonly aborted?: boolean,
 *   readonly concurrency?: number,
 *   readonly failFactory?: boolean,
 *   readonly failObserver?: boolean
 * }} Scenario
 * @typedef {{ readonly factory: unknown, readonly original: unknown }} Failures
 * @typedef {{
 *   readonly active: LogBrewTraceContext | undefined,
 *   readonly error: unknown,
 *   readonly trace: Readonly<LogBrewTraceContext> | undefined
 * }} CaptureFailure
 * @typedef {{
 *   readonly captureFailures: readonly CaptureFailure[],
 *   readonly clients: readonly LogBrewClient[],
 *   readonly factoryTraces: readonly (LogBrewTraceContext | undefined)[],
 *   readonly options: LogBrewExpressErrorHandlerOptions
 * }} ErrorHooks
 * @typedef {{
 *   readonly forwarded: readonly unknown[],
 *   readonly handle: (error: unknown, res: Response) => void,
 *   readonly responseTraces: readonly (LogBrewTraceContext | undefined)[]
 * }} FinalRecorder
 * @typedef {{
 *   readonly handle: (req: Request, res: Response, next: NextFunction) => void,
 *   readonly ready: () => Promise<void>,
 *   readonly release: () => void
 * }} DeferredRoute
 * @typedef {{
 *   readonly count: number,
 *   readonly failures: Failures,
 *   readonly final: FinalRecorder,
 *   readonly flushes: FlushLatch,
 *   readonly hooks: ErrorHooks,
 *   readonly recorder: Recorder,
 *   readonly route: DeferredRoute,
 *   readonly scenario: Scenario
 * }} FailureView
 */

const SPAN_ID = "2222222222222222";
const TIMESTAMP = "2026-08-29T12:00:00Z";
const SERVER_API_KEY = "LOGBREW_SERVER_API_KEY";
const SAMPLED = "01";
const PRIVATE_MARKERS = Object.freeze(["private-id", "private-query", "private-authorization"]);
const ONE = 1;
const NONE = 0;
const FACTORY_FAILURE_EVENTS = 3;
const CAPTURED_EVENTS = 4;
const CONCURRENT_REQUESTS = 3;

/**
 * @param {Scenario} scenario
 * @param {Failures} failures
 * @returns {ErrorHooks}
 */
function createErrorHooks(scenario, failures) {
  /** @type {CaptureFailure[]} */
  const captureFailures = [];
  /** @type {LogBrewClient[]} */
  const clients = [];
  /** @type {(LogBrewTraceContext | undefined)[]} */
  const factoryTraces = [];
  return {
    captureFailures,
    clients,
    factoryTraces,
    options: {
      errorEvent: (error, { client, req, trace }) => {
        clients.push(client);
        factoryTraces.push(getActiveLogBrewTrace());
        client.log(`factory-log-${String(factoryTraces.length)}`, TIMESTAMP, { level: "info", message: "error factory called" });
        if (scenario.failFactory === true) {
          throw failures.factory;
        }
        return createErrorEvent(error, req, { now: () => TIMESTAMP, trace });
      },
      onCaptureError: (error, { trace }) => {
        captureFailures.push({ active: getActiveLogBrewTrace(), error, trace });
        if (scenario.failObserver === true) {
          throw new Error("observer failure");
        }
      }
    }
  };
}

/**
 * @param {boolean} aborted
 * @returns {FinalRecorder}
 */
function createFinalRecorder(aborted) {
  /** @type {unknown[]} */
  const forwarded = [];
  /** @type {(LogBrewTraceContext | undefined)[]} */
  const responseTraces = [];
  return {
    forwarded,
    handle: (error, res) => {
      forwarded.push(error);
      responseTraces.push(getActiveLogBrewTrace());
      if (aborted) {
        res.destroy();
      } else {
        res.status(SERVER_ERROR).end("failed");
      }
    },
    responseTraces
  };
}

/**
 * @param {number} count
 * @param {unknown} error
 * @returns {DeferredRoute}
 */
function createDeferredRoute(count, error) {
  /** @type {(() => void)[]} */
  const pending = [];
  const ready = createLatch();
  return {
    handle: (_req, _res, next) => {
      pending.push(() => {
        next(error);
      });
      if (pending.length === count) {
        ready.open();
      }
    },
    ready: ready.wait,
    release: () => {
      for (const resume of pending) {
        resume();
      }
    }
  };
}

/**
 * @param {Scenario} scenario
 * @returns {{ readonly app: Express, readonly view: FailureView }}
 */
function createFailureRun(scenario) {
  const count = scenario.concurrency ?? ONE;
  const failures = { factory: new RangeError("event factory failure"), original: new TypeError("application failure") };
  const view = {
    count,
    failures,
    final: createFinalRecorder(scenario.aborted === true),
    flushes: createFlushLatch(count),
    hooks: createErrorHooks(scenario, failures),
    recorder: createRecorder(),
    route: createDeferredRoute(count, failures.original),
    scenario
  };
  const app = express();
  app.use(logbrewMiddleware({
    captureRequestMetrics: true,
    onFlush: view.flushes.onFlush,
    serverApiKey: SERVER_API_KEY,
    spanIdFactory: () => SPAN_ID,
    transport: view.recorder.transport
  }));
  app.get("/fail/:id", view.route.handle);
  app.use(logbrewErrorHandler(view.hooks.options));
  app.use(finalErrorHandler(view.final.handle));
  return { app, view };
}

/**
 * @param {string} origin
 * @param {number} index
 * @param {boolean} aborted
 * @returns {Promise<void>}
 */
async function sendFailure(origin, index, aborted) {
  try {
    const response = await fetch(`${origin}/fail/private-id?search=private-query`, {
      headers: { authorization: "private-authorization", traceparent: traceparentFor(index, SAMPLED) }
    });
    assert.equal(response.status, SERVER_ERROR);
    assert.equal(await response.text(), "failed");
  } catch (error) {
    if (!aborted) {
      throw error;
    }
  }
}

/**
 * @param {FailureView} view
 * @returns {void}
 */
function assertForwarded(view) {
  for (const client of view.hooks.clients) {
    assert.equal(client.deliveryHealth().lifecycle, "closed");
  }
  assert.equal(view.final.forwarded.length, view.count);
  for (const error of view.final.forwarded) {
    assert.equal(error, view.failures.original);
  }
  assert.equal(view.hooks.captureFailures.length, view.scenario.failFactory === true ? view.count : NONE);
  for (const failure of view.hooks.captureFailures) {
    assert.equal(failure.error, view.failures.factory);
    assert.deepEqual(failure.active, failure.trace);
  }
}

/**
 * @param {FailureView} view
 * @returns {void}
 */
function assertTraces(view) {
  const expected = expectedTraceIds(view.count);
  assertSameMembers(view.hooks.factoryTraces.map((trace) => trace?.traceId), expected);
  assertSameMembers(view.final.responseTraces.map((trace) => trace?.traceId), expected);
}

/**
 * @param {string} body
 * @param {boolean} failFactory
 * @returns {void}
 */
function assertFailureBatch(body, failFactory) {
  const events = eventsOf(body);
  const span = eventOfType(events, "span");
  assert.equal(events.length, failFactory ? FACTORY_FAILURE_EVENTS : CAPTURED_EVENTS);
  assert.equal(readPath(span, ["attributes", "status"]), "error");
  assert.equal(readPath(span, ["attributes", "name"]), "GET /fail/:id");
  for (const event of events.filter((candidate) => eventType(candidate) !== "span")) {
    assert.equal(traceField(event, "traceId"), readPath(span, ["attributes", "traceId"]));
    assert.equal(traceField(event, "spanId"), SPAN_ID);
  }
  assert.equal(eventsOfType(events, "issue").length, failFactory ? NONE : ONE);
  assertExcludes(JSON.stringify(events), PRIVATE_MARKERS);
}

/**
 * @param {FailureView} view
 * @returns {void}
 */
function assertFailureRun(view) {
  assertForwarded(view);
  assertTraces(view);
  assert.equal(view.recorder.bodies.length, view.count);
  for (const body of view.recorder.bodies) {
    assertFailureBatch(body, view.scenario.failFactory === true);
  }
}

/**
 * @param {TestContext} testContext
 * @param {Scenario} [scenario]
 * @returns {Promise<void>}
 */
async function checkErrorMiddleware(testContext, scenario = {}) {
  const { app, view } = createFailureRun(scenario);
  const server = await serve(testContext, () => app.listen(ANY_PORT, HOST));
  const responses = Array.from({ length: view.count }, async (_value, index) => sendFailure(server.origin, index, scenario.aborted === true));
  await view.route.ready();
  assert.equal(getActiveLogBrewTrace(), undefined);
  view.route.release();
  assert.equal(getActiveLogBrewTrace(), undefined);
  await Promise.all(responses);
  await view.flushes.wait();
  assertFailureRun(view);
}

/** @type {ReadonlyArray<readonly [string, Scenario]>} */
const SCENARIOS = [
  ["error factory failure preserves the original Express error", { failFactory: true }],
  ["out-of-band errors restore request trace through factory and response middleware", {}],
  ["concurrent out-of-band errors keep independent traces", { concurrency: CONCURRENT_REQUESTS }],
  ["aborted error responses preserve capture and the original application error", { aborted: true, failFactory: true }],
  ["a rejecting capture observer cannot replace the application error", { failFactory: true, failObserver: true }]
];

for (const [name, scenario] of SCENARIOS) {
  void test(name, async (testContext) => {
    await checkErrorMiddleware(testContext, scenario);
  });
}
