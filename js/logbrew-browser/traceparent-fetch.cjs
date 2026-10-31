"use strict";

const { SdkError, createTraceparent, parseTraceparent } = require("@logbrew/sdk");
const { createBrowserTraceparent, defaultRandomValues, traceContextProvider } = require("./trace-context.cjs");
const { defaultFetch, isFunction, isIterable, isList, readField } = require("./values.cjs");

/**
 * @import { BrowserTraceContext, TraceparentFetchConfig, TracePropagationTarget } from "./index.cjs"
 * @typedef {(length: number) => ArrayLike<number>} RandomValues
 * @typedef {readonly (readonly [unknown, unknown])[]} HeaderEntries
 * @typedef {{
 *   readonly init: RequestInit | undefined,
 *   readonly input: RequestInfo | URL,
 *   readonly randomValues: RandomValues,
 *   readonly traceContext: BrowserTraceContext | undefined,
 *   readonly traceFlags: string,
 *   readonly traceparent: string | undefined,
 *   readonly traceparentFactory: TraceparentFetchConfig["traceparentFactory"],
 *   readonly url: string
 * }} TraceparentRequest
 */

const FIRST_INDEX = 0;
const SAMPLED_FLAGS = "01";

/**
 * @param {BrowserTraceContext | undefined} traceContext
 * @returns {string | undefined}
 */
function traceparentFromBrowserTraceContext(traceContext) {
  return traceContext === undefined
    ? undefined
    : createTraceparent({
      spanId: traceContext.spanId,
      traceFlags: traceContext.traceFlags,
      traceId: traceContext.traceId
    });
}


/**
 * @param {TraceparentRequest} request
 * @returns {string}
 */
function traceparentForRequest(request) {
  const { init, input, randomValues, traceContext, traceFlags, traceparent, traceparentFactory, url } = request;
  const nextTraceparent = traceparentFactory !== undefined && isFunction(traceparentFactory)
    ? traceparentFactory({ init, input, url }) ?? ""
    : traceparent ?? traceparentFromBrowserTraceContext(traceContext) ?? createBrowserTraceparent({ randomValues, traceFlags });
  parseTraceparent(nextTraceparent);
  return nextTraceparent;
}


/**
 * @param {unknown} entry
 * @returns {readonly [unknown, unknown]}
 */
function headerPair(entry) {
  if (typeof entry !== "string" && !isIterable(entry)) {
    throw new TypeError("header entries must be iterable");
  }
  const [key, value] = entry;
  return [key, value];
}


/**
 * @param {unknown} headers
 * @returns {HeaderEntries}
 */
function headerEntries(headers) {
  if (headers === undefined || headers === null) {
    return [];
  }
  if (isFunction(globalThis.Headers) && headers instanceof Headers) {
    return [...headers.entries()];
  }
  if (isIterable(headers)) {
    return Array.from(headers, (entry) => headerPair(entry));
  }
  if (typeof headers === "string") {
    return Array.from(headers, (entry) => headerPair(entry));
  }
  return typeof headers === "object" ? Object.entries(headers) : [];
}


/**
 * @param {unknown} headers
 * @param {string} traceparent
 * @returns {Record<string, string>}
 */
function headersWithTraceparent(headers, traceparent) {
  /** @type {Record<string, string>} */
  const nextHeaders = {};
  for (const [key, value] of headerEntries(headers)) {
    const name = String(key);
    if (name.toLowerCase() !== "traceparent") {
      nextHeaders[name] = String(value);
    }
  }
  nextHeaders["traceparent"] = traceparent;
  return nextHeaders;
}


/**
 * @param {unknown} input
 * @param {RequestInit} init
 * @returns {unknown}
 */
function requestHeaders(input, init) {
  const headers = readField(init, "headers");
  return headers === undefined ? readField(input, "headers") : headers;
}


/**
 * @param {unknown} input
 * @returns {string}
 */
function requestUrl(input) {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  const url = readField(input, "url");
  return typeof url === "string" ? url : String(input);
}


/**
 * @param {string} pathname
 * @returns {string}
 */
function pathPrefix(pathname) {
  return pathname.endsWith("/") ? pathname : `${pathname}/`;
}


/**
 * @param {string} url
 * @returns {boolean}
 */
