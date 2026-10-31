const { parseTraceparent, SdkError } = require("@logbrew/sdk");
const { defaultRandomValues } = require("./index-random.cjs");
const { createReactNativeTraceHeaders, createReactNativeTraceparent, getActiveLogBrewTrace, resolveTraceContext } = require("./index-trace.cjs");
const { defaultFetch } = require("./index-transport.cjs");
const { readField, textOf } = require("./index-values.cjs");

/**
 * @typedef {(input: unknown, init?: unknown) => unknown} TracedFetchLike
 * @typedef {(context: { readonly init: unknown, readonly input: unknown, readonly url: string }) => unknown} TraceparentFactory
 * @typedef {{
 *   readonly fetchImpl?: unknown,
 *   readonly randomValues?: unknown,
 *   readonly trace?: unknown,
 *   readonly traceFlags?: string | undefined,
 *   readonly traceparent?: unknown,
 *   readonly traceparentFactory?: unknown,
 *   readonly tracePropagationTargets?: unknown
 * }} TraceparentFetchConfig
 * @typedef {{
 *   readonly init: unknown,
 *   readonly input: unknown,
 *   readonly randomValues: unknown,
 *   readonly trace: unknown,
 *   readonly traceFlags: string,
 *   readonly traceparent: unknown,
 *   readonly traceparentFactory: unknown,
 *   readonly url: string
 * }} TraceparentRequest
 */

const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/iu;
const RESET_INDEX = 0;

/**
 * @param {unknown} value
 * @returns {value is TracedFetchLike}
 */
function isTracedFetch(value) {
  return typeof value === "function";
}

/**
 * @param {unknown} value
 * @returns {value is TraceparentFactory}
 */
function isTraceparentFactory(value) {
  return typeof value === "function";
}

/**
 * @param {unknown} value
 * @returns {value is (url: string) => unknown}
 */
function isTargetPredicate(value) {
  return typeof value === "function";
}

/**
 * @param {unknown} value
 * @returns {value is readonly unknown[]}
 */
function isUnknownList(value) {
  return Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is readonly Iterable<unknown>[]}
 */
