"use strict";

const { createAutomaticEventId } = require("./automatic-event-id.cjs");
const { applyFunction, isTruthy, readMember, readOptionalMember, templateText } = require("./internal.cjs");
const {
  createLogBrewTraceContext,
  defaultSpanIdFactory,
  defaultTraceIdFactory,
  getActiveLogBrewTrace
} = require("./active-trace.cjs");
const { pathOnly, slugify } = require("./span-support.cjs");

/**
 * @import { LogBrewTraceContext } from "./index.cjs"
 */

/**
 * @typedef {Readonly<{
 *   durationMs?: unknown,
 *   idFactory?: unknown,
 *   now?: unknown,
 *   spanIdFactory?: unknown,
 *   trace?: LogBrewTraceContext | undefined,
 *   traceIdFactory?: unknown
 * }>} RequestEventOptions
 * @typedef {Readonly<{ idFactory?: unknown, now?: unknown, trace?: LogBrewTraceContext | undefined }>} ErrorEventOptions
 * @typedef {Readonly<{ spanIdFactory?: unknown, traceIdFactory?: unknown }>} RequestTraceOptions
 * @typedef {Readonly<{
 *   durationMs: unknown,
 *   id: unknown,
 *   method: unknown,
 *   now: unknown,
 *   path: string,
 *   responseCompleted: boolean,
 *   statusCode: number
 * }>} RequestSpanFields
 */

const NO_STATUS = 0;
const SERVER_ERROR_STATUS = 500;
const FIRST_VALUE = 0;
const NO_DURATION = 0;

/**
 * @returns {string}
 */
function currentTimestamp() {
  return new Date().toISOString();
}

/**
 * @param {unknown} factory
 * @param {string} name
 * @param {readonly unknown[]} args
 * @returns {unknown}
 */
function callHook(factory, name, args) {
  if (typeof factory !== "function") {
    throw new TypeError(`${name} is not a function`);
  }
  return applyFunction(factory, undefined, args);
}

/**
 * @param {unknown} trace
 * @returns {Readonly<Record<string, unknown>>}
 */
function traceFields(trace) {
  if (!isTruthy(trace)) {
    return {};
  }
  return {
    parentSpanId: readMember(trace, "parentSpanId"),
    sampled: readMember(trace, "sampled"),
    spanId: readMember(trace, "spanId"),
    traceId: readMember(trace, "traceId")
  };
}

/**
 * @param {unknown} req
 * @returns {string}
 */
function getRequestPath(req) {
  return pathOnly(readMember(req, "url") ?? "/");
}

/**
 * @param {unknown} req
 * @returns {unknown}
 */
function getRequestTraceContext(req) {
  return readOptionalMember(readMember(req, "logbrew"), "trace");
}

/**
 * @param {unknown} req
 * @returns {unknown}
 */
function getTraceparentHeader(req) {
  const value = readOptionalMember(readMember(req, "headers"), "traceparent");
  if (Array.isArray(value)) {
    /** @type {readonly unknown[]} */
    const values = value;
    return values[FIRST_VALUE];
  }
  return typeof value === "string" ? value : undefined;
}

/**
 * @param {unknown} req
 * @param {unknown} res
 * @param {RequestTraceOptions} [options]
 * @returns {LogBrewTraceContext}
 */
function createRequestTraceContext(req, res, {
  spanIdFactory = defaultSpanIdFactory,
  traceIdFactory = defaultTraceIdFactory
} = {}) {
  return createLogBrewTraceContext(getTraceparentHeader(req), {
    spanIdFactory: () => callHook(spanIdFactory, "spanIdFactory", [req, res]),
    traceIdFactory: () => callHook(traceIdFactory, "traceIdFactory", [req, res])
  });
}

/**
 * @param {unknown} req
 * @param {unknown} res
 * @returns {string}
 */
function defaultRequestEventId(req, res) {
  const method = templateText(readMember(req, "method") ?? "GET");
  const path = getRequestPath(req);
  const statusCode = templateText(readMember(res, "statusCode") ?? NO_STATUS);
  return createAutomaticEventId("evt_node_request", slugify(`${method}_${path}_${statusCode}`));
}

/**
 * @param {unknown} error
 * @param {unknown} req
 * @returns {string}
 */
function defaultErrorEventId(error, req) {
  const message = error instanceof Error ? error.message : String(error);
  const method = templateText(readMember(req, "method") ?? "GET");
  return createAutomaticEventId("evt_node_error", slugify(`${method}_${getRequestPath(req)}_${message}`));
}

/**
 * @param {unknown} traceContext
 * @param {RequestSpanFields} fields
 * @returns {Readonly<Record<string, unknown>>}
 */
function createTraceparentRequestSpan(traceContext, { durationMs, id, method, now, path, statusCode, responseCompleted }) {
  return {
    id,
    timestamp: callHook(now, "now", []),
    type: "span",

    attributes: {
      name: `${templateText(method)} ${path}`,

      traceId: readMember(traceContext, "traceId"),

      spanId: readMember(traceContext, "spanId"),

      parentSpanId: readMember(traceContext, "parentSpanId"),
      status: statusCode >= SERVER_ERROR_STATUS || !responseCompleted ? "error" : "ok",

      durationMs,
      metadata: {
        framework: "node:http",
        "http.request.method": method,
        "http.response.status_code": statusCode,
        method,
        path,
        sampled: readMember(traceContext, "sampled"),
        statusCode,
        "url.path": path,
        ...(responseCompleted ? {} : { responseCompleted: false })
      }
    }
  };
}

/**
 * @param {unknown} req
 * @param {unknown} res
 * @param {RequestEventOptions} [options]
 * @returns {Readonly<Record<string, unknown>>}
 */
function createHttpRequestEvent(req, res, {
  now = currentTimestamp,
  durationMs = NO_DURATION,
  idFactory = defaultRequestEventId,
  spanIdFactory = defaultSpanIdFactory,
  traceIdFactory = defaultTraceIdFactory,
  trace
} = {}) {
  const method = readMember(req, "method") ?? "GET";
  const path = getRequestPath(req);
  const statusCode = Number(readMember(res, "statusCode") ?? NO_STATUS);
  const id = callHook(idFactory, "idFactory", [req, res]);
  const traceContext = trace ?? getRequestTraceContext(req) ?? createRequestTraceContext(req, res, { spanIdFactory, traceIdFactory });
  const responseCompleted = readMember(req, "aborted") !== true &&
    !(readMember(res, "destroyed") === true && readMember(res, "writableFinished") === false);
  return createTraceparentRequestSpan(traceContext, { durationMs, id, method, now, path, responseCompleted, statusCode });
}

/**
 * @param {unknown} error
 * @param {unknown} req
 * @param {ErrorEventOptions} [options]
 * @returns {Readonly<Record<string, unknown>>}
 */
function createHttpErrorEvent(error, req, {
  now = currentTimestamp,
  idFactory = defaultErrorEventId,
  trace
} = {}) {
  const method = readMember(req, "method") ?? "GET";
  const path = getRequestPath(req);
  const message = error instanceof Error ? error.message : String(error);
  const traceContext = trace ?? getRequestTraceContext(req) ?? getActiveLogBrewTrace();
  return {
    id: callHook(idFactory, "idFactory", [error, req]),
    timestamp: callHook(now, "now", []),

    attributes: {
      title: `${templateText(method)} ${path} failed`,

      level: "error",
      message,
      metadata: {
        method,
        path,
        ...traceFields(traceContext)
      }
    }
  };
}

module.exports = {
  createHttpErrorEvent,
  createHttpRequestEvent,
  createRequestTraceContext,
  getRequestTraceContext
};
