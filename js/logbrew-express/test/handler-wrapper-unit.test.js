import {
  ANY_PORT,
  HOST,
  createCounter,
  createLatch,
  createRecorder,
  createThenable,
  eventType,
  eventsOfBodies,
  finalErrorHandler,
  readField,
  readPath,
  requestContext,
  serve,
  throwValue,
  traceField,
  waitFor
} from "./support.js";
import { logbrewErrorHandler, logbrewMiddleware, withLogBrewExpressHandler } from "@logbrew/express";
import assert from "node:assert/strict";
import express from "express";
import test from "node:test";

/**
 * @import { Express, NextFunction, Request, Response } from "express"
 * @import { LogBrewClient } from "@logbrew/sdk"
 * @import { Counter, Latch, Recorder } from "./support.js"
 * @typedef {{ readonly value: string }} Receiver
 * @typedef {{
 *   readonly clients: readonly LogBrewClient[],
 *   readonly errors: readonly unknown[],
 *   readonly failure: unknown,
 *   readonly first: Latch,
 *   readonly firstEnded: Counter,
 *   readonly recorder: Recorder,
 *   readonly second: Latch,
 *   readonly secondEnded: Counter
 * }} Overlap
 */

const TIMESTAMP = "2026-08-29T12:00:00Z";
const SERVER_API_KEY = "LOGBREW_SERVER_API_KEY";
const ANSWER = 42;
const NONE = 0;
const ONE = 1;
const TWO = 2;
const RECEIVER = Object.freeze({ value: "result" });
const RESULT = Object.freeze({});

/**
 * @returns {never}
 */
function unexpectedNext() {
  assert.fail("the wrapper called next");
}

/**
 * @this {unknown}
 * @returns {boolean}
 */
function receiverIsUndefined() {
  return this === undefined;
}

/**
 * @this {Receiver}
 * @returns {Readonly<Record<string, never>>}
 */
function returnResult() {
  assert.equal(this, RECEIVER);
  return RESULT;
}

void test("the wrapper preserves synchronous receiver, return and throw behavior", () => {
  const failure = new TypeError("handler failure");
  assert.equal(typeof withLogBrewExpressHandler, "function");
  assert.equal(withLogBrewExpressHandler(receiverIsUndefined)(express.request, express.response, unexpectedNext), true);
  assert.equal(withLogBrewExpressHandler(returnResult).call(RECEIVER, express.request, express.response, unexpectedNext), RESULT);
  assert.throws(() => withLogBrewExpressHandler(() => throwValue(failure))(express.request, express.response, unexpectedNext), (error) => error === failure);
  assert.throws(() => withLogBrewExpressHandler(() => throwValue(undefined))(express.request, express.response, unexpectedNext), (error) => error === undefined);
});

/**
 * @param {unknown} value
 * @returns {() => Promise<unknown>}
 */
function rejectingHandler(value) {
  return async () => throwValue(value);
}

/**
 * @param {() => Promise<unknown>} handler
 * @returns {Promise<{ readonly errors: readonly unknown[], readonly result: unknown }>}
 */
async function forwardedErrors(handler) {
  /** @type {unknown[]} */
  const errors = [];
  const result = await withLogBrewExpressHandler(handler)(express.request, express.response, (error) => {
    errors.push(error);
  });
  return { errors, result };
}

void test("the wrapper forwards a promise rejection once without requiring middleware", async () => {
  const failure = new TypeError("handler failure");
  const rejected = await forwardedErrors(rejectingHandler(failure));
  assert.equal(rejected.result, undefined);
  assert.deepEqual(rejected.errors, [failure]);
  assert.equal(await withLogBrewExpressHandler(async () => ANSWER)(express.request, express.response, unexpectedNext), ANSWER);
  assert.equal(await withLogBrewExpressHandler(() => createThenable(ANSWER))(express.request, express.response, unexpectedNext), ANSWER);
  const falsy = await forwardedErrors(rejectingHandler(undefined));
  const [falsyError] = falsy.errors;
  assert.equal(falsy.errors.length, ONE);
  assert.ok(falsyError instanceof Error);
});

