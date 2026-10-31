import { SdkError, createTraceparent, parseTraceparent } from "@logbrew/sdk";

/**
 * @import { TraceparentFetchConfig, TraceparentFetchLike, TracePropagationTarget } from "./index.js"
 * @typedef {(length: number) => ArrayLike<number>} RandomValues
 * @typedef {{
 *   readonly randomValues?: RandomValues | undefined,
 *   readonly spanId?: string | undefined,
 *   readonly traceFlags?: string | undefined,
 *   readonly traceId?: string | undefined
 * }} TraceparentOptions
 * @typedef {(options: TraceparentOptions) => string} TraceparentCreator
 * @typedef {{
 *   readonly config: TraceparentFetchConfig,
 *   readonly createDefault: TraceparentCreator,
 *   readonly init: RequestInit | undefined,
 *   readonly input: RequestInfo | URL
 * }} TraceparentRequest
 */

const SPAN_ID_BYTES = 8;
const TRACE_ID_BYTES = 16;
const MAX_BYTE = 255;
const HEX_RADIX = 16;
const HEX_DIGITS = 2;
const SAMPLED_FLAGS = "01";
const FIRST_INDEX = 0;
const MIN_BYTE = 0;

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isFunction(value) {
  return typeof value === "function";
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isList(value) {
  return Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {PropertyKey} key
 * @returns {unknown}
 */
function readField(value, key) {
  return (typeof value === "object" && value !== null) || typeof value === "function" ? Reflect.get(value, key) : undefined;
}

/**
 * @param {unknown} value
 * @returns {value is Iterable<unknown>}
 */
function isIterable(value) {
  return typeof value !== "string" && isFunction(readField(value, Symbol.iterator));
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isByte(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_BYTE && value <= MAX_BYTE;
}

/**
 * @param {string} name
 * @returns {RandomValues}
 */
function defaultRandomValues(name) {
  return (length) => {
    const { crypto } = globalThis;
    if (!isFunction(readField(crypto, "getRandomValues"))) {
      throw new SdkError("configuration_error", `${name} requires crypto.getRandomValues or randomValues`);
    }
    return crypto.getRandomValues(new Uint8Array(length));
  };
}

/**
 * @param {number} length
 * @param {RandomValues} randomValues
 * @returns {string}
 */
function randomHex(length, randomValues) {
  if (!isFunction(randomValues)) {
    throw new SdkError("configuration_error", "randomValues must be a function");
  }
  const bytes = Array.from(randomValues(length), (value) => value);
  if (bytes.length !== length || !bytes.every((value) => isByte(value))) {
    throw new SdkError("configuration_error", "randomValues must return byte values for the requested length");
  }
  return bytes.map((value) => value.toString(HEX_RADIX).padStart(HEX_DIGITS, "0")).join("");
}

/**
 * @param {TraceparentOptions} options
 * @param {string} name
 * @returns {string}
 */
function createRandomTraceparent(options, name) {
  const { randomValues = defaultRandomValues(name), spanId, traceFlags = SAMPLED_FLAGS, traceId } = options;
  return createTraceparent({
    spanId: spanId ?? randomHex(SPAN_ID_BYTES, randomValues),
    traceFlags,
    traceId: traceId ?? randomHex(TRACE_ID_BYTES, randomValues)
  });
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
 * @param {unknown} input
 * @returns {string}
 */
function requestUrl(input) {
  if (typeof input === "string") {
    return input;
  }
  if (isFunction(globalThis.URL) && input instanceof URL) {
    return input.toString();
  }
  const url = readField(input, "url");
  return typeof url === "string" ? url : String(input);
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
 * @returns {readonly (readonly [unknown, unknown])[]}
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
 * @param {TraceparentRequest} request
 * @returns {string}
 */
function traceparentForRequest(request) {
  const { config, createDefault, init, input } = request;
  const { randomValues, traceFlags = SAMPLED_FLAGS, traceparent, traceparentFactory } = config;
  const url = requestUrl(input);
  const nextTraceparent = traceparentFactory === undefined
    ? traceparent ?? createDefault({ randomValues, traceFlags })
    : traceparentFactory({ init, input, url }) ?? "";
  parseTraceparent(nextTraceparent);
  return nextTraceparent;
}

/**
 * @param {TraceparentFetchLike | undefined} fetchImpl
 * @returns {TraceparentFetchLike}
 */
function requireFetch(fetchImpl) {
  if (fetchImpl === undefined || !isFunction(fetchImpl)) {
    throw new SdkError("configuration_error", "createTraceparentFetch requires fetch");
  }
  return fetchImpl;
}

/**
 * @param {TraceparentFetchConfig} config
 * @returns {void}
 */
function validateFetchConfig(config) {
  const { traceparentFactory, tracePropagationTargets } = config;
  if (tracePropagationTargets !== undefined && !isList(tracePropagationTargets)) {
    throw new SdkError("configuration_error", "tracePropagationTargets must be an array");
  }
  if (traceparentFactory !== undefined && !isFunction(traceparentFactory)) {
    throw new SdkError("configuration_error", "traceparentFactory must be a function");
  }
}

/**
 * @returns {TraceparentFetchLike | undefined}
 */
function defaultFetch() {
  return isFunction(globalThis.fetch) ? globalThis.fetch.bind(globalThis) : undefined;
}

/**
 * @param {TraceparentFetchConfig} config
 * @param {TraceparentCreator} createDefault
 * @returns {TraceparentFetchLike}
 */
function createTracedFetch(config, createDefault) {
  const { fetchImpl: configuredFetch = defaultFetch(), tracePropagationTargets = [] } = config;
  const fetchImpl = requireFetch(configuredFetch);
  validateFetchConfig(config);
  /**
   * @param {RequestInfo | URL} input
   * @param {RequestInit} [init]
   * @returns {Promise<unknown>}
   */
  async function tracedFetch(input, init) {
    if (!shouldPropagateTraceparent(requestUrl(input), tracePropagationTargets)) {
      return init === undefined ? fetchImpl(input) : fetchImpl(input, init);
    }
    const requestInit = init ?? {};
    const traceparent = traceparentForRequest({ config, createDefault, init, input });
    const { headers = readField(input, "headers") } = requestInit;
    return fetchImpl(input, { ...requestInit, headers: headersWithTraceparent(headers, traceparent) });
  }
  return tracedFetch;
}

export { createRandomTraceparent, createTracedFetch, shouldPropagateTraceparent };
