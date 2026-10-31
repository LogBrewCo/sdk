"use strict";

const { SdkError } = require("@logbrew/sdk");
const { createAutomaticEventId } = require("./automatic-event-id.cjs");
const { callMethod, isTruthy, readMember, readOptionalMember, stringValue } = require("./internal.cjs");
const {
  createChildTraceContext,
  getActiveLogBrewTrace,
  runWithLogBrewTrace,
  traceparentFor
} = require("./active-trace.cjs");
const { plainHeadersWithTraceparent } = require("./fetch-span.cjs");
const {
  durationSince,
  emitSpan,
  errorType,
  fetchInstrumentationMetadata,
  hasClient,
  isRecord,
  nowMs,
  pathOnly,
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
 *   id?: unknown,
 *   metadata?: unknown,
 *   routeTemplate?: unknown,
 *   routeTemplateFactory?: unknown,
 *   spanIdFactory?: unknown,
 *   trace?: LogBrewTraceContext | undefined,
 *   traceIdFactory?: unknown
 * }>} AxiosSpanOptions
 * @typedef {Readonly<Record<string, unknown>>} AxiosConfig
 * @typedef {Readonly<{
 *   id: unknown,
 *   method: string,
 *   path: string,
 *   startedAt: number,
 *   trace: LogBrewTraceContext,
 *   tracedConfig: AxiosConfig
 * }>} AxiosPlan
 * @typedef {Readonly<{
 *   durationMs: number,
 *   error?: unknown,
 *   id: unknown,
 *   method: string,
 *   path: string,
 *   response?: unknown,
 *   trace: LogBrewTraceContext
 * }>} AxiosOutcome
 */

const ERROR_STATUS = 400;
const NO_STATUS = 0;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/iu;

/**
 * @param {unknown} config
 * @returns {AxiosConfig}
 */
function normalizeAxiosRequestConfig(config) {
  if (!isRecord(config) || Array.isArray(config)) {
    throw new SdkError("configuration_error", "axiosRequestWithLogBrewSpan requires an Axios request config");
  }
  return { ...config };
}

/**
 * @param {AxiosConfig} config
 * @returns {string}
 */
function getAxiosMethod(config) {
  return stringValue(config["method"] ?? "GET").toUpperCase();
}

/**
 * @param {AxiosConfig} config
 * @returns {string}
 */
function getAxiosUrl(config) {
  const { baseURL, url } = config;
  const rawUrl = url === undefined || url === null ? "/" : stringValue(url);
  if (typeof baseURL === "string" && baseURL.trim() !== "" && !URL_SCHEME.test(rawUrl)) {
    try {
      return new URL(rawUrl, baseURL).toString();
    } catch {
      return rawUrl;
    }
  }
  return rawUrl;
}

/**
 * @param {unknown} headers
 * @param {string} traceparent
 * @returns {unknown}
 */