void test("the wrapper rejects invalid request handlers", () => {
  for (const handler of [undefined, {}, finalErrorHandler(() => undefined)]) {
    assert.throws(() => {
      Reflect.apply(withLogBrewExpressHandler, undefined, [handler]);
    }, (error) => readField(error, "code") === "configuration_error");
  }
});

/**
 * @param {Overlap} overlap
 * @returns {(req: Request, res: Response, next: NextFunction) => Promise<never>}
 */
function createFirstHandler(overlap) {
  return async (_req, _res, next) => {
    next();
    await overlap.first.wait();
    overlap.firstEnded.add();
    throw overlap.failure;
  };
}

/**
 * @param {Overlap} overlap
 * @param {(client: LogBrewClient) => void} record
 * @returns {(req: Request, res: Response) => Promise<void>}
 */
function createSecondHandler(overlap, record) {
  return async (req, res) => {
    const { client } = requestContext(req);
    record(client);
    res.end("ok");
    await overlap.second.wait();
    client.log("second-tail", TIMESTAMP, { level: "info", message: "handler completed" });
    overlap.secondEnded.add();
  };
}

/**
 * @returns {{ readonly app: Express, readonly overlap: Overlap }}
 */
function createOverlapRun() {
  /** @type {LogBrewClient[]} */
  const clients = [];
  /** @type {unknown[]} */
  const errors = [];
  const overlap = {
    clients,
    errors,
    failure: new TypeError("handler failure"),
    first: createLatch(),
    firstEnded: createCounter(),
    recorder: createRecorder(),
    second: createLatch(),
    secondEnded: createCounter()
  };
  const app = express();
  app.use(logbrewMiddleware({ serverApiKey: SERVER_API_KEY, transport: overlap.recorder.transport }));
  app.get("/overlap", withLogBrewExpressHandler(createFirstHandler(overlap)), withLogBrewExpressHandler(createSecondHandler(overlap, (client) => {
    clients.push(client);
  })));
  app.use(logbrewErrorHandler());
  app.use(finalErrorHandler((error) => {
    errors.push(error);
  }));
  return { app, overlap };
}

/**
 * @param {Overlap} overlap
 * @returns {Promise<LogBrewClient>}
 */
async function settleSecondHandler(overlap) {
  const [client] = overlap.clients;
  assert.ok(client !== undefined, "the second handler never ran");
  await waitFor(() => overlap.recorder.bodies.length === ONE && client.pendingEvents() === NONE, "the first batch was not delivered");
  overlap.second.open();
  await waitFor(() => overlap.secondEnded.value() === ONE && client.pendingEvents() === ONE, "the second handler did not finish");
  assert.equal(overlap.firstEnded.value(), NONE);
  assert.equal(client.deliveryHealth().lifecycle, "active");
  return client;
}

/**
 * @param {Overlap} overlap
 * @returns {void}
 */
function assertOverlapEvents(overlap) {
  const events = eventsOfBodies(overlap.recorder.bodies);
  const [span, ...rest] = events;
  const trace = readPath(span, ["attributes", "traceId"]);
  assert.deepEqual(overlap.errors, [overlap.failure]);
  assert.equal(overlap.recorder.bodies.length, TWO);
  assert.deepEqual(events.map((event) => eventType(event)), ["span", "log", "issue"]);
  assert.ok(rest.every((event) => traceField(event, "traceId") === trace));
}

void test("overlapping wrapped handlers keep the client until both settle", async (testContext) => {
  const { app, overlap } = createOverlapRun();
  testContext.after(() => {
    overlap.first.open();
    overlap.second.open();
  });
  const server = await serve(testContext, () => app.listen(ANY_PORT, HOST));
  const response = await fetch(`${server.origin}/overlap`);
  assert.equal(await response.text(), "ok");
  const client = await settleSecondHandler(overlap);
  overlap.first.open();
  await waitFor(() => client.deliveryHealth().lifecycle === "closed", "the client did not close");
  assertOverlapEvents(overlap);
});