function hasUrlScheme(url) {
  return /^[a-z][a-z0-9+.-]*:/iu.test(url);
}


/**
 * @param {string} url
 * @param {string} targetText
 * @returns {boolean}
 */
function matchesUrlTarget(url, targetText) {
  try {
    const targetUrl = new URL(targetText);
    if (!hasUrlScheme(url)) {
      return false;
    }
    const requested = new URL(url, targetUrl.origin);
    if (requested.origin !== targetUrl.origin) {
      return false;
    }
    const targetPath = targetUrl.pathname || "/";
    return requested.pathname === targetPath || requested.pathname.startsWith(pathPrefix(targetPath));
  } catch {
    return url.startsWith(targetText);
  }
}


/**
 * @param {string} url
 * @param {string} target
 * @returns {boolean}
 */
function shouldPropagateToStringTarget(url, target) {
  const targetText = target.trim();
  if (targetText === "") {
    return false;
  }
  if (targetText.startsWith("/") || !isFunction(globalThis.URL)) {
    return url.startsWith(targetText);
  }
  return matchesUrlTarget(url, targetText);
}


/**
 * @param {string} url
 * @param {RegExp} target
 * @returns {boolean}
 */
function matchesRegExp(url, target) {
  target.lastIndex = FIRST_INDEX;
  const matched = target.test(url);
  target.lastIndex = FIRST_INDEX;
  return matched;
}


/**
 * @param {string} url
 * @param {TracePropagationTarget} target
 * @returns {boolean}
 */
function matchesTarget(url, target) {
  if (typeof target === "string") {
    return shouldPropagateToStringTarget(url, target);
  }
  if (target instanceof RegExp) {
    return matchesRegExp(url, target);
  }
  if (isFunction(target)) {
    /** @type {unknown} */
    const matched = target(url);
    return matched === true;
  }
  throw new SdkError("configuration_error", "tracePropagationTargets entries must be strings, RegExp values, or functions");
}


/**
 * @param {string} url
 * @param {readonly TracePropagationTarget[]} [tracePropagationTargets]
 * @returns {boolean}
 */
function shouldPropagateTraceparent(url, tracePropagationTargets = []) {
  if (!isList(tracePropagationTargets)) {
    throw new SdkError("configuration_error", "tracePropagationTargets must be an array");
  }
  return tracePropagationTargets.some((target) => matchesTarget(url, target));
}



/**
 * @param {TraceparentFetchConfig} config
 * @returns {typeof fetch}
 */
function validatedFetch(config) {
  if (config.fetchImpl === undefined || !isFunction(config.fetchImpl)) {
    throw new SdkError("configuration_error", "createTraceparentFetch requires fetch");
  }
  if (!isList(config.tracePropagationTargets)) {
    throw new SdkError("configuration_error", "tracePropagationTargets must be an array");
  }
  if (config.traceparentFactory !== undefined && !isFunction(config.traceparentFactory)) {
    throw new SdkError("configuration_error", "traceparentFactory must be a function");
  }
  return config.fetchImpl;
}


/**
 * @param {TraceparentFetchConfig} [config]
 * @returns {typeof fetch}
 */
function createTraceparentFetch({
  fetchImpl = defaultFetch(),
  randomValues = defaultRandomValues,
  traceContext,
  traceFlags = SAMPLED_FLAGS,
  traceparent,
  traceparentFactory,
  tracePropagationTargets = []
} = {}) {
  const send = validatedFetch({ fetchImpl, tracePropagationTargets, traceparentFactory });
  const fetchTraceContext = traceContextProvider(traceContext);

  return async function tracedFetch(input, init) {
    const url = requestUrl(input);
    if (!shouldPropagateTraceparent(url, tracePropagationTargets)) {
      return init === undefined ? send(input) : send(input, init);
    }
    const requestInit = init ?? {};
    const nextTraceparent = traceparentForRequest({
      init,
      input,
      randomValues,
      traceContext: fetchTraceContext(),
      traceFlags,
      traceparent,
      traceparentFactory,
      url
    });
    return send(input, { ...requestInit, headers: headersWithTraceparent(requestHeaders(input, requestInit), nextTraceparent) });
  };
}


module.exports = { createTraceparentFetch, headersWithTraceparent, requestHeaders, requestUrl, shouldPropagateTraceparent };