function cloneSettableHeaders(headers, traceparent) {
  try {
    const HeaderOwner = readMember(headers, "constructor");
    if (typeof HeaderOwner === "function") {
      /** @type {unknown} */
      const nextHeaders = Reflect.construct(HeaderOwner, [headers]);
      if (isTruthy(nextHeaders) && typeof readMember(nextHeaders, "set") === "function") {
        callMethod(nextHeaders, "set", ["traceparent", traceparent]);
        return nextHeaders;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {AxiosConfig} config
 * @param {string} traceparent
 * @returns {AxiosConfig}
 */
function withAxiosTraceparent(config, traceparent) {
  const { headers } = config;
  const settable = !Array.isArray(headers) && isTruthy(headers) && typeof readMember(headers, "set") === "function"
    ? cloneSettableHeaders(headers, traceparent)
    : undefined;
  return {
    ...config,
    headers: settable ?? plainHeadersWithTraceparent(headers, traceparent)
  };
}

/**
 * @param {AxiosSpanOptions & ClientSpanOptions} options
 * @param {AxiosOutcome} outcome
 * @returns {Promise<void>}
 */
async function captureAxiosSpan(options, outcome) {
  const { durationMs, error, method, path, response, trace } = outcome;
  const statusCode = readOptionalMember(response, "status");
  const metadata = {
    ...fetchInstrumentationMetadata(options.metadata),
    framework: "node:axios",
    "http.request.method": method,
    "http.route": path,
    method,
    path,
    sampled: trace.sampled,
    "url.path": path,
    ...(statusCode === undefined ? {} : { "http.response.status_code": statusCode, statusCode }),
    ...(error === undefined ? {} : { errorType: errorType(error) })
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
 * @param {Readonly<{ method: string, path: string }>} request
 * @returns {string}
 */
function defaultAxiosSpanId({ method, path }) {
  return createAutomaticEventId("evt_node_axios", slugify(`${method}_${path}`));
}

/**
 * @param {unknown} axiosInstance
 * @param {unknown} config
 * @param {AxiosSpanOptions} options
 * @returns {Readonly<{ requestConfig: AxiosConfig, spanOptions: AxiosSpanOptions & ClientSpanOptions }>}
 */
function checkAxiosRequest(axiosInstance, config, options) {
  if (!isTruthy(axiosInstance) || typeof readMember(axiosInstance, "request") !== "function") {
    throw new SdkError("configuration_error", "axiosRequestWithLogBrewSpan requires an Axios instance");
  }
  const requestConfig = normalizeAxiosRequestConfig(config);
  const spanOptions = { ...options, captureSpan: true, propagateTrace: true };
  if (!hasClient(spanOptions)) {
    throw new SdkError("configuration_error", "axiosRequestWithLogBrewSpan requires client");
  }
  return { requestConfig, spanOptions };
}

/**
 * @param {AxiosConfig} requestConfig
 * @param {AxiosSpanOptions & ClientSpanOptions} spanOptions
 * @returns {AxiosPlan}
 */
function planAxiosRequest(requestConfig, spanOptions) {
  const method = getAxiosMethod(requestConfig);
  const path = pathOnly(spanOptions.routeTemplate ?? pathOnly(getAxiosUrl(requestConfig)));
  const startedAt = nowMs(spanOptions);
  const trace = createChildTraceContext("axiosRequestWithLogBrewSpan", spanOptions.trace ?? getActiveLogBrewTrace(), spanOptions);
  const tracedConfig = withAxiosTraceparent(requestConfig, traceparentFor(trace));
  const id = spanOptions.id ?? defaultAxiosSpanId({ method, path });
  return { id, method, path, startedAt, trace, tracedConfig };
}

/**
 * @param {unknown} axiosInstance
 * @param {unknown} [config]
 * @param {AxiosSpanOptions} [options]
 * @returns {Promise<unknown>}
 */
async function axiosRequestWithLogBrewSpan(axiosInstance, config = {}, options = {}) {
  const { requestConfig, spanOptions } = checkAxiosRequest(axiosInstance, config, options);
  const { id, method, path, startedAt, trace, tracedConfig } = planAxiosRequest(requestConfig, spanOptions);
  try {
    const response = await runWithLogBrewTrace(trace, () => callMethod(axiosInstance, "request", [tracedConfig]));
    await captureAxiosSpan(spanOptions, { durationMs: durationSince(spanOptions, startedAt), id, method, path, response, trace });
    return response;
  } catch (error) {
    await captureAxiosSpan(spanOptions, {
      durationMs: durationSince(spanOptions, startedAt),
      error,
      id,
      method,
      path,
      response: readOptionalMember(error, "response"),
      trace
    });
    throw error;
  }
}

module.exports = {
  axiosRequestWithLogBrewSpan,
  captureAxiosSpan,
  defaultAxiosSpanId,
  getAxiosMethod,
  getAxiosUrl,
  normalizeAxiosRequestConfig,
  withAxiosTraceparent
};
