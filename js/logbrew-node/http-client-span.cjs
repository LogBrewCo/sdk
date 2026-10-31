"use strict";

const { errorMonitor } = require("node:events");
const { createAutomaticEventId } = require("./automatic-event-id.cjs");
const { applyFunction, callMethod, isTruthy, readMember, readOptionalMember } = require("./internal.cjs");
const {
  createChildTraceContext,
  getActiveLogBrewTrace,
  runWithLogBrewTrace,
  traceparentFor
} = require("./active-trace.cjs");
const { createHttpClientInstrumentationContext, normalizeHttpClientArgs, withHttpClientTraceparent } = require("./http-client-options.cjs");
const {
  durationSince,
  emitSpan,
  errorType,
  fetchInstrumentationMetadata,
  nowMs,
  pathOnly,
  slugify,
  spanEvents
} = require("./span-support.cjs");
const { matchesFetchTarget, resolveRouteTemplate } = require("./target-matchers.cjs");

/**
 * @import { LogBrewTraceContext } from "./index.cjs"
 * @import { ClientSpanOptions } from "./span-support.cjs"
 * @import { HttpClientContext, NormalizedHttpClientArgs } from "./http-client-options.cjs"
 */

/**
 * @typedef {ClientSpanOptions & Readonly<{
 *   captureMatchers: readonly unknown[],
 *   defaultProtocol: string,
 *   endRequest: boolean,
 *   events?: unknown,
 *   framework?: unknown,
 *   id?: unknown,
 *   metadata?: unknown,
 *   moduleName: string,
 *   propagationMatchers: readonly unknown[],
 *   routeTemplate?: unknown,
 *   routeTemplateFactory?: unknown,
 *   spanIdFactory?: unknown,
 *   trace?: LogBrewTraceContext | undefined,
 *   traceIdFactory?: unknown
 * }>} HttpClientCallOptions
 * @typedef {Readonly<{ fallback: unknown, request: unknown, target: unknown }>} HttpClientCallTarget
 * @typedef {Readonly<{
 *   captureSpan: boolean,
 *   context: HttpClientContext,
 *   normalized: NormalizedHttpClientArgs,
 *   propagateTrace: boolean
 * }>} HttpClientMatch
 * @typedef {Readonly<{ id: unknown, path: string, requestOptions: Readonly<Record<string, unknown>>, trace: LogBrewTraceContext }>} HttpClientCallPlan
 * @typedef {Readonly<{ error?: unknown, response?: unknown }>} HttpClientOutcome
 * @typedef {(outcome?: HttpClientOutcome) => void} Finalize
 * @typedef {Readonly<{
 *   captureSpan: boolean,
 *   id: unknown,
 *   method: string,
 *   path: string,
 *   startedAt: number,
 *   trace: LogBrewTraceContext
 * }>} HttpClientSpanPlan
 */

const ERROR_STATUS = 400;
const NO_STATUS = 0;

/**
 * @returns {Error}
 */
function httpStatusError() {
  const error = new Error("HTTP status error");
  error.name = "HttpStatusError";
  return error;
}

/**
 * @param {HttpClientCallOptions} options
 * @param {HttpClientSpanPlan & Readonly<{ durationMs: number }>} plan
 * @param {HttpClientOutcome} outcome
 * @returns {Promise<void>}
 */
async function captureHttpClientSpan(options, plan, { error, response }) {
  const { method, path, trace } = plan;
  const statusCode = readOptionalMember(response, "statusCode");
  const statusError = error === undefined && Number(statusCode ?? NO_STATUS) >= ERROR_STATUS ? httpStatusError() : undefined;
  const spanError = error ?? statusError;
  const metadata = {
    ...fetchInstrumentationMetadata(options.metadata),
    framework: options.framework ?? "node:http",
    "http.request.method": method,
    "http.route": path,
    method,
    path,
    sampled: trace.sampled,
    "url.path": path,
    ...(statusCode === undefined ? {} : { "http.response.status_code": statusCode, statusCode }),
    ...(spanError === undefined ? {} : { errorType: errorType(spanError) })
  };
  const events = spanEvents(options.events, spanError);
  await emitSpan(
    options,
    { durationMs: plan.durationMs, events, id: plan.id, metadata, name: `${method} ${path}`, status: spanError === undefined ? "ok" : "error", trace },
    { client: options.client, error: spanError, response, trace }
  );
}

/**
 * @param {HttpClientCallOptions} options
 * @param {HttpClientSpanPlan} plan
 * @returns {Finalize}
 */
function createFinalizer(options, plan) {
  let finalized = false;
  return function finalize({ error, response } = {}) {
    if (finalized || !plan.captureSpan) {
      return;
    }
    finalized = true;
    void captureHttpClientSpan(options, { ...plan, durationMs: durationSince(options, plan.startedAt) }, { error, response });
  };
}

