"use strict";

const {
  getRequestMethod,
  getRouteTemplate,
  getStatusCode,
  getStatusCodeText,
  getTraceparentHeader,
  incompleteResponseMetadata,
  randomHex,
  readField,
  responseCompleted,
  slugify,
  spanStatus,
  statusCodeClass
} = require("./internal.cjs");
const { createLogBrewTraceContext, getActiveLogBrewTrace } = require("@logbrew/node");
const { createIssueAttributesFromError } = require("@logbrew/sdk");

/**
 * @import { Request, Response } from "express"
 * @import { LogBrewTraceContext } from "@logbrew/node"
 * @import { LogBrewClient } from "@logbrew/sdk"
 * @import {
 *   LogBrewErrorEvent,
 *   LogBrewExpressRequestLike,
 *   LogBrewRequestMetricEvent,
 *   LogBrewSpanRequestEvent
 * } from "./index.cjs"
 */

/**
 * @template RequestType, ResponseType
 * @typedef {{
 *   readonly spanIdFactory?: ((req: RequestType, res: ResponseType) => string) | undefined,
 *   readonly traceIdFactory?: ((req: RequestType, res: ResponseType) => string) | undefined
 * }} TraceIdFactories
 */

const DEFAULT_METRIC_NAME = "http.server.duration";
const NO_DURATION = 0;
const EVENT_ID_BYTES = 8;

/**
 * @template RequestType, ResponseType
 * @param {RequestType} req
 * @param {ResponseType} res
 * @param {TraceIdFactories<RequestType, ResponseType>} [factories]
 * @returns {LogBrewTraceContext}
 */
function createRequestTraceContext(req, res, factories = {}) {
  const { spanIdFactory, traceIdFactory } = factories;
  return createLogBrewTraceContext(getTraceparentHeader(req), {
    ...(spanIdFactory === undefined ? {} : { spanIdFactory: () => spanIdFactory(req, res) }),
    ...(traceIdFactory === undefined ? {} : { traceIdFactory: () => traceIdFactory(req, res) })
  });
}

/**
 * @param {unknown} value
 * @returns {value is LogBrewTraceContext}
 */
function isTraceContext(value) {
  return typeof readField(value, "traceId") === "string" && typeof readField(value, "spanId") === "string";
}

/**
 * @param {unknown} req
 * @returns {LogBrewTraceContext | undefined}
 */
function getRequestTraceContext(req) {
  const trace = readField(readField(req, "logbrew"), "trace");
  return isTraceContext(trace) ? trace : undefined;
}

/**
 * @param {unknown} req
 * @param {unknown} res
 * @returns {string}
 */
function defaultRequestEventId(req, res) {
  const key = `${getRequestMethod(req)}_${getRouteTemplate(req)}_${getStatusCodeText(res)}`;
  return `evt_express_request_${slugify(key)}_${randomHex(EVENT_ID_BYTES)}`;
}

/**
 * @param {unknown} _error
 * @param {unknown} req
 * @returns {string}
 */
function defaultErrorEventId(_error, req) {
  return `evt_express_error_${slugify(`${getRequestMethod(req)}_${getRouteTemplate(req)}`)}_${randomHex(EVENT_ID_BYTES)}`;
}

/**
 * @param {unknown} req
 * @param {unknown} res
 * @returns {string}
 */
function defaultRequestMetricEventId(req, res) {
  const key = `${getRequestMethod(req)}_${getRouteTemplate(req)}_${getStatusCodeText(res)}`;
  return `evt_express_metric_${slugify(key)}_${randomHex(EVENT_ID_BYTES)}`;
}

/**
 * @template {LogBrewExpressRequestLike} [RequestType=Request]
 * @template [ResponseType=Response]
 * @param {RequestType} req
 * @param {ResponseType} res
 * @param {TraceIdFactories<RequestType, ResponseType> & {
 *   readonly durationMs?: number | undefined,
 *   readonly idFactory?: ((req: RequestType, res: ResponseType) => string) | undefined,
 *   readonly now?: (() => string) | undefined,
 *   readonly trace?: Readonly<LogBrewTraceContext> | undefined
 * }} [options]
 * @returns {LogBrewSpanRequestEvent}
 */
