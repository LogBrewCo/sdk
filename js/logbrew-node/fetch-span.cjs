"use strict";

const { SdkError } = require("@logbrew/sdk");
const { createAutomaticEventId } = require("./automatic-event-id.cjs");
const { applyFunction, callMethod, ownEnumerableProperties, readMember, readOptionalMember } = require("./internal.cjs");
const {
  createChildTraceContext,
  getActiveLogBrewTrace,
  runWithLogBrewTrace,
  traceparentFor
} = require("./active-trace.cjs");
const {
  durationSince,
  emitSpan,
  errorMessage,
  errorType,
  hasClient,
  isRecord,
  nowMs,
  pathOnly,
  primitiveMetadata,
  slugify,
  spanEvents
} = require("./span-support.cjs");

/**
 * @import { LogBrewTraceContext } from "./index.cjs"
 * @import { ClientSpanOptions, SpanOptions } from "./span-support.cjs"
 */

/**
 * @typedef {SpanOptions & Readonly<{
 *   events?: unknown,
 *   fetchImpl?: unknown,
 *   id?: unknown,
 *   includeErrorMessage?: unknown,
 *   metadata?: unknown,
 *   routeTemplate?: unknown,
 *   spanIdFactory?: unknown,
 *   timings?: unknown,
 *   trace?: LogBrewTraceContext | undefined,
 *   traceIdFactory?: unknown
 * }>} FetchSpanOptions
 * @typedef {Readonly<{
 *   durationMs: number,
 *   error?: unknown,
 *   id: unknown,
 *   method: string,
 *   path: string,
 *   response?: unknown,
 *   trace: LogBrewTraceContext
 * }>} FetchOutcome
 * @typedef {Readonly<{
 *   fetchInit: Readonly<Record<string, unknown>>,
 *   id: unknown,
 *   method: string,
 *   path: string,
 *   startedAt: number,
 *   trace: LogBrewTraceContext
 * }>} FetchPlan
 */

const ERROR_STATUS = 400;
const NO_STATUS = 0;
const NO_SIZE = 0;
const FIRST_ITEM = 0;
const TIMING_PRECISION = 1000;
const FETCH_TIMING_METADATA_KEYS = Object.freeze({
  connectMs: "http.phase.connect_ms",
  decodedBodySize: "http.response.decoded_size",
  encodedBodySize: "http.response.encoded_size",
  nameLookupMs: "http.phase.name_lookup_ms",
  redirectMs: "http.phase.redirect_ms",
  requestBodyBytes: "http.request_content_length",
  requestMs: "http.phase.request_ms",
  responseBodyBytes: "http.response_content_length",
  responseMs: "http.phase.response_ms",
  tlsMs: "http.phase.tls_ms",
  waitMs: "http.phase.wait_ms"
});

/**
 * @returns {unknown}
 */
function defaultFetch() {
  const globalFetch = readOptionalMember(globalThis, "fetch");
  if (typeof globalFetch !== "function") {
    return undefined;
  }
  return callMethod(globalFetch, "bind", [globalThis]);
}

/**
 * @param {unknown} input
 * @returns {input is Request}
 */
function isRequest(input) {
  return typeof globalThis.Request === "function" && input instanceof globalThis.Request;
}

/**
 * @param {unknown} input
 * @returns {unknown}
 */
function getFetchUrl(input) {
  if (isRequest(input)) {
    return input.url;
  }
  if (typeof globalThis.URL === "function" && input instanceof globalThis.URL) {
    return input.href;
  }
  return String(input);
}

/**
 * @param {unknown} input
 * @param {unknown} init
 * @returns {string}
 */
function getFetchMethod(input, init) {
  /** @type {unknown} */
  const method = readOptionalMember(init, "method") ?? (isRequest(input) ? input.method : "GET");
  return String(method).toUpperCase();
}

/**
 * @param {unknown} headers
 * @param {string} traceparent
 * @returns {unknown}
 */
function plainHeadersWithTraceparent(headers, traceparent) {
  if (Array.isArray(headers)) {
    /** @type {readonly unknown[]} */
    const entries = headers;
    return [
      ...entries.filter((entry) => String(readMember(entry, FIRST_ITEM)).toLowerCase() !== "traceparent"),
      ["traceparent", traceparent]
    ];
  }
  return {
    ...ownEnumerableProperties(headers),
    traceparent
  };
}

/**
 * @param {unknown} headers
 * @param {string} traceparent
 * @returns {unknown}
 */
function fetchHeadersWithTraceparent(headers, traceparent) {
  const HeadersConstructor = readOptionalMember(globalThis, "Headers");
  if (typeof HeadersConstructor === "function") {
    /** @type {unknown} */
    const nextHeaders = Reflect.construct(HeadersConstructor, [headers ?? undefined]);
    callMethod(nextHeaders, "set", ["traceparent", traceparent]);
    return nextHeaders;
  }
  return plainHeadersWithTraceparent(headers, traceparent);
}

/**
 * @param {unknown} input
 * @param {unknown} init
 * @param {string} traceparent
 * @returns {Record<string, unknown>}
 */