/**
 * @param {unknown} response
 * @param {Finalize} finalize
 * @returns {void}
 */
function observeResponse(response, finalize) {
  if (!isTruthy(response) || typeof readMember(response, "once") !== "function") {
    finalize({ response });
    return;
  }
  callMethod(response, "once", ["end", () => {
    finalize({ response });
  }]);
  callMethod(response, "once", ["close", () => {
    finalize({ response });
  }]);
  /**
   * @param {unknown} error
   * @returns {void}
   */
  function finalizeError(error) {
    finalize({ error, response });
  }
  callMethod(response, "once", [errorMonitor, finalizeError]);
}

/**
 * @param {unknown} callback
 * @param {LogBrewTraceContext} trace
 * @param {Finalize} finalize
 * @returns {((response: unknown) => unknown) | undefined}
 */
function wrapResponseCallback(callback, trace, finalize) {
  if (typeof callback !== "function") {
    return undefined;
  }
  /**
   * @param {unknown} response
   * @returns {unknown}
   */
  function logBrewHttpClientCallback(response) {
    observeResponse(response, finalize);
    return runWithLogBrewTrace(trace, () => applyFunction(callback, undefined, [response]));
  }
  return logBrewHttpClientCallback;
}

/**
 * @param {unknown} request
 * @param {Readonly<{ callback: unknown, endRequest: boolean, finalize: Finalize }>} watch
 * @returns {void}
 */
function watchRequest(request, { callback, endRequest, finalize }) {
  const observable = isTruthy(request) && typeof readMember(request, "once") === "function";
  /**
   * @param {unknown} response
   * @returns {void}
   */
  function observe(response) {
    observeResponse(response, finalize);
  }
  /**
   * @param {unknown} error
   * @returns {void}
   */
  function finalizeError(error) {
    finalize({ error });
  }
  if (callback === undefined && observable) {
    callMethod(request, "once", ["response", observe]);
  }
  if (observable) {
    callMethod(request, "once", [errorMonitor, finalizeError]);
  }
  if (endRequest && isTruthy(request) && typeof readMember(request, "end") === "function") {
    callMethod(request, "end", []);
  }
}

/**
 * @param {HttpClientCallTarget} target
 * @param {readonly unknown[]} args
 * @param {Readonly<{ finalize: Finalize, trace: LogBrewTraceContext }>} span
 * @returns {unknown}
 */
function startRequest(target, args, { finalize, trace }) {
  try {
    return runWithLogBrewTrace(trace, () => applyFunction(target.request, target.target, args));
  } catch (error) {
    finalize({ error });
    throw error;
  }
}

/**
 * @param {readonly unknown[]} args
 * @param {HttpClientCallOptions} options
 * @returns {HttpClientMatch | undefined}
 */
function matchHttpClientCall(args, options) {
  const normalized = normalizeHttpClientArgs(args, options.defaultProtocol);
  if (!normalized) {
    return undefined;
  }
  const context = createHttpClientInstrumentationContext(normalized.options, options.moduleName);
  const captureSpan = matchesFetchTarget(context, options.captureMatchers);
  const propagateTrace = matchesFetchTarget(context, options.propagationMatchers);
  return captureSpan || propagateTrace ? { captureSpan, context, normalized, propagateTrace } : undefined;
}

/**
 * @param {HttpClientMatch} match
 * @param {HttpClientCallOptions} options
 * @returns {HttpClientCallPlan}
 */
function planHttpClientCall({ context, normalized, propagateTrace }, options) {
  const trace = createChildTraceContext("installLogBrewHttpClientInstrumentation", options.trace ?? getActiveLogBrewTrace(), options);
  const requestOptions = propagateTrace ? withHttpClientTraceparent(normalized.options, traceparentFor(trace)) : normalized.options;
  const path = pathOnly(resolveRouteTemplate(options, context));
  const id = options.id ?? createAutomaticEventId("evt_node_http_client", slugify(`${context.method}_${path}`));
  return { id, path, requestOptions, trace };
}

/**
 * @param {HttpClientCallTarget} target
 * @param {readonly unknown[]} args
 * @param {HttpClientCallOptions} options
 * @returns {unknown}
 */
function callHttpClientRequest(target, args, options) {
  const match = matchHttpClientCall(args, options);
  if (match === undefined) {
    return applyFunction(target.fallback, target.target, args);
  }
  const { id, path, requestOptions, trace } = planHttpClientCall(match, options);
  const finalize = createFinalizer(options, { captureSpan: match.captureSpan, id, method: match.context.method, path, startedAt: nowMs(options), trace });
  const callback = wrapResponseCallback(match.normalized.callback, trace, finalize);
  const request = startRequest(target, [requestOptions, callback], { finalize, trace });
  watchRequest(request, { callback, endRequest: options.endRequest, finalize });
  return request;
}

module.exports = { callHttpClientRequest };