function isEntryList(value) {
  return Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {PropertyKey}
 */
function propertyKey(value) {
  return typeof value === "symbol" ? value : textOf(value);
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
  return URL_SCHEME_RE.test(url);
}

/**
 * @param {string} url
 * @param {string} targetText
 * @returns {boolean}
 */
function matchesUrlTarget(url, targetText) {
  const URLConstructor = globalThis.URL;
  try {
    const targetUrl = new URLConstructor(targetText);
    if (!hasUrlScheme(url)) {
      return false;
    }
    const candidateUrl = new URLConstructor(url, targetUrl.origin);
    const targetPath = targetUrl.pathname || "/";
    return candidateUrl.origin === targetUrl.origin
      && (candidateUrl.pathname === targetPath || candidateUrl.pathname.startsWith(pathPrefix(targetPath)));
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
  if (targetText.startsWith("/")) {
    return url.startsWith(targetText);
  }
  if (typeof readField(globalThis, "URL") === "function") {
    return matchesUrlTarget(url, targetText);
  }
  return url.startsWith(targetText);
}

/**
 * @param {string} url
 * @param {unknown} target
 * @returns {boolean}
 */
function matchesPropagationTarget(url, target) {
  if (typeof target === "string") {
    return shouldPropagateToStringTarget(url, target);
  }
  if (target instanceof RegExp) {
    target.lastIndex = RESET_INDEX;
    const matched = target.test(url);
    target.lastIndex = RESET_INDEX;
    return matched;
  }
  if (isTargetPredicate(target)) {
    return target(url) === true;
  }
  throw new SdkError("configuration_error", "tracePropagationTargets entries must be strings, RegExp values, or functions");
}

/**
 * @param {string} url
 * @param {unknown} [tracePropagationTargets]
 * @returns {boolean}
 */
function shouldPropagateTraceparent(url, tracePropagationTargets = []) {
  if (!isUnknownList(tracePropagationTargets)) {
    throw new SdkError("configuration_error", "tracePropagationTargets must be an array");
  }
  return tracePropagationTargets.some(target => matchesPropagationTarget(url, target));
}

/**
 * @param {unknown} input
 * @param {unknown} init
 * @returns {unknown}
 */
function requestHeaders(input, init) {
  const initHeaders = readField(init, "headers");
  if (Boolean(init) && initHeaders !== undefined) {
    return initHeaders;
  }
  return readField(input, "headers");
}

/**
 * @param {unknown} input
 * @returns {string}
 */
function requestUrl(input) {
  if (typeof input === "string") {
    return input;
  }
  const URLConstructor = readField(globalThis, "URL");
  if (typeof URLConstructor === "function" && input instanceof URLConstructor) {
    return textOf(input);
  }
  const url = readField(input, "url");
  if (typeof url === "string") {
    return url;
  }
  return textOf(input);
}

/**
 * @param {unknown} value
 * @returns {value is Iterable<Iterable<unknown>>}
 */
function isIterable(value) {
  return typeof value !== "string" && typeof readField(value, Symbol.iterator) === "function";
}

/**
 * @param {Headers} headers
 * @returns {[string, string][]}
 */
function platformHeaderEntries(headers) {
  /** @type {[string, string][]} */
  const entries = [];
  for (const [key, value] of headers) {
    entries.push([key, value]);
  }
  return entries;
}

/**
 * @param {unknown} headers
 * @returns {readonly Iterable<unknown>[]}
 */
function headerEntries(headers) {
  if (headers === undefined || headers === null) {
    return [];
  }
  if (typeof readField(globalThis, "Headers") === "function" && headers instanceof globalThis.Headers) {
    return platformHeaderEntries(headers);
  }
  if (isEntryList(headers)) {
    return headers;
  }
  if (isIterable(headers)) {
    return [...headers];
  }
  return typeof headers === "object" ? Object.entries(headers) : [];
}

/**
 * @param {unknown} headers
 * @param {unknown} traceparent
 * @returns {Record<PropertyKey, unknown>}
 */
function headersWithTraceparent(headers, traceparent) {
  /** @type {Record<PropertyKey, unknown>} */
  const nextHeaders = {};
  for (const [key, value] of headerEntries(headers)) {
    if (textOf(key).toLowerCase() !== "traceparent") {
      nextHeaders[propertyKey(key)] = value;
    }
  }
  nextHeaders["traceparent"] = traceparent;
  return nextHeaders;
}

/**
 * @param {TraceparentRequest} request
 * @returns {unknown}
 */
function traceparentForRequest({
  init, input, randomValues, trace, traceFlags, traceparent, traceparentFactory, url
}) {
  const context = resolveTraceContext(trace) ?? getActiveLogBrewTrace();
  const nextTraceparent = isTraceparentFactory(traceparentFactory)
    ? traceparentFactory({ init, input, url })
    : traceparent ?? (context ? createReactNativeTraceHeaders(context).traceparent : createReactNativeTraceparent({ randomValues, traceFlags }));
  parseTraceparent(typeof nextTraceparent === "string" ? nextTraceparent : "");
  return nextTraceparent;
}

/**
 * @param {TraceparentFetchConfig} [config]
 * @returns {(input: unknown, init?: Readonly<Record<string, unknown>>) => Promise<unknown>}
 */
function createTraceparentFetch({
  fetchImpl = defaultFetch(),
  randomValues = defaultRandomValues,
  trace,
  traceFlags = "01",
  traceparent,
  traceparentFactory,
  tracePropagationTargets = []
} = {}) {
  if (!isTracedFetch(fetchImpl)) {
    throw new SdkError("configuration_error", "createTraceparentFetch requires fetch");
  }
  if (!Array.isArray(tracePropagationTargets)) {
    throw new SdkError("configuration_error", "tracePropagationTargets must be an array");
  }
  if (traceparentFactory !== undefined && typeof traceparentFactory !== "function") {
    throw new SdkError("configuration_error", "traceparentFactory must be a function");
  }
  const fetchTarget = fetchImpl;

  /**
   * @param {unknown} input
   * @param {Readonly<Record<string, unknown>>} [init]
   * @returns {Promise<unknown>}
   */
  async function tracedFetch(input, init) {
    const url = requestUrl(input);
    if (!shouldPropagateTraceparent(url, tracePropagationTargets)) {
      return init === undefined ? fetchTarget(input) : fetchTarget(input, init);
    }

    const requestInit = init ?? {};
    const nextTraceparent = traceparentForRequest({ init, input, randomValues, trace, traceFlags, traceparent, traceparentFactory, url });
    const nextInit = {
      ...requestInit,
      headers: headersWithTraceparent(requestHeaders(input, requestInit), nextTraceparent)
    };
    return fetchTarget(input, nextInit);
  }
  return tracedFetch;
}

module.exports = { createTraceparentFetch, shouldPropagateTraceparent };
