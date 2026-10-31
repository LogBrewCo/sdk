import {
  ANY_PORT,
  HOST,
  SERVER_ERROR,
  createLatch,
  createRecorder,
  eventOfType,
  eventsOfBodies,
  eventsOfType,
  finalErrorHandler,
  readField,
  readPath,
  serve,
  transportResponse,
  withinTimeout
} from "./support.js";
import { createLogBrewExpressClient, logbrewErrorHandler, logbrewMiddleware } from "@logbrew/express";
import assert from "node:assert/strict";
import express from "express";
import test from "node:test";

/**
 * @import { TestContext } from "node:test"
 * @import { Express, NextFunction, Request, Response } from "express"
 * @import { LogBrewExpressErrorHandlerOptions } from "@logbrew/express"
 * @import { LogBrewClient } from "@logbrew/sdk"
 * @import { Latch, Recorder } from "./support.js"
 * @typedef {{ readonly forwarded: readonly unknown[], readonly handle: (error: unknown, res: Response) => void }} Forwarding
 * @typedef {{
 *   readonly app: Express,
 *   readonly captures: readonly unknown[],
 *   readonly client: LogBrewClient,
 *   readonly forwarded: readonly unknown[],
 *   readonly original: unknown,
 *   readonly reported: Latch
 * }} RejectedDeliveryRun
 * @typedef {{
 *   readonly app: Express,
 *   readonly captures: readonly unknown[],
 *   readonly client: LogBrewClient,
 *   readonly factory: unknown,
 *   readonly flushed: Latch,
 *   readonly forwarded: readonly unknown[],
 *   readonly original: unknown,
 *   readonly recorder: Recorder
 * }} FactoryFailureRun
 * @typedef {{
 *   readonly app: Express,
 *   readonly flushed: Latch,
 *   readonly forwarded: readonly unknown[],
 *   readonly recorder: Recorder
 * }} ClientErrorRun
 */

const SERVER_API_KEY = "LOGBREW_SERVER_API_KEY";
const TIMESTAMP = "2026-08-29T12:00:00Z";
const BAD_REQUEST = 400;
const NOT_FOUND = 404;
const FLUSH_TIMEOUT_MS = 500;
const NONE = 0;
const ONE = 1;

/**
 * @param {(error: unknown) => number} responseStatus
 * @param {string} body
 * @returns {Forwarding}
 */
function createForwarding(responseStatus, body) {
  /** @type {unknown[]} */
  const forwarded = [];
  return {
    forwarded,
    handle: (error, res) => {
      forwarded.push(error);
      res.status(responseStatus(error)).end(body);
    }
  };
}

/**
 * @param {readonly unknown[]} values
 * @param {unknown} expected
 * @returns {void}
 */
function assertOnly(values, expected) {
  const [first] = values;
  assert.equal(values.length, ONE);
  assert.equal(first, expected);
}

/**
 * @param {string} url
 * @returns {Promise<number>}
 */
async function fetchStatus(url) {
  const response = await fetch(url);
  await response.text();
  return response.status;
}

/**
 * @param {unknown} error
 * @returns {(req: Request, res: Response, next: NextFunction) => void}
 */
function forwardError(error) {
  return (_req, _res, next) => {
    next(error);
  };
}

/**
 * @param {LogBrewExpressErrorHandlerOptions} options
 * @param {unknown} error
 * @param {Forwarding} forwarding
 * @returns {Express}
 */
function createStandaloneApp(options, error, forwarding) {
  const app = express();
  app.get("/fail", forwardError(error));
  app.use(logbrewErrorHandler(options));
  app.use(finalErrorHandler(forwarding.handle));
  return app;
}

/**
 * @returns {RejectedDeliveryRun}
 */
function createRejectedDeliveryRun() {
  const client = createLogBrewExpressClient({ serverApiKey: SERVER_API_KEY });
  const original = new TypeError("application failure");
  const reported = createLatch();
  /** @type {unknown[]} */
  const captures = [];
  const forwarding = createForwarding(() => SERVER_ERROR, "failed");
  const app = createStandaloneApp({
    client,
    onCaptureError: async (error) => {
      captures.push(error);
      reported.open();
      throw new Error("observer failure");
    },
    transport: { send: async () => transportResponse(BAD_REQUEST) }
  }, original, forwarding);
  return { app, captures, client, forwarded: forwarding.forwarded, original, reported };
}

/**
 * @returns {FactoryFailureRun}
 */