function withFetchTraceparent(input, init, traceparent) {
  return {
    ...ownEnumerableProperties(init),
    headers: fetchHeadersWithTraceparent(readOptionalMember(init, "headers") ?? (isRequest(input) ? input.headers : undefined), traceparent)
  };
}

/**
 * @param {unknown} timings
 * @param {Readonly<Record<string, unknown>>} context
 * @returns {unknown}
 */
function resolveFetchTimings(timings, context) {
  if (typeof timings === "function") {
    try {
      /** @type {unknown} */
      const resolved = Reflect.apply(timings, undefined, [context]);
      return resolved;
    } catch {
      return undefined;
    }
  }
  return timings;
}

/**
 * @param {unknown} timings
 * @param {Readonly<Record<string, unknown>>} context
 * @returns {Record<string, number>}
 */
function fetchTimingMetadata(timings, context) {
  const resolved = resolveFetchTimings(timings, context);
  if (!isRecord(resolved) || Array.isArray(resolved)) {
    return {};
  }
  /** @type {readonly (readonly [string, string])[]} */
  const keys = Object.entries(FETCH_TIMING_METADATA_KEYS);
  return Object.fromEntries(
    keys.flatMap(([sourceKey, metadataKey]) => {
      const value = resolved[sourceKey];
      return typeof value === "number" && Number.isFinite(value) && value >= NO_SIZE
        ? [[metadataKey, Math.round(value * TIMING_PRECISION) / TIMING_PRECISION]]
        : [];
    })
  );
}

/**
 * @param {FetchSpanOptions & ClientSpanOptions} options
 * @param {FetchOutcome} outcome
 * @returns {Promise<void>}
 */
async function captureFetchSpan(options, outcome) {
  const { durationMs, error, method, path, response, trace } = outcome;
  const statusCode = readOptionalMember(response, "status");
  const metadata = {
    ...primitiveMetadata(options.metadata),
    ...fetchTimingMetadata(options.timings, { durationMs, error, method, path, response, trace }),
    framework: "node:fetch",
    "http.request.method": method,
    "http.route": path,
    method,
    path,
    sampled: trace.sampled,
    "url.path": path,
    ...(statusCode === undefined ? {} : { "http.response.status_code": statusCode, statusCode }),
    ...(error === undefined ? {} : {
      ...(options.includeErrorMessage === false ? {} : { errorMessage: errorMessage(error) }),
      errorType: errorType(error)
    })
  };
  const events = spanEvents(options.events, error);
  const failed = error !== undefined || Number(statusCode ?? NO_STATUS) >= ERROR_STATUS;
  await emitSpan(
    options,
    { durationMs, events, id: outcome.id, metadata, name: `${method} ${path}`, status: failed ? "error" : "ok", trace },
    { client: options.client, error, response, trace }
  );
}

/**
 * @param {unknown} input
 * @param {unknown} init
 * @param {FetchSpanOptions & ClientSpanOptions} options
 * @returns {FetchPlan}
 */
function planFetch(input, init, options) {
  const method = getFetchMethod(input, init);
  const path = pathOnly(options.routeTemplate ?? getFetchUrl(input));
  const startedAt = nowMs(options);
  const trace = createChildTraceContext("fetchWithLogBrewSpan", options.trace ?? getActiveLogBrewTrace(), options);
  const fetchInit = withFetchTraceparent(input, init, traceparentFor(trace));
  const id = options.id ?? createAutomaticEventId("evt_node_fetch", slugify(`${method}_${path}`));
  return { fetchInit, id, method, path, startedAt, trace };
}

/**
 * @param {FetchSpanOptions} options
 * @returns {unknown}
 */
function resolveFetch(options) {
  const fetchImpl = options.fetchImpl ?? defaultFetch();
  if (typeof fetchImpl !== "function") {
    throw new SdkError("configuration_error", "fetchWithLogBrewSpan requires fetch");
  }
  return fetchImpl;
}

/**
 * @param {unknown} input
 * @param {unknown} [init]
 * @param {FetchSpanOptions} [options]
 * @returns {Promise<unknown>}
 */
async function fetchWithLogBrewSpan(input, init = {}, options = {}) {
  const fetchImpl = resolveFetch(options);
  if (!hasClient(options)) {
    throw new SdkError("configuration_error", "fetchWithLogBrewSpan requires client");
  }
  const { fetchInit, id, method, path, startedAt, trace } = planFetch(input, init, options);
  try {
    const response = await runWithLogBrewTrace(trace, () => applyFunction(fetchImpl, undefined, [input, fetchInit]));
    await captureFetchSpan(options, { durationMs: durationSince(options, startedAt), id, method, path, response, trace });
    return response;
  } catch (error) {
    await captureFetchSpan(options, { durationMs: durationSince(options, startedAt), error, id, method, path, trace });
    throw error;
  }
}

module.exports = {
  defaultFetch,
  fetchWithLogBrewSpan,
  getFetchMethod,
  getFetchUrl,
  plainHeadersWithTraceparent
};
