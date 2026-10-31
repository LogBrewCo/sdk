"use strict";

const {
  createTraceparentRequestSpan,
  getRequestMethod,
  getRequestPath,
  getRouteTemplate,
  getStatusCode,
  getStatusCodeText,
  getTraceparentHeader,
  readField,
  slugify,
  statusCodeClass,
  traceMetadata
} = require("./internal.cjs");
const { createLogBrewTraceContext } = require("@logbrew/node");

/**
 * @import { Request, Response } from "express"
 * @import { LogBrewTraceContext } from "@logbrew/node"
 * @import {
 *   LogBrewErrorEvent,
 *   LogBrewNestRequestLike,
 *   LogBrewRequestMetricEvent,
 *   LogBrewRequestSpanEvent
 * } from "./index.cjs"
 */

/**
 * @template RequestType, ResponseType
 * @typedef {{
 *   readonly spanIdFactory?: ((request: RequestType, response: ResponseType) => string) | undefined,
 *   readonly traceIdFactory?: ((request: RequestType, response: ResponseType) => string) | undefined
 * }} TraceIdFactories
 */

const DEFAULT_METRIC_NAME = "http.server.duration";
const NO_DURATION = 0;

/**
 * @template RequestType, ResponseType
 * @param {RequestType} request
 * @param {ResponseType} response
 * @param {TraceIdFactories<RequestType, ResponseType>} [factories]
 * @returns {LogBrewTraceContext}
 */
function createRequestTraceContext(request, response, factories = {}) {
  const { spanIdFactory, traceIdFactory } = factories;
  return createLogBrewTraceContext(getTraceparentHeader(request), {
    ...(spanIdFactory === undefined ? {} : { spanIdFactory: () => spanIdFactory(request, response) }),
    ...(traceIdFactory === undefined ? {} : { traceIdFactory: () => traceIdFactory(request, response) })
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
 * @param {unknown} request
 * @returns {LogBrewTraceContext | undefined}
 */
function getRequestTraceContext(request) {
  const trace = readField(readField(request, "logbrew"), "trace");
  return isTraceContext(trace) ? trace : undefined;
}

/**
 * @param {LogBrewNestRequestLike} request
 * @param {unknown} response
 * @returns {string}
 */
function defaultRequestEventId(request, response) {
  const key = `${getRequestMethod(request)}_${getRequestPath(request)}_${getStatusCodeText(response)}`;
  return `evt_nestjs_request_${slugify(key)}`;
}

/**
 * @param {unknown} error
 * @param {LogBrewNestRequestLike} request
 * @returns {string}
 */
function defaultErrorEventId(error, request) {
  const message = error instanceof Error ? error.message : String(error);
  return `evt_nestjs_error_${slugify(`${getRequestMethod(request)}_${getRequestPath(request)}_${message}`)}`;
}

/**
 * @param {LogBrewNestRequestLike} request
 * @param {unknown} response
 * @returns {string}
 */
function defaultRequestMetricEventId(request, response) {
  const key = `${getRequestMethod(request)}_${getRouteTemplate(request)}_${getStatusCodeText(response)}`;
  return `evt_nestjs_metric_${slugify(key)}`;
}

/**
 * @template {LogBrewNestRequestLike} [RequestType=Request]
 * @template [ResponseType=Response]
 * @param {RequestType} request
 * @param {ResponseType} response
 * @param {TraceIdFactories<RequestType, ResponseType> & {
 *   readonly durationMs?: number | undefined,
 *   readonly idFactory?: ((request: RequestType, response: ResponseType) => string) | undefined,
 *   readonly now?: (() => string) | undefined,
 *   readonly trace?: Readonly<LogBrewTraceContext> | undefined
 * }} [options]
 * @returns {LogBrewRequestSpanEvent}
 */
function createRequestEvent(request, response, options = {}) {
  const {
    durationMs = NO_DURATION,
    idFactory = defaultRequestEventId,
    now = () => new Date().toISOString(),
    trace
  } = options;
  const method = getRequestMethod(request);
  const path = getRouteTemplate(request);
  const statusCode = getStatusCode(response);
  const id = idFactory(request, response);
  return createTraceparentRequestSpan(
    trace ?? getRequestTraceContext(request) ?? createRequestTraceContext(request, response, options),
    { durationMs, id, method, now, path, statusCode }
  );
}

/**
 * @template {LogBrewNestRequestLike} [RequestType=Request]
 * @param {unknown} error
 * @param {RequestType} request
 * @param {{
 *   readonly idFactory?: ((error: unknown, request: RequestType) => string) | undefined,
 *   readonly now?: (() => string) | undefined,
 *   readonly trace?: Readonly<LogBrewTraceContext> | undefined
 * }} [options]
 * @returns {LogBrewErrorEvent}
 */
function createErrorEvent(error, request, options = {}) {
  const { idFactory = defaultErrorEventId, now = () => new Date().toISOString(), trace } = options;
  const method = getRequestMethod(request);
  const path = getRequestPath(request);
  const message = error instanceof Error ? error.message : String(error);
  const requestTrace = trace ?? getRequestTraceContext(request);
  return {
    id: idFactory(error, request),
    timestamp: now(),

    attributes: {
      title: `${method} ${path} failed`,

      level: "error",
      message,
      metadata: {
        method,
        path,
        ...traceMetadata(requestTrace)
      }
    }
  };
}

/**
 * @template {LogBrewNestRequestLike} [RequestType=Request]
 * @template [ResponseType=Response]
 * @param {RequestType} request
 * @param {ResponseType} response
 * @param {{
 *   readonly durationMs?: number | undefined,
 *   readonly idFactory?: ((request: RequestType, response: ResponseType) => string) | undefined,
 *   readonly metricName?: string | undefined,
 *   readonly now?: (() => string) | undefined
 * }} [options]
 * @returns {LogBrewRequestMetricEvent}
 */
function createRequestMetricEvent(request, response, options = {}) {
  const {
    durationMs = NO_DURATION,
    idFactory = defaultRequestMetricEventId,
    metricName = DEFAULT_METRIC_NAME,
    now = () => new Date().toISOString()
  } = options;
  const method = getRequestMethod(request);
  const routeTemplate = getRouteTemplate(request);
  const statusCode = getStatusCode(response);
  return {
    id: idFactory(request, response),
    timestamp: now(),

    attributes: {
      name: metricName,

      description: "Duration of one completed server request.",
      kind: "histogram",
      value: Math.max(NO_DURATION, durationMs),

      unit: "ms",

      temporality: "delta",

      metadata: {
        framework: "nestjs",
        method,
        routeTemplate,
        statusCode,
        statusCodeClass: statusCodeClass(statusCode)
      }
    }
  };
}

module.exports = {
  createErrorEvent,
  createRequestEvent,
  createRequestMetricEvent,
  createRequestTraceContext,
  getRequestTraceContext
};