function createFactoryFailureRun() {
  const client = createLogBrewExpressClient({ serverApiKey: SERVER_API_KEY });
  const failures = { factory: new RangeError("factory failure"), original: new TypeError("application failure") };
  /** @type {unknown[]} */
  const captures = [];
  const flushed = createLatch();
  const recorder = createRecorder();
  const forwarding = createForwarding(() => SERVER_ERROR, "failed");
  const app = createStandaloneApp({
    client,
    errorEvent: () => {
      client.log("factory-log", TIMESTAMP, { level: "info", message: "factory called" });
      throw failures.factory;
    },
    onCaptureError: (error) => {
      captures.push(error);
    },
    onFlush: flushed.open,
    transport: recorder.transport
  }, failures.original, forwarding);
  return { app, captures, client, factory: failures.factory, flushed, forwarded: forwarding.forwarded, original: failures.original, recorder };
}

/**
 * @param {unknown} error
 * @returns {number}
 */
function statusOf(error) {
  const status = readField(error, "status");
  return typeof status === "number" ? status : SERVER_ERROR;
}

/**
 * @param {Request} _req
 * @param {Response} _res
 * @param {NextFunction} next
 * @returns {void}
 */
function forwardNotFound(_req, _res, next) {
  next(Object.assign(new Error("Not Found"), { status: NOT_FOUND }));
}

/**
 * @param {boolean} captureClientErrors
 * @returns {ClientErrorRun}
 */
function createClientErrorRun(captureClientErrors) {
  const recorder = createRecorder();
  const flushed = createLatch();
  const forwarding = createForwarding(statusOf, "missing");
  const options = {
    onFlush: flushed.open,
    serverApiKey: SERVER_API_KEY,
    transport: recorder.transport,
    ...(captureClientErrors ? { captureClientErrors: true } : {})
  };
  const app = express();
  app.use(logbrewMiddleware(options));
  app.use(forwardNotFound);
  app.use(logbrewErrorHandler(options));
  app.use(finalErrorHandler(forwarding.handle));
  return { app, flushed, forwarded: forwarding.forwarded, recorder };
}

/**
 * @param {TestContext} testContext
 * @param {boolean} captureClientErrors
 * @returns {Promise<readonly unknown[]>}
 */
async function sendClientError(testContext, captureClientErrors) {
  const run = createClientErrorRun(captureClientErrors);
  const server = await serve(testContext, () => run.app.listen(ANY_PORT, HOST));
  const response = await fetch(`${server.origin}/no-such-page`);
  assert.equal(response.status, NOT_FOUND);
  await run.flushed.wait();
  const [forwarded] = run.forwarded;
  assert.equal(run.forwarded.length, ONE);
  assert.equal(readField(forwarded, "status"), NOT_FOUND);
  return eventsOfBodies(run.recorder.bodies);
}

void test("standalone error middleware retains rejected delivery despite a rejecting observer", async (testContext) => {
  const run = createRejectedDeliveryRun();
  const server = await serve(testContext, () => run.app.listen(ANY_PORT, HOST));
  assert.equal(await fetchStatus(`${server.origin}/fail`), SERVER_ERROR);
  await run.reported.wait();
  const [capture] = run.captures;
  assertOnly(run.forwarded, run.original);
  assert.notEqual(capture, undefined);
  assert.equal(run.client.pendingEvents(), ONE);
  assert.equal(run.client.deliveryHealth().lifecycle, "active");
});

void test("standalone factory failure delivers its earlier safe log", async (testContext) => {
  const run = createFactoryFailureRun();
  const server = await serve(testContext, () => run.app.listen(ANY_PORT, HOST));
  const status = await fetchStatus(`${server.origin}/fail`);
  await withinTimeout(run.flushed.wait, FLUSH_TIMEOUT_MS, "factory log never flushed");
  assert.equal(status, SERVER_ERROR);
  assertOnly(run.forwarded, run.original);
  assert.deepEqual(run.captures, [run.factory]);
  assert.deepEqual(eventsOfBodies(run.recorder.bodies).map((event) => readField(event, "id")), ["factory-log"]);
  assert.equal(run.client.pendingEvents(), NONE);
  assert.equal(run.client.deliveryHealth().lifecycle, "closed");
});

void test("errors with a 4xx status stay request spans, not issues", async (testContext) => {
  const events = await sendClientError(testContext, false);
  const span = eventOfType(events, "span");
  assert.equal(eventsOfType(events, "issue").length, NONE);
  assert.equal(readPath(span, ["attributes", "status"]), "ok");
  assert.equal(readPath(span, ["attributes", "metadata", "statusCode"]), NOT_FOUND);
});

void test("captureClientErrors reports errors with a 4xx status as issues", async (testContext) => {
  const events = await sendClientError(testContext, true);
  assert.equal(eventsOfType(events, "issue").length, ONE);
});
