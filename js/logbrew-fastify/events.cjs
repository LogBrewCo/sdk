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
const { createLogBrewTraceContext, getActiveLogBrewTrace } = require("@logbrew/node");

/**
 * @import { FastifyReply, FastifyRequest } from "fastify"
 * @import { LogBrewTraceContext } from "@logbrew/node"
 * @import {
 *   LogBrewErrorEvent,
 *   LogBrewFastifyRequestLike,
 *   LogBrewRequestMetricEvent,
 *   LogBrewSpanRequestEvent
 * } from "./index.cjs"
 */

/**
 * @template Request, Reply
 * @typedef {{
 *   readonly spanIdFactory?: ((request: Request, reply: Reply) => string) | undefined,
 *   readonly traceIdFactory?: ((request: Request, reply: Reply) => string) | undefined
 * }} TraceIdFactories
 */

const DEFAULT_METRIC_NAME = "http.server.duration";
const NO_DURATION = 0;

/**
 * @template Request, Reply
 * @param {Request} request
 * @param {Reply} reply
 * @param {TraceIdFactories<Request, Reply>} factories
 * @returns {LogBrewTraceContext}
 */
function createRequestTraceContext(request, reply, factories) {
  const { spanIdFactory, traceIdFactory } = factories;
  return createLogBrewTraceContext(getTraceparentHeader(request), {
    ...(spanIdFactory === undefined ? {} : { spanIdFactory: () => spanIdFactory(request, reply) }),
    ...(traceIdFactory === undefined ? {} : { traceIdFactory: () => traceIdFactory(request, reply) })
  });
}

/**
 * @param {LogBrewFastifyRequestLike} request
 * @param {unknown} reply
 * @returns {string}
 */
function defaultRequestEventId(request, reply) {
  const key = `${getRequestMethod(request)}_${getRequestPath(request)}_${getStatusCodeText(reply)}`;
  return `evt_fastify_request_${slugify(key)}`;
}

/**
 * @param {LogBrewFastifyRequestLike} request
 * @param {unknown} reply
 * @returns {string}
 */
function defaultRequestMetricEventId(request, reply) {
  const key = `${getRequestMethod(request)}_${getRouteTemplate(request)}_${getStatusCodeText(reply)}`;
  return `evt_fastify_metric_${slugify(key)}`;
}

/**
 * @param {unknown} error
 * @param {LogBrewFastifyRequestLike} request
 * @returns {string}
 */
function defaultErrorEventId(error, request) {
  const message = error instanceof Error ? error.message : String(error);
  return `evt_fastify_error_${slugify(`${getRequestMethod(request)}_${getRequestPath(request)}_${message}`)}`;
}

/**
 * @param {unknown} value
 * @returns {value is LogBrewTraceContext}
 */
function isTraceContext(value) {
  return typeof readField(value, "traceId") === "string" && typeof readField(value, "spanId") === "string";
}

/**
 * @template {LogBrewFastifyRequestLike} Request
 * @param {Request} request
 * @returns {LogBrewTraceContext | undefined}
 */
function getRequestTraceContext(request) {
  const context = readField(request, "logbrew");
  const trace = readField(context, "trace");
  return isTraceContext(trace) ? trace : undefined;
}

/**
 * @template {LogBrewFastifyRequestLike} [Request=FastifyRequest]
 * @template [Reply=FastifyReply]
 * @param {Request} request
 * @param {Reply} reply
 * @param {TraceIdFactories<Request, Reply> & {
 *   readonly durationMs?: number | undefined,
 *   readonly idFactory?: ((request: Request, reply: Reply) => string) | undefined,
 *   readonly now?: (() => string) | undefined,
 *   readonly trace?: Readonly<LogBrewTraceContext> | undefined
 * }} [options]
 * @returns {LogBrewSpanRequestEvent}
 */
function createRequestEvent(request, reply, options = {}) {
  const {
    durationMs = NO_DURATION,
    idFactory = defaultRequestEventId,
    now = () => new Date().toISOString(),
    trace
  } = options;
  const id = idFactory(request, reply);
  return createTraceparentRequestSpan(
    trace ?? getRequestTraceContext(request) ?? createRequestTraceContext(request, reply, options),
    {
      durationMs,
      id,
      method: getRequestMethod(request),
      now,
      path: getRouteTemplate(request),
      statusCode: getStatusCode(reply)
    }
  );
}

/**
 * @template {LogBrewFastifyRequestLike} [Request=FastifyRequest]
 * @param {unknown} error
 * @param {Request} request
 * @param {{
 *   readonly idFactory?: ((error: unknown, request: Request) => string) | undefined,
 *   readonly now?: (() => string) | undefined,
 *   readonly trace?: Readonly<LogBrewTraceContext> | undefined
 * }} [options]
 * @returns {LogBrewErrorEvent}
 */
function createErrorEvent(error, request, options = {}) {
  const { idFactory = defaultErrorEventId, now = () => new Date().toISOString(), trace } = options;
  const method = getRequestMethod(request);
  const path = getRequestPath(request);
  return {
    id: idFactory(error, request),
    timestamp: now(),

    attributes: {
      title: `${method} ${path} failed`,

      level: "error",
      message: error instanceof Error ? error.message : String(error),
      metadata: {
        method,
        path,
        ...traceMetadata(trace ?? getRequestTraceContext(request) ?? getActiveLogBrewTrace())
      }
    }
  };
}

/**
 * @template {LogBrewFastifyRequestLike} [Request=FastifyRequest]
 * @template [Reply=FastifyReply]
 * @param {Request} request
 * @param {Reply} reply
 * @param {{
 *   readonly durationMs?: number | undefined,
 *   readonly idFactory?: ((request: Request, reply: Reply) => string) | undefined,
 *   readonly metricName?: string | undefined,
 *   readonly now?: (() => string) | undefined
 * }} [options]
 * @returns {LogBrewRequestMetricEvent}
 */
function createRequestMetricEvent(request, reply, options = {}) {
  const {
    durationMs = NO_DURATION,
    idFactory = defaultRequestMetricEventId,
    metricName = DEFAULT_METRIC_NAME,
    now = () => new Date().toISOString()
  } = options;
  const statusCode = getStatusCode(reply);
  return {
    id: idFactory(request, reply),
    timestamp: now(),

    attributes: {
      name: metricName,

      description: "Duration of one completed server request.",
      kind: "histogram",
      value: durationMs,

      unit: "ms",

      temporality: "delta",

      metadata: {
        framework: "fastify",
        method: getRequestMethod(request),
        routeTemplate: getRouteTemplate(request),
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
