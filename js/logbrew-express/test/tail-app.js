import {
  createCounter,
  createLatch,
  disconnectAfterFirstChunk,
  eventType,
  eventsOf,
  finalErrorHandler,
  requestContext,
  traceparentFor,
  transportResponse
} from "./support.js";
import {
  createLogBrewExpressClient,
  getActiveLogBrewTrace,
  logbrewErrorHandler,
  logbrewMiddleware,
  withLogBrewExpressHandler
} from "@logbrew/express";
import assert from "node:assert/strict";
import commonjsAdapter from "./commonjs.cjs";
import express from "express";

/**
 * @import { Express, Request, Response } from "express"
 * @import { LogBrewExpressOptions } from "@logbrew/express"
 * @import { LogBrewClient, Transport, TransportResponse } from "@logbrew/sdk"
 * @import { Counter, Latch, Listening } from "./support.js"
 * @typedef {{
 *   readonly aborted?: boolean,
 *   readonly commonjs?: boolean,
 *   readonly concurrency?: number,
 *   readonly customClient?: boolean,
 *   readonly failTail?: boolean,
 *   readonly manual?: boolean,
 *   readonly reject?: boolean,
 *   readonly slowInitial?: boolean
 * }} Scenario
 * @typedef {{
 *   readonly createLogBrewExpressClient: typeof createLogBrewExpressClient,
 *   readonly getActiveLogBrewTrace: typeof getActiveLogBrewTrace,
 *   readonly logbrewErrorHandler: typeof logbrewErrorHandler,
 *   readonly logbrewMiddleware: typeof logbrewMiddleware,
 *   readonly withLogBrewExpressHandler: typeof withLogBrewExpressHandler
 * }} Adapter
 * @typedef {{ readonly bodies: readonly string[], readonly releaseInitial: () => void, readonly transport: Transport }} TailDelivery
 * @typedef {{
 *   readonly clients: readonly LogBrewClient[],
 *   readonly errors: readonly unknown[],
 *   readonly failures: readonly unknown[],
 *   readonly record: (req: Request) => void,
 *   readonly recordError: (error: unknown) => void,
 *   readonly recordFailure: (error: unknown) => void,
 *   readonly shutdowns: readonly (() => Promise<TransportResponse>)[]
 * }} TailRecords
 * @typedef {{ readonly factoryCalls: Counter, readonly flushes: Counter, readonly tails: Counter }} TailCounters
 * @typedef {{
 *   readonly api: Adapter,
 *   readonly count: number,
 *   readonly counters: TailCounters,
 *   readonly delivery: TailDelivery,
 *   readonly original: unknown,
 *   readonly records: TailRecords,
 *   readonly scenario: Scenario,
 *   readonly tail: Latch
 * }} TailView
 */

const TIMESTAMP = "2026-08-29T12:00:00Z";
const SPAN_ID = "2222222222222222";
const SERVER_API_KEY = "LOGBREW_SERVER_API_KEY";
const NOT_SAMPLED = "00";
const TAIL_PATH = "/tail/private-id?search=private-query";
const ACCEPTED = 202;
const BAD_REQUEST = 400;
const SCHEMA_VERSION = 1;
const ONE = 1;
const esmAdapter = Object.freeze({
  createLogBrewExpressClient,
  getActiveLogBrewTrace,
  logbrewErrorHandler,
  logbrewMiddleware,
  withLogBrewExpressHandler
});

/**
 * @param {string} body
 * @returns {boolean}
 */
function hasTailEvent(body) {
  return eventsOf(body).some((event) => {
    const type = eventType(event);
    return type === "issue" || type === "log";
  });
}

/**
 * @param {Scenario} scenario
 * @returns {TailDelivery}
 */
function createTailDelivery(scenario) {
  const initial = createLatch();
  /** @type {string[]} */
  const bodies = [];
  return {
    bodies,
    releaseInitial: initial.open,
    transport: {
      send: async (_key, body) => {
        bodies.push(body);
        const tail = hasTailEvent(body);
        if (scenario.slowInitial === true && !tail) {
          await initial.wait();
        }
        return transportResponse(scenario.failTail === true && tail ? BAD_REQUEST : ACCEPTED);
      }
    }
  };
}

/**
 * @param {Transport} transport
 * @returns {TailRecords}
 */