function createRequestEvent(req, res, options = {}) {
  const {
    durationMs = NO_DURATION,
    idFactory = defaultRequestEventId,
    now = () => new Date().toISOString(),
    trace
  } = options;
  const method = getRequestMethod(req);
  const routeTemplate = getRouteTemplate(req);
  const statusCode = getStatusCode(res);
  const id = idFactory(req, res);
  const traceContext = trace ?? getRequestTraceContext(req) ?? createRequestTraceContext(req, res, options);
  const completed = responseCompleted(req, res);
  return {
    id,
    timestamp: now(),
    type: "span",

    attributes: {
      name: `${method} ${routeTemplate}`,
      traceId: traceContext.traceId,

      spanId: traceContext.spanId,

      ...(traceContext.parentSpanId === undefined ? {} : { parentSpanId: traceContext.parentSpanId }),
      status: spanStatus(statusCode, completed),

      durationMs,
      metadata: {
        framework: "express",
        method,
        routeTemplate,
        sampled: traceContext.sampled,
        statusCode,
        ...(completed ? {} : { responseCompleted: false })
      }
    }
  };
}

/**
 * @template {LogBrewExpressRequestLike} [RequestType=Request]
 * @param {unknown} error
 * @param {RequestType} req
 * @param {{
 *   readonly idFactory?: ((error: unknown, req: RequestType) => string) | undefined,
 *   readonly includeErrorStack?: boolean | undefined,
 *   readonly now?: (() => string) | undefined,
 *   readonly trace?: Readonly<LogBrewTraceContext> | undefined
 * }} [options]
 * @returns {LogBrewErrorEvent}
 */
function createErrorEvent(error, req, options = {}) {
  const {
    idFactory = defaultErrorEventId,
    includeErrorStack = false,
    now = () => new Date().toISOString(),
    trace
  } = options;
  const method = getRequestMethod(req);
  const routeTemplate = getRouteTemplate(req);
  const traceContext = trace ?? getRequestTraceContext(req) ?? getActiveLogBrewTrace();
  return {
    id: idFactory(error, req),
    timestamp: now(),

    attributes: createIssueAttributesFromError(error, {
      title: `${method} ${routeTemplate} failed`,

      mechanism: "express.middleware",

      handled: false,
      source: "express.middleware",
      ...(traceContext === undefined ? {} : { trace: traceContext }),

      includeErrorStack,
      metadata: {
        framework: "express",
        method,
        routeTemplate
      }
    })
  };
}

/**
 * @template {LogBrewExpressRequestLike} [RequestType=Request]
 * @template [ResponseType=Response]
 * @param {RequestType} req
 * @param {ResponseType} res
 * @param {{
 *   readonly durationMs?: number | undefined,
 *   readonly idFactory?: ((req: RequestType, res: ResponseType) => string) | undefined,
 *   readonly metricName?: string | undefined,
 *   readonly now?: (() => string) | undefined
 * }} [options]
 * @returns {LogBrewRequestMetricEvent}
 */
function createRequestMetricEvent(req, res, options = {}) {
  const {
    durationMs = NO_DURATION,
    idFactory = defaultRequestMetricEventId,
    metricName = DEFAULT_METRIC_NAME,
    now = () => new Date().toISOString()
  } = options;
  const method = getRequestMethod(req);
  const routeTemplate = getRouteTemplate(req);
  const statusCode = getStatusCode(res);
  return {
    id: idFactory(req, res),
    timestamp: now(),

    attributes: {
      name: metricName,

      description: "Duration of one completed server request.",
      kind: "histogram",
      value: Math.max(NO_DURATION, durationMs),

      unit: "ms",

      temporality: "delta",

      metadata: {
        framework: "express",
        method,
        routeTemplate,
        statusCode,
        statusCodeClass: statusCodeClass(statusCode),
        ...incompleteResponseMetadata(req, res)
      }
    }
  };
}

/**
 * @param {LogBrewClient} client
 * @param {unknown} req
 * @returns {void}
 */
function addErrorBreadcrumb(client, req) {
  const method = getRequestMethod(req);
  const routeTemplate = getRouteTemplate(req);
  client.addBreadcrumb({
    type: "http",

    category: "express.request",
    level: "error",
    message: `${method} ${routeTemplate}`,

    data: { method, routeTemplate }
  });
}

module.exports = {
  addErrorBreadcrumb,
  createErrorEvent,
  createRequestEvent,
  createRequestMetricEvent,
  createRequestTraceContext,
  getRequestTraceContext
};