function createTailRecords(transport) {
  /** @type {LogBrewClient[]} */
  const clients = [];
  /** @type {unknown[]} */
  const errors = [];
  /** @type {unknown[]} */
  const failures = [];
  /** @type {(() => Promise<TransportResponse>)[]} */
  const shutdowns = [];
  return {
    clients,
    errors,
    failures,
    record: (req) => {
      const context = requestContext(req);
      clients.push(context.client);
      shutdowns.push(async () => context.shutdown());
      assert.equal(context.client, context.logbrew);
      assert.equal(context.transport, transport);
    },
    recordError: (error) => {
      errors.push(error);
    },
    recordFailure: (error) => {
      failures.push(error);
    },
    shutdowns
  };
}

/**
 * @param {TailView} view
 * @returns {LogBrewExpressOptions}
 */
function tailMiddlewareOptions(view) {
  const { api, counters, scenario } = view;
  const automatic = scenario.manual !== true;
  return {
    captureRequestMetrics: automatic,
    captureRequests: automatic,
    now: () => TIMESTAMP,
    onCaptureError: view.records.recordFailure,
    onFlush: counters.flushes.add,
    serverApiKey: SERVER_API_KEY,
    spanIdFactory: () => SPAN_ID,
    transport: view.delivery.transport,
    ...(scenario.customClient === true ? {
      client: () => {
        counters.factoryCalls.add();
        return api.createLogBrewExpressClient({
          context: { resource: { service: { name: "custom-request" } }, schemaVersion: SCHEMA_VERSION },
          sdkName: "custom-request",
          serverApiKey: SERVER_API_KEY
        });
      }
    } : {})
  };
}

/**
 * @param {Response} res
 * @param {boolean} aborted
 * @returns {void}
 */
function startTailResponse(res, aborted) {
  if (aborted) {
    res.write("first chunk");
    res.flushHeaders();
  } else {
    res.end("ok");
  }
}

/**
 * @param {TailView} view
 * @returns {(req: Request, res: Response) => Promise<string>}
 */
function createTailHandler(view) {
  const { counters, scenario } = view;
  return async (req, res) => {
    view.records.record(req);
    startTailResponse(res, scenario.aborted === true);
    await view.tail.wait();
    assert.equal(view.api.getActiveLogBrewTrace()?.spanId, SPAN_ID);
    counters.tails.add();
    if (scenario.reject !== false) {
      throw view.original;
    }
    requestContext(req).client.log(`tail-log-${String(counters.tails.value())}`, TIMESTAMP, { level: "info", message: "handler completed" });
    return "handler result";
  };
}

/**
 * @param {TailView} view
 * @returns {Express}
 */
function createTailApp(view) {
  const { api, scenario } = view;
  const app = express();
  app.use(api.logbrewMiddleware(tailMiddlewareOptions(view)));
  app.get("/tail/:id", api.withLogBrewExpressHandler(createTailHandler(view)));
  app.use(api.logbrewErrorHandler(scenario.manual === true ? { onCaptureError: view.records.recordFailure } : {}));
  app.use(finalErrorHandler(view.records.recordError));
  return app;
}

/**
 * @param {Scenario} scenario
 * @returns {TailView}
 */
function createTailView(scenario) {
  const delivery = createTailDelivery(scenario);
  return {
    api: scenario.commonjs === true ? commonjsAdapter : esmAdapter,
    count: scenario.concurrency ?? ONE,
    counters: { factoryCalls: createCounter(), flushes: createCounter(), tails: createCounter() },
    delivery,
    original: new TypeError("handler failed"),
    records: createTailRecords(delivery.transport),
    scenario,
    tail: createLatch()
  };
}

/**
 * @param {Listening} server
 * @param {number} index
 * @param {boolean} aborted
 * @returns {Promise<void>}
 */
async function sendTailRequest(server, index, aborted) {
  const traceparent = traceparentFor(index, NOT_SAMPLED);
  if (aborted) {
    await disconnectAfterFirstChunk(server.port, `GET ${TAIL_PATH} HTTP/1.1\r\nHost: localhost\r\nAuthorization: private-authorization\r\ntraceparent: ${traceparent}\r\n\r\n`);
    return;
  }
  const response = await fetch(`${server.origin}${TAIL_PATH}`, { headers: { authorization: "private-authorization", traceparent } });
  assert.equal(await response.text(), "ok");
}

export { SPAN_ID, createTailApp, createTailView, sendTailRequest };
